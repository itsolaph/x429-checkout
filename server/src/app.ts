// HTTP routes: the busy API, x402 /join and /skip, /use with a redeem token, quotes, earnings, the legacy
// gasless EIP-712 join/claim, the feed, MCP and the dashboard.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import type { Address } from "viem";
import { CheckoutError, parseAddress, parseUint, type Checkout, type Log, type SkipResult } from "./checkout.ts";
import type { Feed } from "./feed.ts";
import type { Admission, Gate, ServeNow } from "./gate.ts";
import { demoForecast, type ForecastService } from "./forecast.ts";
import { toJson } from "./json.ts";
import { handleMcp, pluginManifest } from "./mcp.ts";
import type { Payouts } from "./payouts.ts";
import { fmtUsd } from "./protocol.ts";
import {
  V1_RESPONSE_HEADER,
  V2_REQUIRED_HEADER,
  V2_RESPONSE_HEADER,
  encodeHeader,
  readPayment,
  settlementResponse,
  v1PaymentRequired,
  v2PaymentRequired,
} from "./x402.ts";

export const BUSY_PATH = "/v1/forecast";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type, x-payment, payment-signature, x-429-token, x-429-ticket, x-429-signature, mcp-protocol-version",
  "access-control-expose-headers": "payment-required, payment-response, x-payment-response, retry-after, link, server-timing, x-429-queue, x-429-position, x-429-skip-cost, x-429-skip-url, x-429-idempotent-replay",
};

/** The caller's address for rate limits. Behind a proxy, set the proxy to overwrite X-Forwarded-For. */
export function clientIp(req: IncomingMessage): string {
  const fwd = req.headers["x-forwarded-for"];
  const first = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(",")[0]?.trim();
  return first || req.socket.remoteAddress || "unknown";
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...CORS, ...headers });
  res.end(toJson(body, 2));
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 64 * 1024) throw new CheckoutError(413, "body_too_large", "request body over 64 KiB");
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new CheckoutError(400, "invalid_json", "request body is not JSON");
  }
}

export type AppDeps = { checkout: Checkout; gate: Gate; feed: Feed; log: Log; payouts?: Payouts; forecasts?: ForecastService; siteDir?: string };

export function createApp({ checkout, gate, feed, log, payouts, forecasts: fc, siteDir }: AppDeps): Server {
  const cfg = checkout.cfg;
  const forecasts = fc ?? { get: (city: unknown) => demoForecast(typeof city === "string" && city ? city : "Lisbon") };

  /** Parses a JSON object body (or none). */
  async function objectBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    const body = req.method === "POST" ? await readBody(req) : undefined;
    if (body === undefined || body === null) return {};
    if (typeof body !== "object" || Array.isArray(body)) throw new CheckoutError(400, "invalid_request", "the body must be a JSON object");
    return body as Record<string, unknown>;
  }

  /** The ETA for a position, from the latest snapshot. */
  function eta(position: number): number {
    return gate.etaSeconds(position, checkout.reader.latest);
  }

  const NEXT_USE = "Keep the token: it is the only proof that this ticket is yours. Call /use (PayBox plugin: x429_use) with it; it answers with your position and ETA while you wait, and with the API result once you are served.";

  /** The busy API's answer for an admitted ticket. */
  function apiResult(city: unknown, a: Admission) {
    return {
      ...forecasts.get(city),
      admitted: { via: "queue", ticketId: a.ticketId, waitedSeconds: a.waited, timesPassed: a.timesPassed, earned: a.earned, paid: a.paid, servedTx: a.servedTx },
    };
  }

  function who(owner: Address): { who: string; demo: boolean } {
    const demo = cfg.demoAgents.has(owner.toLowerCase());
    return { who: `${owner.slice(0, 6)}…${owner.slice(-4)}${demo ? " (demo agent)" : ""}`, demo };
  }

  /** The receipt of a paid skip: who got what, what came back, what it bought. */
  function receiptOf(s: SkipResult, served: ServeNow | undefined) {
    const waitSavedSeconds = Math.round((s.passes * cfg.serviceIntervalMs) / 1000);
    return {
      newPosition: s.position,
      fromPosition: s.fromPosition,
      passed: s.passed.map((p) => ({ ticketId: p.ticketId, owner: p.owner, ...who(p.owner), amount: p.amount, amountUsd: fmtUsd(p.amount) })),
      agentsPaid: s.passed.length,
      paidToWaiting: s.compensation,
      paidToWaitingUsd: fmtUsd(s.compensation),
      operatorFee: s.fee,
      operatorFeeUsd: fmtUsd(s.fee),
      refund: s.refund,
      refundUsd: fmtUsd(s.refund),
      charged: s.cost,
      chargedUsd: fmtUsd(s.cost),
      waitSavedSeconds,
      settlement: { status: "confirmed", txHash: s.txHash, explorerUrl: s.explorerUrl, network: `eip155:${cfg.chainId}` },
      payouts: cfg.autoPayout ? `pushed automatically to the ${s.passed.length} wallet(s) passed` : "claimable by the agents passed",
      served:
        served?.status === "served"
          ? { status: "served", serveTx: served.serveTx, serveConfirmed: served.serveConfirmed }
          : { status: "queued", reason: served?.reason ?? "not_at_head", etaSeconds: served?.etaSeconds ?? eta(s.position) },
      headline: `Skipped ~${waitSavedSeconds}s; ${s.passed.length} agent${s.passed.length === 1 ? "" : "s"} earned ${fmtUsd(s.compensation)}.`,
    };
  }

  type Cached = { status: number; body: unknown; headers: Record<string, string>; expires: number; client?: string };
  /**
   * Successful paid responses by payment (kind, payer, EIP-3009 nonce): a retry from the same client
   * gets the same bytes. Memory only. The key is public once the settlement is mined (the
   * authorization is calldata), so a retry from another client gets the receipt without the redeem
   * token or the API result. Kept in X429_DATA_DIR (mode 600, next to the token store) so a retry
   * after a restart still gets its token instead of a redacted receipt.
   */
  const responses = new Map<string, Cached>();
  const inflight = new Map<string, Promise<Cached | undefined>>();
  const responsesFile = cfg.dataDir ? join(cfg.dataDir, `responses-${cfg.contract.toLowerCase()}.json`) : undefined;
  if (responsesFile) {
    try {
      const saved = JSON.parse(readFileSync(responsesFile, "utf8")) as { version: 1; responses: [string, Cached][] };
      const now = Date.now();
      if (saved?.version === 1) for (const [k, v] of saved.responses) if (v.expires >= now) responses.set(k, v);
      log({ evt: "responses_loaded", responses: responses.size });
    } catch {
      // first start
    }
  }
  function saveResponses() {
    if (!responsesFile) return;
    try {
      mkdirSync(cfg.dataDir!, { recursive: true, mode: 0o700 });
      const tmp = `${responsesFile}.tmp`;
      writeFileSync(tmp, toJson({ version: 1, responses: [...responses] }), { mode: 0o600 });
      renameSync(tmp, responsesFile);
    } catch (err) {
      log({ evt: "responses_save_error", error: String((err as Error)?.message ?? err) });
    }
  }
  function sweepResponses() {
    const now = Date.now();
    for (const [k, v] of responses) if (v.expires < now) responses.delete(k);
    while (responses.size > 10_000) responses.delete(responses.keys().next().value!);
  }

  /**
   * While someone holds an unpaid skip quote, the operator's own demo agents do not join: each join
   * lands behind the quote's last ticket and raises the price of the skip they are approving (by up
   * to the agent's skip price, more than the slippage buffer), which would fail it with price_moved.
   * Real agents are never held. The hold lasts as long as the payment the quote asks for is valid.
   */
  let demoHoldUntil = 0;
  let lastQuoteAt = 0;
  const demoHoldMs = (cfg.paymentTimeoutS + 30) * 1000;

  /**
   * The two paid x402 resources. `POST /join` (body {skipPrice?}) creates a waiting ticket for the
   * payer; `POST /skip` (body or query {target, skipPrice?, owner?, city?}) moves the payer's ticket (or
   * a new one) to `target`. Without a payment header both answer 402 with v1 `accepts` in the body and
   * the v2 PAYMENT-REQUIRED header; with one they settle onchain and return a redeem token. A skip that
   * reaches #1 while the service slot is free is served in the same request: the paid response carries
   * the API result and a receipt. A retried paid request returns the identical response.
   */
  async function paid(kind: "join" | "skip", req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const t0 = performance.now();
    const tArrived = Date.now();
    const body = await objectBody(req);
    const qs = url.searchParams;
    const rawPrice = qs.get("skipPrice") ?? body.skipPrice;
    const skipPrice = checkout.skipPriceFrom(rawPrice);
    let target = 0;
    let ownerHint: Address | undefined;
    if (kind === "skip") {
      target = Number(qs.get("target") ?? body.target ?? 1);
      if (!Number.isInteger(target) || target < 1) throw new CheckoutError(400, "invalid_request", "target must be an integer >= 1");
      const queue = qs.get("queue") ?? body.queue;
      if (queue !== null && queue !== undefined && Number(queue) !== cfg.queueId) throw new CheckoutError(404, "unknown_queue", `this server runs queue ${cfg.queueId}`);
      const rawOwner = qs.get("owner") ?? body.owner;
      ownerHint = rawOwner ? parseAddress(rawOwner, "owner") : undefined;
    }
    const city = qs.get("city") ?? body.city;
    // body requests (the PayBox plugin) are priced on the plain path; query requests keep their URL
    const resource = kind === "skip" && qs.get("target") === null ? `${cfg.publicUrl}/skip` : undefined;
    const offer = (who: Address | undefined) =>
      kind === "join" ? checkout.joinOffer(skipPrice) : checkout.skipOffer(target, who, rawPrice ? skipPrice : undefined, 0, resource);

    /** Answers with fresh payment requirements: for `owner` if possible, else for a newcomer. */
    const paymentRequired = async (status: number, error: string, extra: Record<string, unknown> = {}, owner = ownerHint, failure?: Record<string, unknown>) => {
      const headers: Record<string, string> = {};
      if (failure) {
        headers[V1_RESPONSE_HEADER] = encodeHeader(failure);
        headers[V2_RESPONSE_HEADER] = encodeHeader(failure);
      }
      let o;
      let offerError: CheckoutError | undefined;
      for (const who of owner ? [owner, undefined] : [undefined]) {
        try {
          o = await offer(who);
          break;
        } catch (err) {
          if (!(err instanceof CheckoutError)) throw err;
          offerError = err;
        }
      }
      if (!o) {
        // nothing can be offered (e.g. the queue is empty or full): keep the failure, explain why
        const reason = status === 402 && !failure ? offerError!.reason : error;
        return send(res, status === 402 && !failure ? offerError!.status : status, { x402Version: 1, error: reason, accepts: [], message: offerError!.message, ...extra }, headers);
      }
      if (kind === "skip" && status === 402 && cfg.demoAgents.size > 0) {
        demoHoldUntil = Math.max(demoHoldUntil, Date.now() + demoHoldMs);
        lastQuoteAt = Date.now();
      }
      headers[V2_REQUIRED_HEADER] = encodeHeader(v2PaymentRequired(o.requirements, error));
      send(res, status, { ...v1PaymentRequired(o.requirements, error), ...extra, quote: checkout.quoteJson(o.quote) }, headers);
    };

    const payment = readPayment(req.headers);
    if (!payment) return paymentRequired(402, "X-PAYMENT (v1) or PAYMENT-SIGNATURE (v2) header is required");
    if ("error" in payment) return paymentRequired(400, payment.error, { message: payment.message });
    const payer = payment.payload.authorization.from;
    const nonce = payment.payload.authorization.nonce;
    if (kind === "join" && Date.now() < demoHoldUntil && cfg.demoAgents.has(payer.toLowerCase())) {
      const retryAfter = Math.max(1, Math.ceil((demoHoldUntil - Date.now()) / 1000));
      return send(res, 503, { error: "quote_hold", message: `a skip quote is waiting for approval; demo agents join again in ${retryAfter}s. Nothing was charged.`, retryAfterSeconds: retryAfter }, { "retry-after": String(retryAfter) });
    }

    // idempotency on the EIP-3009 nonce: the same payment gets the same response, and is never charged twice
    sweepResponses();
    const key = `${kind}:${payer.toLowerCase()}:${nonce.toLowerCase()}`;
    const client = clientIp(req);
    const hit = responses.get(key) ?? (await inflight.get(key));
    if (hit) {
      const same = hit.client === client;
      log({ evt: "paid_request_retried", kind, payer, nonce, sameClient: same });
      return send(res, hit.status, same ? hit.body : redacted(hit.body), { ...hit.headers, "x-429-idempotent-replay": "true" });
    }

    const run = async (): Promise<Cached> => {
      let tSettled = 0;
      let served: ServeNow | undefined;
      const r =
        kind === "join"
          ? await checkout.settleJoin(payment, skipPrice)
          : await checkout.settleSkip(payment, target, skipPrice, async (s) => {
              tSettled = performance.now();
              if (s.position === 1) served = await gate.serveNow(s.ticketId, (a) => apiResult(city, a), cfg.serveConfirm, { owner: s.owner, paid: s.cost });
            });
      const tDone = performance.now();
      const txHash = r.replayed ? (checkout.tokens.paymentTx(payer, nonce) ?? "") : r.txHash;
      const settlement = settlementResponse({ success: true, transaction: txHash, chainId: cfg.chainId, version: payment.version, payer });
      const timing = tSettled
        ? `settle;dur=${(tSettled - t0).toFixed(0)}, serve;dur=${(tDone - tSettled).toFixed(0)}, total;dur=${(tDone - t0).toFixed(0)}`
        : `total;dur=${(tDone - t0).toFixed(0)}`;
      const headers = { [payment.version === 2 ? V2_RESPONSE_HEADER : V1_RESPONSE_HEADER]: encodeHeader(settlement), "server-timing": timing };
      const expires = Math.max(Date.now() + 600_000, Number(payment.payload.authorization.validBefore) * 1000 + 600_000);
      log({ evt: "paid_latency", kind, ms: Math.round(tDone - t0), settleMs: tSettled ? Math.round(tSettled - t0) : undefined, served: served?.status, ...(served?.status === "busy" ? { busyReason: served.reason } : {}) });
      if (r.replayed) {
        return {
          status: 200,
          headers,
          expires,
          body: {
            ok: true,
            kind,
            ...r,
            txHash,
            etaSeconds: r.position ? eta(r.position) : null,
            message: `This payment was already settled for ticket #${r.ticketId}; nothing was charged again. Its redeem token and answer went out in the first response to it.`,
            next: "Use the token from the first paid response (x429_use). Do not pay again for the same request.",
          },
        };
      }
      if (r.refundedInFull) {
        return { status: 200, headers, expires, body: { ok: true, kind, ...r, message: "The payment arrived through a front-run transaction but the request was no longer possible; it was refunded in full." } };
      }
      if (kind === "join" && "fee" in r && !("passes" in r)) {
        return {
          status: 200,
          headers,
          expires,
          body: {
            ok: true,
            kind,
            ...r,
            feeUsd: fmtUsd(r.fee),
            etaSeconds: eta(r.position),
            message: `You joined at #${r.position} with a skip price of ${fmtUsd(r.skipPrice)}: anyone who passes you pays you that, automatically. Join fee ${fmtUsd(r.fee)}, refunded ${fmtUsd(r.refund)}.`,
            next: NEXT_USE,
          },
        };
      }
      const s = r as SkipResult;
      const receipt = receiptOf(s, served);
      const done = served as ServeNow | undefined;
      const isServed = done?.status === "served";
      return {
        status: 200,
        headers,
        expires,
        body: {
          ok: true,
          kind,
          status: isServed ? "served" : "queued",
          result: done?.status === "served" ? done.result : null,
          receipt,
          ...s,
          costUsd: fmtUsd(s.cost),
          etaSeconds: isServed ? 0 : eta(s.position),
          message: isServed
            ? `Served. ${receipt.headline} Charged ${fmtUsd(s.cost)}, refunded ${fmtUsd(s.refund)}.`
            : `You are now #${s.position}. ${receipt.headline} Charged ${fmtUsd(s.cost)}, refunded ${fmtUsd(s.refund)}.`,
          next: isServed ? "Done: `result` is the API answer and `receipt` the proof of what was paid to whom." : NEXT_USE,
        },
      };
    };

    const p = run();
    inflight.set(key, p.catch(() => undefined));
    try {
      const c = { ...(await p), client };
      responses.set(key, c);
      saveResponses();
      // the quote this payment answers is settled: lift the hold unless someone was quoted since it arrived
      if (kind === "skip" && lastQuoteAt < tArrived) demoHoldUntil = 0;
      send(res, c.status, c.body, c.headers);
    } catch (err) {
      if (!(err instanceof CheckoutError)) throw err;
      log({ evt: `${kind}_rejected`, reason: err.reason, message: err.message, payer });
      const failure = settlementResponse({ success: false, transaction: "", chainId: cfg.chainId, version: payment.version, payer, errorReason: err.reason });
      if (err.status === 402) {
        return paymentRequired(402, err.reason, { message: err.message, ...err.details }, payer, failure);
      }
      send(res, err.status, { error: err.reason, message: err.message, ...err.details }, {
        [V1_RESPONSE_HEADER]: encodeHeader(failure),
        [V2_RESPONSE_HEADER]: encodeHeader(failure),
      });
    } finally {
      inflight.delete(key);
    }
  }

  /** A cached paid response without what only its payer may see (token, API result). */
  function redacted(body: unknown): unknown {
    if (!body || typeof body !== "object") return body;
    const { token: _t, result: _r, ...rest } = body as Record<string, unknown>;
    void _t;
    void _r;
    return {
      ...rest,
      replayed: true,
      message: "This payment was already settled and answered; nothing was charged again. The redeem token and the API result went out in the first response.",
      next: "Use the token from the first paid response (x429_use). Do not pay again for the same request.",
    };
  }

  /** Resolves a redeem token from a request body, or answers 403. */
  function tokenEntry(body: Record<string, unknown>) {
    const entry = checkout.tokens.lookup(body.token);
    if (!entry) {
      throw new CheckoutError(403, "invalid_token", "unknown or malformed redeem token (it comes in the paid response of /join or /skip)");
    }
    return entry;
  }

  /** `POST /use {token, city?}`: the busy API for a ticket holder. 200 with the result once served. */
  async function use(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await objectBody(req);
    const entry = tokenEntry(body);
    const st = await gate.use(entry.ticketId, (a) => apiResult(body.city, a));
    const common = { ticketId: entry.ticketId, owner: entry.owner };
    if (st.status === "used") {
      return send(res, 200, { status: "served", ...common, replayed: st.replayed, expiresInSeconds: st.expiresInSeconds, result: st.result });
    }
    if (st.status === "waiting" || st.status === "serving") {
      const position = st.status === "waiting" ? st.position : 0;
      const front = position > 1 ? await checkout.quote(1, entry.owner).catch(() => undefined) : undefined;
      const offer = gate.offer(checkout.reader.latest, { ticketId: entry.ticketId, owner: entry.owner, position, status: st.status });
      return send(res, 429, {
        skip: offer.skip,
        status: st.status,
        ...common,
        position,
        etaSeconds: st.etaSeconds,
        message: st.status === "serving" ? "You are being served right now; call again in a second." : `You are #${position} in line, about ${st.etaSeconds} s to go.`,
        skipToFront: front ? { cost: front.cost, costUsd: fmtUsd(front.cost), maxAmountRequired: front.maxAmountRequired, passes: front.passes } : null,
      }, { "retry-after": String(st.etaSeconds) });
    }
    if (st.status === "unknown") throw new CheckoutError(404, "unknown_ticket", "this token's ticket is not in this queue");
    send(res, 410, {
      status: st.status,
      ...common,
      message: st.status === "left" ? "This ticket left the queue." : "This ticket was served but its request was not used within the admission window. Join again.",
    });
  }

  /** `POST /ticket {token}`: where your ticket stands, without using it. */
  async function ticket(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const entry = tokenEntry(await objectBody(req));
    const st = await gate.inspect(entry.ticketId);
    const row = checkout.reader.latest?.tickets.find((t) => t.id === entry.ticketId);
    const { admission, ...rest } = st as typeof st & { admission?: unknown };
    void admission;
    send(res, 200, {
      ...rest,
      owner: entry.owner,
      ticket: row ? { position: row.position, skipPrice: row.skipPrice, timesPassed: row.timesPassed, earned: row.earned, paid: row.paid } : null,
      claimable: await checkout.claimable(entry.owner),
    });
  }

  /** `GET /quote?target=&owner=` or `POST /quote {target?, owner?, token?}`. */
  async function quote(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const body = await objectBody(req);
    const rawTarget = url.searchParams.get("target") ?? body.target;
    const rawOwner = url.searchParams.get("owner") ?? body.owner;
    let owner = rawOwner ? parseAddress(rawOwner, "owner") : undefined;
    if (body.token !== undefined) owner = tokenEntry(body).owner;
    const joinFee = await checkout.joinFee();
    if (rawTarget === undefined || rawTarget === null) {
      return send(res, 200, { owner: owner ?? null, joinFee, slippageBps: cfg.slippageBps, quoteTtlSeconds: cfg.quoteTtlS, quotes: await checkout.quotes(owner) });
    }
    const target = Number(rawTarget);
    if (!Number.isInteger(target) || target < 1) throw new CheckoutError(400, "invalid_request", "target must be an integer >= 1");
    send(res, 200, { ...(await checkout.quoteOffer(target, owner)), joinFee, etaSecondsAtTarget: eta(target) });
  }

  /** `GET /earnings/:address`: what an address earned for being passed, and what reached its wallet. */
  async function earnings(res: ServerResponse, raw: string): Promise<void> {
    const address = parseAddress(decodeURIComponent(raw), "address");
    const key = address.toLowerCase();
    const t = feed.totals;
    const claimable = await checkout.claimable(address);
    send(res, 200, {
      address,
      earned: t.earnedBy[key] ?? 0n,
      earnedUsd: fmtUsd(t.earnedBy[key] ?? 0n),
      timesPassed: t.passesBy[key] ?? 0,
      received: t.receivedBy[key] ?? 0n,
      receivedUsd: fmtUsd(t.receivedBy[key] ?? 0n),
      claimable,
      payout: claimable === 0n ? "nothing pending" : cfg.autoPayout ? "pending: the operator pushes it to this address automatically" : "claimable",
      contract: cfg.contract,
      network: `eip155:${cfg.chainId}`,
    });
  }

  /**
   * The busy API. Saturated: 429 with a small offer (position, ETA, the live price to #1 and how to pay
   * it) plus Retry-After / X-429-* / Link headers. With `X-429-Token` it answers for that ticket: the
   * result once served, else your position and the price from there.
   */
  async function busyApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const city = url.searchParams.get("city");
    const rawToken = req.headers["x-429-token"];
    if (rawToken !== undefined) {
      const entry = tokenEntry({ token: Array.isArray(rawToken) ? rawToken[0] : rawToken });
      const st = await gate.use(entry.ticketId, (a) => apiResult(city, a));
      if (st.status === "used") return send(res, 200, st.result);
      if (st.status === "waiting" || st.status === "serving") {
        const d = gate.reject429(checkout.reader.latest, { ticketId: entry.ticketId, owner: entry.owner, position: st.status === "waiting" ? st.position : 1, status: st.status });
        return send(res, 429, d.body, d.headers);
      }
      throw new CheckoutError(410, st.status, "this ticket can no longer be used; join again");
    }
    const d = await gate.admit(req);
    if (d.kind === "reject") return send(res, d.status, d.body, d.headers ?? {});
    const a = d.admission;
    send(res, 200, a ? apiResult(city, a) : { ...forecasts.get(city), admitted: { via: "direct" } });
  }

  async function staticFile(res: ServerResponse, pathname: string): Promise<boolean> {
    if (!siteDir) return false;
    const rel = normalize(pathname === "/" ? "/index.html" : pathname).replace(/^(\.\.[/\\])+/, "");
    const file = join(siteDir, rel);
    if (!file.startsWith(siteDir)) return false;
    try {
      const data = await readFile(file);
      res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream", "cache-control": "no-cache" });
      res.end(data);
      return true;
    } catch {
      return false;
    }
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const p = url.pathname;
    const m = req.method ?? "GET";
    if (m === "OPTIONS") {
      res.writeHead(204, { ...CORS, "access-control-allow-methods": "GET, POST, DELETE, OPTIONS" });
      return void res.end();
    }
    if (p === "/healthz") return send(res, 200, { ok: true, chainId: cfg.chainId, contract: cfg.contract, queueId: cfg.queueId, operator: checkout.relayer?.address ?? null });
    if (p === "/x429") return send(res, 200, gate.descriptor(await checkout.reader.get()));
    if (p === BUSY_PATH) return busyApi(req, res, url);
    if (p === "/skip" && (m === "POST" || m === "GET")) return paid("skip", req, res, url);
    if (p === "/join" && m === "POST") return paid("join", req, res, url);
    if (p === "/use" && m === "POST") return use(req, res);
    if (p === "/ticket" && m === "POST") return ticket(req, res);
    if (p === "/quote" && (m === "GET" || m === "POST")) return quote(req, res, url);
    if (p.startsWith("/earnings/") && m === "GET") return earnings(res, p.slice("/earnings/".length));
    if (p === `/queue/${cfg.queueId}` || p === "/queue") {
      const owner = url.searchParams.get("owner");
      const ownerAddr = owner ? parseAddress(owner, "owner") : undefined;
      const s = await checkout.status(ownerAddr);
      const snap = checkout.reader.latest;
      return send(res, 200, {
        ...s,
        joinFee: await checkout.joinFee(),
        serviceIntervalMs: cfg.serviceIntervalMs,
        admissionRoundMs: cfg.minQueueMs,
        etaSecondsForNewcomer: gate.etaSeconds((snap?.length ?? 0) + 1, snap),
        quotes: await checkout.quotes(ownerAddr),
        descriptor: gate.descriptor(snap),
      });
    }
    if (p.startsWith("/queue/")) throw new CheckoutError(404, "unknown_queue", `this server runs queue ${cfg.queueId}`);
    if (p === "/join/typed-data") {
      const owner = parseAddress(url.searchParams.get("owner"), "owner");
      const price = url.searchParams.get("skipPrice");
      return send(res, 200, await checkout.joinTypedData(owner, price ? parseUint(price, "skipPrice") : undefined));
    }
    if (p === "/join/signed" && m === "POST") return send(res, 200, await checkout.join((await readBody(req)) as never, clientIp(req)));
    if (p === "/claim/typed-data") {
      const owner = parseAddress(url.searchParams.get("owner"), "owner");
      const recipient = url.searchParams.get("recipient");
      return send(res, 200, await checkout.claimTypedData(owner, recipient ? parseAddress(recipient, "recipient") : undefined));
    }
    if (p === "/claim" && m === "POST") return send(res, 200, await checkout.claim((await readBody(req)) as never));
    if (p === "/feed") {
      const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit") ?? 100) || 100));
      const snap = checkout.reader.latest ?? (await checkout.reader.get());
      return send(res, 200, {
        chainId: cfg.chainId,
        contract: cfg.contract,
        queueId: cfg.queueId,
        explorer: cfg.explorer,
        demoAgents: [...cfg.demoAgents],
        serviceIntervalMs: cfg.serviceIntervalMs,
        totals: feed.totals,
        queue: checkout.queueJson(snap),
        events: feed.recent(limit),
      });
    }
    if (p === "/stats") {
      return send(res, 200, { gate: gate.snapshotStats(), payouts: payouts ? { ...payouts.stats, pending: payouts.pendingCount } : null, tokens: checkout.tokens.size, gas: checkout.relayer?.gas ?? [] });
    }
    if (p === "/paybox-plugin.json") return send(res, 200, await pluginManifest(checkout, BUSY_PATH));
    if (p === "/mcp") {
      const body = m === "POST" ? await readBody(req) : undefined;
      return handleMcp(checkout, BUSY_PATH, req, res, body, clientIp(req));
    }
    if (m === "GET" && (await staticFile(res, p))) return;
    send(res, 404, { error: "not_found" });
  }

  return createServer((req, res) => {
    route(req, res).catch((err: unknown) => {
      if (res.headersSent) return void res.end();
      if (err instanceof CheckoutError) return send(res, err.status, { error: err.reason, message: err.message, ...err.details });
      log({ evt: "error", path: req.url, error: String((err as Error)?.stack ?? err).split("\n").slice(0, 3).join(" | ") });
      send(res, 500, { error: "internal_error" });
    });
  });
}
