// The lane's HTTP routes, framework neutral: x402 /join and /skip, /use with a redeem token, /ticket,
// quotes, earnings, the queue, the descriptor, the event feed, stats and the legacy gasless join/claim.
// Paths are relative to the lane prefix (default /x429; "" mounts them at the root, as x429.lol does).
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Address } from "viem";
import { bazaarDeclaration, bazaarResource, type BazaarConfig } from "./bazaar.ts";
import { CheckoutError, parseAddress, parseUint, type Checkout, type Log, type SkipResult } from "./checkout.ts";
import type { ServeHook, ValidateHook } from "./config.ts";
import type { Feed } from "./feed.ts";
import type { Gate, ServeNow } from "./gate.ts";
import { clientIp, json, preflight, type LaneRequest, type LaneResponse } from "./http.ts";
import { toJson } from "./json.ts";
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
  type Discovery,
} from "./x402.ts";

export type RoutesDeps = {
  checkout: Checkout;
  gate: Gate;
  feed: Feed;
  log: Log;
  payouts?: Payouts;
  serve?: ServeHook;
  validate?: ValidateHook;
  bazaar?: BazaarConfig;
};

const NEXT_USE = "Keep the token: it is the only proof that this ticket is yours. Call /use (PayBox plugin: x429_use) with it; it answers with your position and ETA while you wait, and with the API result once you are served.";

type Cached = { status: number; body: unknown; headers: Record<string, string>; expires: number; client?: string };
type Body = Record<string, unknown>;

export class Routes {
  readonly prefix: string;
  private readonly checkout: Checkout;
  private readonly gate: Gate;
  private readonly feed: Feed;
  private readonly log: Log;
  private readonly payouts: Payouts | undefined;
  private readonly serve: ServeHook | undefined;
  private readonly validate: ValidateHook | undefined;
  private readonly discovery: Discovery | undefined;

  /**
   * Successful paid responses by payment (kind, payer, EIP-3009 nonce): a retry from the same client
   * gets the same bytes. The key is public once the settlement is mined (the authorization is
   * calldata), so a retry from another client gets the receipt without the redeem token or the API
   * result. Kept in the data dir (mode 600, next to the token store) so a retry after a restart still
   * gets its token instead of a redacted receipt.
   */
  private readonly responses = new Map<string, Cached>();
  private readonly inflight = new Map<string, Promise<Cached | undefined>>();
  private readonly responsesFile: string | undefined;

  /**
   * While someone holds an unpaid skip quote, the operator's own demo agents do not join: each join
   * lands behind the quote's last ticket and raises the price of the skip they are approving (by up
   * to the agent's skip price, more than the slippage buffer), which would fail it with price_moved.
   * Real agents are never held. The hold lasts as long as the payment the quote asks for is valid.
   */
  private demoHoldUntil = 0;
  private lastQuoteAt = 0;
  private readonly demoHoldMs: number;

  constructor(d: RoutesDeps) {
    this.checkout = d.checkout;
    this.gate = d.gate;
    this.feed = d.feed;
    this.log = d.log;
    this.payouts = d.payouts;
    this.serve = d.serve;
    this.validate = d.validate;
    this.discovery = d.bazaar ? { resource: bazaarResource(d.bazaar), extensions: { bazaar: bazaarDeclaration(d.bazaar) } } : undefined;
    const cfg = d.checkout.cfg;
    this.prefix = cfg.prefix;
    this.demoHoldMs = (cfg.paymentTimeoutS + 30) * 1000;
    this.responsesFile = cfg.dataDir ? join(cfg.dataDir, `responses-${cfg.contract.toLowerCase()}.json`) : undefined;
    if (this.responsesFile) {
      try {
        const saved = JSON.parse(readFileSync(this.responsesFile, "utf8")) as { version: 1; responses: [string, Cached][] };
        const now = Date.now();
        if (saved?.version === 1) for (const [k, v] of saved.responses) if (v.expires >= now) this.responses.set(k, v);
        this.log({ evt: "responses_loaded", responses: this.responses.size });
      } catch {
        // first start
      }
    }
  }

  private get cfg() {
    return this.checkout.cfg;
  }

  /** The path relative to the prefix, or undefined when `pathname` is not under it. */
  private relative(pathname: string): string | undefined {
    const p = this.prefix;
    if (p === "") return pathname;
    if (pathname === p) return "";
    return pathname.startsWith(`${p}/`) ? pathname.slice(p.length) : undefined;
  }

  /** True if `pathname` belongs to the lane (under a non-empty prefix: any subpath). */
  matches(pathname: string): boolean {
    const rel = this.relative(pathname);
    if (rel === undefined) return false;
    return this.prefix !== "" || this.known(rel);
  }

  private known(rel: string): boolean {
    return (
      ["/x429", "/skip", "/join", "/use", "/ticket", "/quote", "/queue", "/feed", "/stats", "/join/typed-data", "/join/signed", "/claim/typed-data", "/claim"].includes(rel) ||
      rel.startsWith("/earnings/") ||
      rel.startsWith("/queue/")
    );
  }

  /**
   * Answers a lane route, or returns undefined when the request is not one (so the app can go on).
   * Never throws: failures become JSON error responses.
   */
  async handle(req: LaneRequest): Promise<LaneResponse | undefined> {
    const url = new URL(req.url || "/", "http://localhost");
    const rel = this.relative(url.pathname);
    if (rel === undefined) return undefined;
    try {
      if (req.method === "OPTIONS") return this.matches(url.pathname) ? preflight() : undefined;
      const r = await this.route(rel, req, url);
      if (r === undefined && this.prefix !== "") return json(404, { error: "not_found" });
      return r;
    } catch (err) {
      return this.failure(err, req.url);
    }
  }

  /** Runs the `validate` option on a request's params; a refusal is thrown as a CheckoutError (400 unless it is one). */
  async check(params: Record<string, unknown>, route: "skip" | "use" | "token"): Promise<void> {
    if (!this.validate) return;
    try {
      await this.validate(params, { route });
    } catch (err) {
      if (err instanceof CheckoutError) throw err;
      throw new CheckoutError(400, "invalid_request", String((err as Error)?.message ?? err).split("\n")[0]!.slice(0, 300));
    }
  }

  /** A thrown error as a response: CheckoutError → its status and reason; anything else → 500, logged. */
  failure(err: unknown, path?: string): LaneResponse {
    if (err instanceof CheckoutError) return json(err.status, { error: err.reason, message: err.message, ...err.details });
    this.log({ evt: "error", path, error: String((err as Error)?.stack ?? err).split("\n").slice(0, 3).join(" | ") });
    return json(500, { error: "internal_error" });
  }

  private async route(rel: string, req: LaneRequest, url: URL): Promise<LaneResponse | undefined> {
    const m = req.method || "GET";
    const cfg = this.cfg;
    const { checkout, gate, feed } = this;
    if ((this.prefix === "" && rel === "/x429") || (this.prefix !== "" && rel === "")) return json(200, gate.descriptor(await checkout.reader.get()));
    if (rel === "/skip" && (m === "POST" || m === "GET")) return this.paid("skip", req, url);
    if (rel === "/join" && m === "POST") return this.paid("join", req, url);
    if (rel === "/use" && m === "POST") return this.use(req);
    if (rel === "/ticket" && m === "POST") return this.ticket(req);
    if (rel === "/quote" && (m === "GET" || m === "POST")) return this.quote(req, url);
    if (rel.startsWith("/earnings/") && m === "GET") return this.earnings(rel.slice("/earnings/".length));
    if (rel === `/queue/${cfg.queueId}` || rel === "/queue") {
      const owner = url.searchParams.get("owner");
      const ownerAddr = owner ? parseAddress(owner, "owner") : undefined;
      const s = await checkout.status(ownerAddr);
      const snap = checkout.reader.latest;
      return json(200, {
        ...s,
        joinFee: await checkout.joinFee(),
        serviceIntervalMs: gate.intervalMs(),
        admissionRoundMs: cfg.minQueueMs,
        etaSecondsForNewcomer: gate.etaSeconds((snap?.length ?? 0) + 1, snap),
        quotes: await checkout.quotes(ownerAddr),
        descriptor: gate.descriptor(snap),
      });
    }
    if (rel.startsWith("/queue/")) throw new CheckoutError(404, "unknown_queue", `this server runs queue ${cfg.queueId}`);
    if (rel === "/join/typed-data") {
      const owner = parseAddress(url.searchParams.get("owner"), "owner");
      const price = url.searchParams.get("skipPrice");
      return json(200, await checkout.joinTypedData(owner, price ? parseUint(price, "skipPrice") : undefined));
    }
    if (rel === "/join/signed" && m === "POST") return json(200, await checkout.join((await this.rawBody(req)) as never, this.ip(req)));
    if (rel === "/claim/typed-data") {
      const owner = parseAddress(url.searchParams.get("owner"), "owner");
      const recipient = url.searchParams.get("recipient");
      return json(200, await checkout.claimTypedData(owner, recipient ? parseAddress(recipient, "recipient") : undefined));
    }
    if (rel === "/claim" && m === "POST") return json(200, await checkout.claim((await this.rawBody(req)) as never));
    if (rel === "/feed") {
      const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit") ?? 100) || 100));
      const snap = checkout.reader.latest ?? (await checkout.reader.get());
      return json(200, {
        chainId: cfg.chainId,
        contract: cfg.contract,
        queueId: cfg.queueId,
        explorer: cfg.explorer,
        demoAgents: [...cfg.demoAgents],
        serviceIntervalMs: gate.intervalMs(),
        totals: feed.totals,
        // indexing progress: while caughtUp is false the totals are partial (catching up), not zero
        sync: feed.sync,
        queue: checkout.queueJson(snap),
        events: feed.recent(limit),
      });
    }
    if (rel === "/stats") {
      const p = this.payouts;
      return json(200, { gate: gate.snapshotStats(), payouts: p ? { ...p.stats, pending: p.pendingCount } : null, tokens: checkout.tokens.size, gas: checkout.relayer?.gas ?? [] });
    }
    return undefined;
  }

  private ip(req: LaneRequest): string {
    return clientIp(req.headers, req.ip);
  }

  private async rawBody(req: LaneRequest): Promise<unknown> {
    return req.body ? req.body() : undefined;
  }

  /** Parses a JSON object body (or none). */
  private async objectBody(req: LaneRequest): Promise<Body> {
    const body = req.method === "POST" ? await this.rawBody(req) : undefined;
    if (body === undefined || body === null) return {};
    if (typeof body !== "object" || Array.isArray(body)) throw new CheckoutError(400, "invalid_request", "the body must be a JSON object");
    return body as Body;
  }

  /** The ETA for a position, from the latest snapshot. */
  private eta(position: number): number {
    return this.gate.etaSeconds(position, this.checkout.reader.latest);
  }

  private who(owner: Address): { who: string; demo: boolean } {
    const demo = this.cfg.demoAgents.has(owner.toLowerCase());
    return { who: `${owner.slice(0, 6)}…${owner.slice(-4)}${demo ? " (demo agent)" : ""}`, demo };
  }

  /** The receipt of a paid skip: who got what, what came back, what it bought. */
  private receiptOf(s: SkipResult, served: ServeNow | undefined) {
    const cfg = this.cfg;
    const waitSavedSeconds = Math.round((s.passes * this.gate.intervalMs()) / 1000);
    return {
      newPosition: s.position,
      fromPosition: s.fromPosition,
      passed: s.passed.map((p) => ({ ticketId: p.ticketId, owner: p.owner, ...this.who(p.owner), amount: p.amount, amountUsd: fmtUsd(p.amount) })),
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
          : { status: "queued", reason: served?.reason ?? "not_at_head", etaSeconds: served?.etaSeconds ?? this.eta(s.position) },
      headline: `Skipped ~${waitSavedSeconds}s; ${s.passed.length} agent${s.passed.length === 1 ? "" : "s"} earned ${fmtUsd(s.compensation)}.`,
    };
  }

  private saveResponses(): void {
    if (!this.responsesFile) return;
    try {
      mkdirSync(this.cfg.dataDir!, { recursive: true, mode: 0o700 });
      const tmp = `${this.responsesFile}.tmp`;
      writeFileSync(tmp, toJson({ version: 1, responses: [...this.responses] }), { mode: 0o600 });
      renameSync(tmp, this.responsesFile);
    } catch (err) {
      this.log({ evt: "responses_save_error", error: String((err as Error)?.message ?? err) });
    }
  }

  private sweepResponses(): void {
    const now = Date.now();
    for (const [k, v] of this.responses) if (v.expires < now) this.responses.delete(k);
    while (this.responses.size > 10_000) this.responses.delete(this.responses.keys().next().value!);
  }

  /**
   * The two paid x402 resources. `POST /join` (body {skipPrice?}) creates a waiting ticket for the
   * payer; `POST /skip` (body or query {target, skipPrice?, owner?, ...params}) moves the payer's ticket
   * (or a new one) to `target`. Without a payment header both answer 402 with v1 `accepts` in the body
   * and the v2 PAYMENT-REQUIRED header; with one they settle onchain and return a redeem token. A skip
   * that reaches #1 while there is room is served in the same request: the paid response carries the
   * API answer (from the `serve` hook) and a receipt. A retried paid request returns the identical response.
   */
  private async paid(kind: "join" | "skip", req: LaneRequest, url: URL): Promise<LaneResponse> {
    const { checkout, gate, cfg } = this;
    const t0 = performance.now();
    const tArrived = Date.now();
    const body = await this.objectBody(req);
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
    // what the serve hook sees: the body, with query values winning
    const params: Body = { ...body, ...Object.fromEntries(qs) };
    // body requests (the PayBox plugin) are priced on the plain path; query requests keep their URL
    const resource = kind === "skip" && qs.get("target") === null ? `${cfg.routeBase}/skip` : undefined;
    const offer = (who: Address | undefined) =>
      kind === "join" ? checkout.joinOffer(skipPrice) : checkout.skipOffer(target, who, rawPrice ? skipPrice : undefined, 0, resource);

    /** Answers with fresh payment requirements: for `owner` if possible, else for a newcomer. */
    const paymentRequired = async (status: number, error: string, extra: Body = {}, owner = ownerHint, failure?: Body): Promise<LaneResponse> => {
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
        return json(status === 402 && !failure ? offerError!.status : status, { x402Version: 1, error: reason, accepts: [], message: offerError!.message, ...extra }, headers);
      }
      if (kind === "skip" && status === 402 && cfg.demoAgents.size > 0) {
        this.demoHoldUntil = Math.max(this.demoHoldUntil, Date.now() + this.demoHoldMs);
        this.lastQuoteAt = Date.now();
      }
      headers[V2_REQUIRED_HEADER] = encodeHeader(v2PaymentRequired(o.requirements, error, kind === "skip" ? this.discovery : undefined));
      return json(status, { ...v1PaymentRequired(o.requirements, error), ...extra, quote: checkout.quoteJson(o.quote) }, headers);
    };

    const payment = readPayment(req.headers);
    if (!payment) {
      if (kind === "skip") await this.check(params, "skip");
      return paymentRequired(402, "X-PAYMENT (v1) or PAYMENT-SIGNATURE (v2) header is required");
    }
    if ("error" in payment) return paymentRequired(400, payment.error, { message: payment.message });
    const payer = payment.payload.authorization.from;
    const nonce = payment.payload.authorization.nonce;
    if (kind === "join" && Date.now() < this.demoHoldUntil && cfg.demoAgents.has(payer.toLowerCase())) {
      const retryAfter = Math.max(1, Math.ceil((this.demoHoldUntil - Date.now()) / 1000));
      return json(503, { error: "quote_hold", message: `a skip quote is waiting for approval; demo agents join again in ${retryAfter}s. Nothing was charged.`, retryAfterSeconds: retryAfter }, { "retry-after": String(retryAfter) });
    }

    // idempotency on the EIP-3009 nonce: the same payment gets the same response, and is never charged twice
    this.sweepResponses();
    const key = `${kind}:${payer.toLowerCase()}:${nonce.toLowerCase()}`;
    const client = this.ip(req);
    const hit = this.responses.get(key) ?? (await this.inflight.get(key));
    if (hit) {
      const same = hit.client === client;
      this.log({ evt: "paid_request_retried", kind, payer, nonce, sameClient: same });
      return json(hit.status, same ? hit.body : redacted(hit.body), { ...hit.headers, "x-429-idempotent-replay": "true" });
    }
    // refused params are never settled: nothing is charged
    if (kind === "skip") await this.check(params, "skip");

    const run = async (): Promise<Cached> => {
      let tSettled = 0;
      let served: ServeNow | undefined;
      const r =
        kind === "join"
          ? await checkout.settleJoin(payment, skipPrice)
          : await checkout.settleSkip(payment, target, skipPrice, async (s) => {
              tSettled = performance.now();
              if (s.position === 1) served = await gate.serveNow(s.ticketId, cfg.serveConfirm, { owner: s.owner, paid: s.cost });
            });
      // the answer is built once the relayer is free again (the hook may take its time)
      const serveHook = this.serve;
      if (served?.status === "served" && serveHook) {
        try {
          served.result = (await gate.answer(served.admission, (a) => serveHook(a, params), "paid_skip")).result;
        } catch (err) {
          this.log({ evt: "serve_hook_error", ticketId: served.admission.ticketId, error: String((err as Error)?.message ?? err).split("\n")[0] });
        }
      }
      const tDone = performance.now();
      const txHash = r.replayed ? (checkout.tokens.paymentTx(payer, nonce) ?? "") : r.txHash;
      const settlement = settlementResponse({ success: true, transaction: txHash, chainId: cfg.chainId, version: payment.version, payer });
      const timing = tSettled
        ? `settle;dur=${(tSettled - t0).toFixed(0)}, serve;dur=${(tDone - tSettled).toFixed(0)}, total;dur=${(tDone - t0).toFixed(0)}`
        : `total;dur=${(tDone - t0).toFixed(0)}`;
      const headers = { [payment.version === 2 ? V2_RESPONSE_HEADER : V1_RESPONSE_HEADER]: encodeHeader(settlement), "server-timing": timing };
      const expires = Math.max(Date.now() + 600_000, Number(payment.payload.authorization.validBefore) * 1000 + 600_000);
      this.log({ evt: "paid_latency", kind, ms: Math.round(tDone - t0), settleMs: tSettled ? Math.round(tSettled - t0) : undefined, served: served?.status, ...(served?.status === "busy" ? { busyReason: served.reason } : {}) });
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
            etaSeconds: r.position ? this.eta(r.position) : null,
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
            etaSeconds: this.eta(r.position),
            message: `You joined at #${r.position} with a skip price of ${fmtUsd(r.skipPrice)}: anyone who passes you pays you that, automatically. Join fee ${fmtUsd(r.fee)}, refunded ${fmtUsd(r.refund)}.`,
            next: NEXT_USE,
          },
        };
      }
      const s = r as SkipResult;
      const receipt = this.receiptOf(s, served);
      const done = served as ServeNow | undefined;
      const isServed = done?.status === "served";
      const answered = isServed && done.result !== undefined;
      return {
        status: 200,
        headers,
        expires,
        body: {
          ok: true,
          kind,
          status: isServed ? "served" : "queued",
          result: answered ? done.result : null,
          receipt,
          ...s,
          costUsd: fmtUsd(s.cost),
          etaSeconds: isServed ? 0 : this.eta(s.position),
          message: isServed
            ? `Served. ${receipt.headline} Charged ${fmtUsd(s.cost)}, refunded ${fmtUsd(s.refund)}.`
            : `You are now #${s.position}. ${receipt.headline} Charged ${fmtUsd(s.cost)}, refunded ${fmtUsd(s.refund)}.`,
          next: answered
            ? "Done: `result` is the API answer and `receipt` the proof of what was paid to whom."
            : isServed
              ? `Served: call the API once with the header X-429-Token: <token> within ${Math.round(cfg.admissionTtlMs / 1000)} s.`
              : NEXT_USE,
        },
      };
    };

    const p = run();
    this.inflight.set(key, p.catch(() => undefined));
    try {
      const c = { ...(await p), client };
      this.responses.set(key, c);
      this.saveResponses();
      // the quote this payment answers is settled: lift the hold unless someone was quoted since it arrived
      if (kind === "skip" && this.lastQuoteAt < tArrived) this.demoHoldUntil = 0;
      return json(c.status, c.body, c.headers);
    } catch (err) {
      if (!(err instanceof CheckoutError)) throw err;
      this.log({ evt: `${kind}_rejected`, reason: err.reason, message: err.message, payer });
      const failure = settlementResponse({ success: false, transaction: "", chainId: cfg.chainId, version: payment.version, payer, errorReason: err.reason });
      if (err.status === 402) {
        return paymentRequired(402, err.reason, { message: err.message, ...err.details }, payer, failure);
      }
      return json(err.status, { error: err.reason, message: err.message, ...err.details }, {
        [V1_RESPONSE_HEADER]: encodeHeader(failure),
        [V2_RESPONSE_HEADER]: encodeHeader(failure),
      });
    } finally {
      this.inflight.delete(key);
    }
  }

  /** Resolves a redeem token, or throws 403. */
  tokenEntry(token: unknown) {
    const entry = this.checkout.tokens.lookup(token);
    if (!entry) {
      throw new CheckoutError(403, "invalid_token", "unknown or malformed redeem token (it comes in the paid response of /join or /skip)");
    }
    return entry;
  }

  /** `POST /use {token, ...params}`: the API for a ticket holder. 200 with the answer once served. */
  private async use(req: LaneRequest): Promise<LaneResponse> {
    const { checkout, gate } = this;
    const body = await this.objectBody(req);
    const entry = this.tokenEntry(body.token);
    await this.check(body, "use");
    const hook = this.serve;
    const st = await gate.use(entry.ticketId, hook ? (a) => hook(a, body) : undefined);
    const common = { ticketId: entry.ticketId, owner: entry.owner };
    if (st.status === "used" && st.result !== undefined) {
      return json(200, { status: "served", ...common, replayed: st.replayed, expiresInSeconds: st.expiresInSeconds, result: st.result });
    }
    if (st.status === "ready") {
      // no serve hook: the request itself goes to the API
      return json(200, {
        status: "served",
        ...common,
        replayed: false,
        expiresInSeconds: st.expiresInSeconds,
        result: null,
        next: `Call the API once with the header X-429-Token: <token> within ${st.expiresInSeconds} s.`,
      });
    }
    if (st.status === "used") {
      return json(410, { status: "used", ...common, message: "This ticket's request was already used." });
    }
    if (st.status === "waiting" || st.status === "serving") {
      const position = st.status === "waiting" ? st.position : 0;
      const front = position > 1 ? await checkout.quote(1, entry.owner).catch(() => undefined) : undefined;
      const offer = gate.offer(checkout.reader.latest, { ticketId: entry.ticketId, owner: entry.owner, position, status: st.status });
      return json(429, {
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
    return json(410, {
      status: st.status,
      ...common,
      message: st.status === "left" ? "This ticket left the queue." : "This ticket was served but its request was not used within the admission window. Join again.",
    });
  }

  /** `POST /ticket {token}`: where your ticket stands, without using it. */
  private async ticket(req: LaneRequest): Promise<LaneResponse> {
    const { checkout, gate } = this;
    const entry = this.tokenEntry((await this.objectBody(req)).token);
    const st = await gate.inspect(entry.ticketId);
    const row = checkout.reader.latest?.tickets.find((t) => t.id === entry.ticketId);
    const { admission, ...rest } = st as typeof st & { admission?: unknown };
    void admission;
    return json(200, {
      ...rest,
      owner: entry.owner,
      ticket: row ? { position: row.position, skipPrice: row.skipPrice, timesPassed: row.timesPassed, earned: row.earned, paid: row.paid } : null,
      claimable: await checkout.claimable(entry.owner),
    });
  }

  /** `GET /quote?target=&owner=` or `POST /quote {target?, owner?, token?}`. */
  private async quote(req: LaneRequest, url: URL): Promise<LaneResponse> {
    const { checkout, cfg } = this;
    const body = await this.objectBody(req);
    const rawTarget = url.searchParams.get("target") ?? body.target;
    const rawOwner = url.searchParams.get("owner") ?? body.owner;
    let owner = rawOwner ? parseAddress(rawOwner, "owner") : undefined;
    if (body.token !== undefined) owner = this.tokenEntry(body.token).owner;
    const joinFee = await checkout.joinFee();
    if (rawTarget === undefined || rawTarget === null) {
      return json(200, { owner: owner ?? null, joinFee, slippageBps: cfg.slippageBps, quoteTtlSeconds: cfg.quoteTtlS, quotes: await checkout.quotes(owner) });
    }
    const target = Number(rawTarget);
    if (!Number.isInteger(target) || target < 1) throw new CheckoutError(400, "invalid_request", "target must be an integer >= 1");
    return json(200, { ...(await checkout.quoteOffer(target, owner)), joinFee, etaSecondsAtTarget: this.eta(target) });
  }

  /** `GET /earnings/:address`: what an address earned for being passed, and what reached its wallet. */
  private async earnings(raw: string): Promise<LaneResponse> {
    const { checkout, cfg } = this;
    const address = parseAddress(decodeURIComponent(raw), "address");
    const key = address.toLowerCase();
    const t = this.feed.totals;
    const claimable = await checkout.claimable(address);
    return json(200, {
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

