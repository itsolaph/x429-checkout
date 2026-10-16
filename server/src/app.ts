// HTTP routes: the busy API, x402 /join and /skip, /use with a redeem token, quotes, earnings, the legacy
// gasless EIP-712 join/claim, the feed, MCP and the dashboard.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { createHash } from "node:crypto";
import type { Address } from "viem";
import { CheckoutError, parseAddress, parseUint, type Checkout, type Log, type SkipResult } from "./checkout.ts";
import type { Feed } from "./feed.ts";
import type { Gate } from "./gate.ts";
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
  "access-control-allow-headers": "content-type, x-payment, payment-signature, x-429-ticket, x-429-signature, mcp-protocol-version",
  "access-control-expose-headers": "payment-required, payment-response, x-payment-response, retry-after, x-429-queue",
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

function cityOf(raw: unknown): string {
  const city = typeof raw === "string" ? raw.replace(/[^\p{L}\p{N} .,'-]/gu, "").trim().slice(0, 60) : "";
  return city || "Lisbon";
}

/** A deterministic demo forecast: cheap to compute, shaped like a real paid API response. */
export function forecast(city: string) {
  const day = new Date().toISOString().slice(0, 10);
  const h = createHash("sha256").update(`${city.toLowerCase()}|${day}`).digest();
  const conditions = ["clear", "partly cloudy", "overcast", "light rain", "showers", "windy", "fog"];
  const hours = Array.from({ length: 6 }, (_, i) => ({
    hour: `${String(9 + i * 2).padStart(2, "0")}:00`,
    tempC: 8 + (h[i]! % 18),
    rainPct: h[i + 6]! % 100,
    windKph: 4 + (h[i + 12]! % 30),
    sky: conditions[h[i + 18]! % conditions.length]!,
  }));
  const temps = hours.map((x) => x.tempC);
  const wettest = hours.reduce((a, b) => (b.rainPct > a.rainPct ? b : a));
  const windiest = hours.reduce((a, b) => (b.windKph > a.windKph ? b : a));
  const umbrella = wettest.rainPct >= 50;
  return {
    city,
    date: day,
    summary: `${city}, ${day}: ${Math.min(...temps)} to ${Math.max(...temps)} °C, ${umbrella ? `take an umbrella (${wettest.rainPct}% rain at ${wettest.hour})` : `mostly dry (at most ${wettest.rainPct}% rain)`}, windiest at ${windiest.hour} (${windiest.windKph} km/h).`,
    hours,
    model: "x429-demo-forecast-1",
    note: "Demo data for the x429 queue, not a real weather service.",
  };
}

export type AppDeps = { checkout: Checkout; gate: Gate; feed: Feed; log: Log; payouts?: Payouts; siteDir?: string };

export function createApp({ checkout, gate, feed, log, payouts, siteDir }: AppDeps): Server {
  const cfg = checkout.cfg;

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

  /**
   * The two paid x402 resources. `POST /join` (body {skipPrice?}) creates a waiting ticket for the
   * payer; `POST /skip` (body or query {target, skipPrice?, owner?}) moves the payer's ticket (or a new
   * one) to `target`. Without a payment header both answer 402 with v1 `accepts` in the body and the
   * v2 PAYMENT-REQUIRED header; with one they settle onchain and return a redeem token.
   */
  async function paid(kind: "join" | "skip", req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
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
      headers[V2_REQUIRED_HEADER] = encodeHeader(v2PaymentRequired(o.requirements, error));
      send(res, status, { ...v1PaymentRequired(o.requirements, error), ...extra, quote: checkout.quoteJson(o.quote) }, headers);
    };

    const payment = readPayment(req.headers);
    if (!payment) return paymentRequired(402, "X-PAYMENT (v1) or PAYMENT-SIGNATURE (v2) header is required");
    if ("error" in payment) return paymentRequired(400, payment.error, { message: payment.message });
    const payer = payment.payload.authorization.from;

    try {
      const r = kind === "join" ? await checkout.settleJoin(payment, skipPrice) : await checkout.settleSkip(payment, target, skipPrice);
      const txHash = r.replayed ? (checkout.tokens.paymentTx(payer, payment.payload.authorization.nonce) ?? "") : r.txHash;
      const settlement = settlementResponse({ success: true, transaction: txHash, chainId: cfg.chainId, version: payment.version, payer });
      const header = { [payment.version === 2 ? V2_RESPONSE_HEADER : V1_RESPONSE_HEADER]: encodeHeader(settlement) };
      if (r.replayed) {
        return send(res, 200, {
          ok: true,
          kind,
          ...r,
          txHash,
          etaSeconds: r.position ? eta(r.position) : null,
          message: `This payment was already settled for ticket #${r.ticketId}; nothing was charged again. Here is a fresh token for it.`,
          next: NEXT_USE,
        }, header);
      }
      if (r.refundedInFull) {
        return send(res, 200, { ok: true, kind, ...r, message: "The payment arrived through a front-run transaction but the request was no longer possible; it was refunded in full." }, header);
      }
      if (kind === "join" && "fee" in r && !("passes" in r)) {
        return send(res, 200, {
          ok: true,
          kind,
          ...r,
          feeUsd: fmtUsd(r.fee),
          etaSeconds: eta(r.position),
          message: `You joined at #${r.position} with a skip price of ${fmtUsd(r.skipPrice)}: anyone who passes you pays you that, automatically. Join fee ${fmtUsd(r.fee)}, refunded ${fmtUsd(r.refund)}.`,
          next: NEXT_USE,
        }, header);
      }
      const s = r as SkipResult;
      send(res, 200, {
        ok: true,
        kind,
        ...s,
        costUsd: fmtUsd(s.cost),
        etaSeconds: eta(s.position),
        payouts: cfg.autoPayout ? "the agents you passed are being paid automatically" : "the agents you passed can claim their compensation",
        message: `You are now #${s.position}. Paid ${s.passes} agent(s) ${fmtUsd(s.compensation)} in total, fee ${fmtUsd(s.fee)}, refunded ${fmtUsd(s.refund)}.`,
        next: NEXT_USE,
      }, header);
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
    }
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
    const city = cityOf(body.city);
    const st = await gate.use(entry.ticketId, (a) => ({
      ...forecast(city),
      admitted: { via: "queue", ticketId: a.ticketId, waitedSeconds: a.waited, timesPassed: a.timesPassed, earned: a.earned, paid: a.paid, servedTx: a.servedTx },
    }));
    const common = { ticketId: entry.ticketId, owner: entry.owner };
    if (st.status === "used") {
      return send(res, 200, { status: "served", ...common, replayed: st.replayed, expiresInSeconds: st.expiresInSeconds, result: st.result });
    }
    if (st.status === "waiting" || st.status === "serving") {
      const position = st.status === "waiting" ? st.position : 0;
      const front = position > 1 ? await checkout.quote(1, entry.owner).catch(() => undefined) : undefined;
      return send(res, 429, {
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

  async function busyApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const d = await gate.admit(req);
    if (d.kind === "reject") {
      return send(res, d.status, d.body, {
        ...(d.retryAfterS ? { "retry-after": String(d.retryAfterS) } : {}),
        "x-429-queue": `${cfg.contract}/${cfg.queueId}`,
      });
    }
    const city = cityOf(url.searchParams.get("city"));
    const a = d.admission;
    send(res, 200, {
      ...forecast(city),
      admitted: a
        ? { via: "queue", ticketId: a.ticketId, waitedSeconds: a.waited, timesPassed: a.timesPassed, earned: a.earned, paid: a.paid, servedTx: a.servedTx }
        : { via: "direct" },
    });
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
