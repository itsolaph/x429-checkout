// `x429(options)` → a Lane: the gate in front of your API, the x429 routes, the operator loop,
// automatic payouts and the event feed, wired to your own X429Checkout contract.
import { EventEmitter } from "node:events";
import { resolve } from "node:path";
import type { Address, PublicClient } from "viem";
import { checkoutAbi } from "./abi.ts";
import { forwardToFacilitator, resolveBazaar } from "./bazaar.ts";
import { Relayer, makeLogsClients, makePublicClient } from "./chain.ts";
import { Checkout, CheckoutError } from "./checkout.ts";
import { OptionsError, resolveOptions, type Config, type LogEntry, type ServeHook, type X429Options } from "./config.ts";
import { Feed, rpcHost } from "./feed.ts";
import { Gate, type Admission } from "./gate.ts";
import { header, json, type LaneRequest, type LaneResponse } from "./http.ts";
import { Payouts } from "./payouts.ts";
import { QueueReader } from "./queue.ts";
import { Routes } from "./routes.ts";
import { TokenStore } from "./tokens.ts";

/** What to do with a request to a protected route. */
export type Decision =
  /** Let it through. Call `done()` when the response is finished (the concurrency model counts it). */
  | { action: "next"; via: "direct" | "queue" | "token"; admission?: Admission; done: () => void }
  /** Answer with this response (429 with the skip offer, the served ticket's answer, or an error). */
  | ({ action: "respond" } & LaneResponse);

/** Event names a Lane emits, besides "log" (every log entry) and the raw `evt` of each entry. */
export type LaneEvent = "admitted" | "rejected" | "joined" | "joined_paid" | "skipped" | "served" | "paid_out" | "payout_error" | "serve_error" | "bazaar_verify" | "bazaar_verify_error" | "internal_error" | "log";

const ALIASES: Record<string, string> = { admit: "admitted", joined_paid: "joined", error: "internal_error" };

export class Lane extends EventEmitter {
  readonly cfg: Config;
  readonly client: PublicClient;
  readonly checkout: Checkout;
  readonly gate: Gate;
  readonly feed: Feed;
  readonly payouts: Payouts;
  readonly routes: Routes;
  private readonly serve: ServeHook | undefined;
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private running = false;

  /** Use `x429(options)`; this constructor takes already connected parts. */
  constructor(parts: { cfg: Config; client: PublicClient; checkout: Checkout; gate: Gate; feed: Feed; payouts: Payouts; routes: Routes; serve?: ServeHook }) {
    super();
    this.cfg = parts.cfg;
    this.client = parts.client;
    this.checkout = parts.checkout;
    this.gate = parts.gate;
    this.feed = parts.feed;
    this.payouts = parts.payouts;
    this.routes = parts.routes;
    this.serve = parts.serve;
  }

  /** The operator address (undefined for a read-only lane). */
  get operator(): Address | undefined {
    return this.checkout.relayer?.address;
  }

  /** @internal Routes a log entry to the "log" event and its own event name. */
  emitLog(entry: LogEntry): void {
    if (this.listenerCount("log") > 0) this.emit("log", entry);
    const evt = typeof entry.evt === "string" ? entry.evt : undefined;
    if (!evt) return;
    // never emit "error": EventEmitter throws on an "error" nobody listens to
    if (evt !== "error" && this.listenerCount(evt) > 0) this.emit(evt, entry);
    const alias = ALIASES[evt];
    if (alias && this.listenerCount(alias) > 0) this.emit(alias, entry);
  }

  /** Starts the operator loop (serving the head), automatic payouts and the event feed. */
  start(): void {
    if (this.running) return;
    this.running = true;
    const reader = this.checkout.reader;
    this.pollTimer = setInterval(() => void reader.refresh().catch(() => {}), this.cfg.pollMs);
    this.gate.start();
    this.feed.start(this.cfg.pollMs);
    if (this.cfg.autoPayout) this.payouts.start(this.cfg.payoutIntervalMs);
  }

  /** Stops every timer and saves the feed progress. Requests are still answered (read-only). */
  stop(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = undefined;
    this.gate.stop();
    this.feed.stop();
    this.payouts.stop();
    this.running = false;
  }

  /**
   * Decides a request to a protected route. Over capacity without a ticket: 429 with the x429 offer.
   * With `X-429-Token` of a served ticket: the `serve` hook's answer, or (without a hook) through once.
   * With the legacy ticket + EIP-191 signature headers: through once. Never throws.
   */
  async handle(req: LaneRequest): Promise<Decision> {
    try {
      return await this.decide(req);
    } catch (err) {
      return { action: "respond", ...this.routes.failure(err, req.url) };
    }
  }

  private async decide(req: LaneRequest): Promise<Decision> {
    const { gate, checkout } = this;
    const url = new URL(req.url || "/", "http://localhost");
    const rawToken = header(req.headers, "x-429-token");
    if (rawToken !== undefined) {
      const entry = this.routes.tokenEntry(rawToken);
      const hook = this.serve;
      const params = Object.fromEntries(url.searchParams);
      const st = await gate.use(entry.ticketId, hook ? (a) => hook(a, params) : undefined);
      if (st.status === "used" && st.result !== undefined) return { action: "respond", ...json(200, st.result) };
      if (st.status === "ready") {
        const done = gate.passThrough(st.admission);
        if (done) return { action: "next", via: "token", admission: st.admission, done };
      }
      if (st.status === "ready" || st.status === "used") throw new CheckoutError(410, "used", "this ticket's request was already used; join again");
      if (st.status === "waiting" || st.status === "serving") {
        const d = gate.reject429(checkout.reader.latest, { ticketId: entry.ticketId, owner: entry.owner, position: st.status === "waiting" ? st.position : 1, status: st.status });
        return { action: "respond", ...json(429, d.body, d.headers) };
      }
      throw new CheckoutError(410, st.status, "this ticket can no longer be used; join again");
    }
    const d = await gate.admit(req.headers);
    if (d.kind === "reject") return { action: "respond", ...json(d.status, d.body, d.headers ?? {}) };
    return { action: "next", via: d.via, admission: d.admission, done: d.release ?? (() => {}) };
  }
}

/**
 * Connects to your X429Checkout contract and returns a Lane. Fails early (with a clear message) on
 * bad options, a wrong chain, an unknown queue, or an operator key that is not the contract's operator.
 */
export async function x429(options: X429Options): Promise<Lane> {
  const { cfg, operatorKey } = resolveOptions(options);
  const bazaar = resolveBazaar(options.bazaar);
  const dataDir = cfg.dataDir ? resolve(cfg.dataDir) : undefined;
  cfg.dataDir = dataDir;
  // `lane` exists once everything is connected; until then log entries only reach the logger
  let lane: Lane | undefined;
  const logger = options.logger;
  // RPC URLs can carry an API key in their path or query: log entries show only the host
  const urls = [...new Set([cfg.rpcUrl, ...cfg.logsRpcUrls])].sort((a, b) => b.length - a.length);
  const scrub = (v: unknown): unknown => {
    if (typeof v === "string") return urls.reduce((s, u) => (s.includes(u) ? s.split(u).join(rpcHost(u)) : s), v);
    if (Array.isArray(v)) return v.map(scrub);
    if (v && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrub(x)]));
    return v;
  };
  const log = (raw: LogEntry) => {
    const entry = scrub(raw) as LogEntry;
    try {
      logger?.(entry);
    } catch {
      // a logger never breaks a request
    }
    lane?.emitLog(entry);
  };

  const client = makePublicClient(cfg);
  let chainId: number;
  try {
    chainId = await client.getChainId();
  } catch (err) {
    throw new OptionsError(`cannot reach rpcUrl ${rpcHost(cfg.rpcUrl)}: ${String((err as Error)?.message ?? err).split("\n")[0]}`);
  }
  if (chainId !== cfg.chainId) throw new OptionsError(`rpcUrl is chain ${chainId}, expected chainId ${cfg.chainId}`);
  const reader = new QueueReader(client, cfg.contract, cfg.queueId, cfg.pollMs);
  try {
    await reader.get(0);
  } catch (err) {
    throw new OptionsError(`cannot read queue ${cfg.queueId} of ${cfg.contract} (wrong contract, chain or queue id?): ${String((err as Error)?.message ?? err).split("\n")[0]}`);
  }
  const relayer = operatorKey ? new Relayer(client, operatorKey, cfg.contract) : undefined;
  const operator = await client.readContract({ address: cfg.contract, abi: checkoutAbi, functionName: "operator" });
  if (relayer && operator.toLowerCase() !== relayer.address.toLowerCase()) {
    throw new OptionsError(`the operator key belongs to ${relayer.address}, but the operator of ${cfg.contract} is ${operator}`);
  }

  const tokens = new TokenStore(dataDir, cfg.contract);
  const checkout = new Checkout(cfg, client, reader, relayer, log, tokens);
  const gate = new Gate(checkout, log);
  const logsRpcs = makeLogsClients(cfg);
  // A feed RPC on another chain would book foreign events: refuse to start. One that does not answer now is
  // only logged; the feed rotates past it.
  const logsChains = await Promise.allSettled(
    logsRpcs.map((r) =>
      Promise.race([r.client.getChainId(), new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 10_000).unref())]),
    ),
  );
  logsChains.forEach((r, i) => {
    const host = rpcHost(logsRpcs[i]!.url);
    if (r.status === "fulfilled" && r.value !== cfg.chainId) throw new OptionsError(`logsRpcUrls entry ${host} is chain ${r.value}, expected ${cfg.chainId}`);
    if (r.status === "rejected") log({ evt: "feed_rpc_error", host, error: "chain id check failed at startup" });
  });
  const feed = new Feed({ rpcs: logsRpcs, chainId: cfg.chainId, contract: cfg.contract, queueId: cfg.queueId, fromBlock: cfg.deployBlock, dataDir, log });
  const payouts = new Payouts(checkout, feed, log);
  const routes = new Routes({ checkout, gate, feed, log, payouts, serve: options.serve, bazaar });
  lane = new Lane({ cfg, client, checkout, gate, feed, payouts, routes, serve: options.serve });
  const l = lane;
  gate.onReject = (body) => {
    if (l.listenerCount("rejected") > 0) {
      l.emit("rejected", { evt: "rejected", position: body.position, queueLength: body.queueLength, etaSeconds: body.etaSeconds, skipCost: body.skip?.cost ?? null });
    }
  };
  if (bazaar) {
    checkout.onSkipVerified = (payment) => forwardToFacilitator(bazaar, payment, { url: `${cfg.routeBase}/skip` }, log);
  }
  if (options.autoStart !== false) lane.start();
  return lane;
}
