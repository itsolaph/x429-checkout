// Indexes contract events for the dashboard and /earnings: who joined, who skipped, who earned what,
// and what reached their wallets (operator payouts and claims).
//
// Reads go through the feed's own RPC list (X429_LOGS_RPC_URL, else X429_RPC_URL): on an error the feed
// rotates to the next URL and backs off exponentially (capped), logging a rate-limited `feed_rpc_error`.
// With a data dir, progress (next block, totals, recent events) is saved after indexed chunks, so a
// restart resumes where it stopped instead of re-indexing from the deploy block.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BaseError, parseEventLogs, type Address, type PublicClient } from "viem";
import { checkoutAbi } from "./abi.ts";

export type FeedEvent = {
  kind: "joined" | "skipped" | "passed" | "served" | "claimed" | "paid_out" | "left" | "refunded";
  block: bigint;
  time: number; // seconds
  tx: `0x${string}`;
  logIndex: number;
  ticketId?: bigint;
  owner?: Address;
  amount?: bigint;
  data: Record<string, unknown>;
};

export type FeedTotals = {
  paidToWaiting: bigint; // sum of Passed amounts
  fees: bigint;
  claimed: bigint;
  /** Sent to owners by the operator (payout). */
  paidOut: bigint;
  skips: number;
  passes: number;
  served: number;
  joins: number;
  earnedBy: Record<string, bigint>;
  passesBy: Record<string, number>;
  /** Payouts and claims, by owner. */
  receivedBy: Record<string, bigint>;
};

/** The reads the feed needs from an RPC (a viem PublicClient, or a mock in tests). */
export type FeedRpc = Pick<PublicClient, "getBlockNumber" | "getLogs" | "getBlock">;
export type FeedEndpoint = { url: string; client: FeedRpc };
export type FeedLog = (entry: Record<string, unknown>) => void;

export type FeedOptions = {
  /** RPC endpoints for getLogs/getBlock/getBlockNumber, tried in order and rotated on errors. */
  rpcs: FeedEndpoint[];
  chainId: number;
  contract: Address;
  queueId: number;
  /** First block to index; 0 starts 5,000 blocks behind the head. */
  fromBlock: bigint;
  /** Where the feed state is saved; unset keeps it in memory. */
  dataDir?: string;
  log?: FeedLog;
  /** Recent events kept (and saved). */
  keep?: number;
  chunkBlocks?: bigint;
  /** Minimum time between two saves. */
  saveEveryMs?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  /** Minimum time between two `feed_rpc_error` lines for the same host. */
  errorLogEveryMs?: number;
  now?: () => number;
};

export type FeedSync = { next: string; head: string; caughtUp: boolean };

const KINDS: Record<string, FeedEvent["kind"]> = {
  Joined: "joined",
  Skipped: "skipped",
  Passed: "passed",
  Served: "served",
  Claimed: "claimed",
  PaidOut: "paid_out",
  JoinPaid: "joined",
  Left: "left",
  PaymentRefunded: "refunded",
};

const STATE_VERSION = 1;
const SAVED_TIMES = 500;
const MAX_TIMES = 2_000;

type CheckoutLog = ReturnType<typeof parseEventLogs<typeof checkoutAbi>>[number];

type Stored = {
  version: number;
  chainId: number;
  contract: string;
  queueId: number;
  fromBlock: bigint;
  next: bigint;
  totals: FeedTotals;
  events: FeedEvent[];
  times: [bigint, number][];
};

/** JSON with bigints kept exact: written as `{"$bigint":"<decimal>"}` and read back as bigint. */
export function encodeState(value: unknown): string {
  return JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? { $bigint: v.toString() } : v));
}

export function decodeState(text: string): unknown {
  return JSON.parse(text, (_k, v) => {
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      const keys = Object.keys(v);
      if (keys.length === 1 && keys[0] === "$bigint") {
        if (typeof v.$bigint !== "string" || !/^-?\d+$/.test(v.$bigint)) throw new Error("bad bigint");
        return BigInt(v.$bigint);
      }
    }
    return v;
  });
}

function emptyTotals(): FeedTotals {
  return { paidToWaiting: 0n, fees: 0n, claimed: 0n, paidOut: 0n, skips: 0, passes: 0, served: 0, joins: 0, earnedBy: {}, passesBy: {}, receivedBy: {} };
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const isCount = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const isAmount = (v: unknown): v is bigint => typeof v === "bigint" && v >= 0n;
const allValues = (v: unknown, f: (x: unknown) => boolean): boolean => isObj(v) && Object.values(v).every(f);

function validTotals(t: unknown): t is FeedTotals {
  if (!isObj(t)) return false;
  return (
    isAmount(t.paidToWaiting) && isAmount(t.fees) && isAmount(t.claimed) && isAmount(t.paidOut) &&
    isCount(t.skips) && isCount(t.passes) && isCount(t.served) && isCount(t.joins) &&
    allValues(t.earnedBy, isAmount) && allValues(t.passesBy, isCount) && allValues(t.receivedBy, isAmount)
  );
}

function validEvent(e: unknown): e is FeedEvent {
  return isObj(e) && typeof e.kind === "string" && typeof e.block === "bigint" && typeof e.time === "number" && typeof e.tx === "string" && typeof e.logIndex === "number" && isObj(e.data);
}

/** The host of an RPC URL (never the path or query, which may carry an API key). */
export function rpcHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "invalid-url";
  }
}

export class Feed {
  readonly events: FeedEvent[] = [];
  readonly totals: FeedTotals = emptyTotals();
  /** The latest head block number the feed has seen (0 before the first answer). */
  head = 0n;
  private next: bigint;
  private timer: ReturnType<typeof setInterval> | undefined;
  private busy = false;
  private readonly times = new Map<bigint, number>();
  private readonly rpcs: FeedEndpoint[];
  private rpcIndex = 0;
  private failures = 0;
  private retryAt = 0;
  private readonly lastErrorLog = new Map<string, { at: number; suppressed: number }>();
  private readonly file: string | undefined;
  private dirty = false;
  private lastSave = 0;
  private readonly log: FeedLog;
  private readonly now: () => number;
  private readonly chainId: number;
  private readonly contract: Address;
  private readonly queueId: number;
  private readonly fromBlock: bigint;
  private readonly keep: number;
  private readonly chunk: bigint;
  private readonly saveEveryMs: number;
  private readonly backoffBaseMs: number;
  private readonly backoffMaxMs: number;
  private readonly errorLogEveryMs: number;

  constructor(opts: FeedOptions) {
    if (opts.rpcs.length === 0) throw new Error("feed needs at least one RPC");
    this.rpcs = opts.rpcs;
    this.chainId = opts.chainId;
    this.contract = opts.contract;
    this.queueId = opts.queueId;
    this.fromBlock = opts.fromBlock;
    this.next = opts.fromBlock;
    this.keep = opts.keep ?? 500;
    this.chunk = opts.chunkBlocks ?? 2_000n;
    this.saveEveryMs = opts.saveEveryMs ?? 3_000;
    this.backoffBaseMs = opts.backoffBaseMs ?? 1_000;
    this.backoffMaxMs = opts.backoffMaxMs ?? 30_000;
    this.errorLogEveryMs = opts.errorLogEveryMs ?? 30_000;
    this.log = opts.log ?? (() => {});
    this.now = opts.now ?? Date.now;
    if (opts.dataDir) {
      mkdirSync(opts.dataDir, { recursive: true, mode: 0o700 });
      this.file = join(opts.dataDir, `feed-${this.chainId}-${this.contract.toLowerCase()}-${this.queueId}.json`);
      this.load();
    }
  }

  /** Indexing progress: the next block to index, the head last seen, and whether the feed reached it. */
  get sync(): FeedSync {
    return { next: this.next.toString(), head: this.head.toString(), caughtUp: this.head > 0n && this.next > this.head };
  }

  start(pollMs: number): void {
    if (!this.timer) this.timer = setInterval(() => void this.poll(), pollMs);
    void this.poll();
  }

  /** Stops polling and writes any unsaved progress. */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (this.dirty) this.save();
  }

  async poll(): Promise<void> {
    if (this.busy || this.now() < this.retryAt) return;
    this.busy = true;
    const rpc = this.rpcs[this.rpcIndex]!;
    try {
      const latest = await rpc.client.getBlockNumber();
      if (latest > this.head) this.head = latest;
      if (this.next === 0n) this.next = latest > 5_000n ? latest - 5_000n : 0n;
      while (this.next <= latest) {
        const to = this.next + this.chunk > latest ? latest : this.next + this.chunk - 1n;
        const raw = await rpc.client.getLogs({ address: this.contract, fromBlock: this.next, toBlock: to });
        const logs = parseEventLogs({ abi: checkoutAbi, logs: raw }).filter((l) => this.relevant(l));
        // Fetch every timestamp before touching the totals: a failed chunk must leave nothing applied,
        // or the retry would count its events twice.
        const times = new Map<bigint, number>();
        for (const l of logs) if (!times.has(l.blockNumber)) times.set(l.blockNumber, await this.time(rpc.client, l.blockNumber));
        for (const l of logs) this.apply(l, times.get(l.blockNumber)!);
        this.next = to + 1n;
        this.dirty = true;
        this.failures = 0;
        this.maybeSave();
      }
    } catch (err) {
      this.fail(rpc.url, err);
    } finally {
      this.maybeSave();
      this.busy = false;
    }
  }

  recent(limit: number): FeedEvent[] {
    return this.events.slice(-limit).reverse();
  }

  private relevant(log: CheckoutLog): boolean {
    if (!KINDS[log.eventName]) return false;
    const args = log.args as Record<string, unknown>;
    return !("queueId" in args) || Number(args.queueId) === this.queueId;
  }

  /** Rotates to the next RPC and waits before the next attempt (1 s, 2 s, 4 s … capped). */
  private fail(url: string, err: unknown): void {
    this.failures++;
    const delay = Math.min(this.backoffMaxMs, this.backoffBaseMs * 2 ** Math.min(this.failures - 1, 30));
    this.retryAt = this.now() + delay;
    if (this.rpcs.length > 1) this.rpcIndex = (this.rpcIndex + 1) % this.rpcs.length;

    const host = rpcHost(url);
    const now = this.now();
    const last = this.lastErrorLog.get(host);
    if (last && now - last.at < this.errorLogEveryMs) {
      last.suppressed++;
      return;
    }
    this.lastErrorLog.set(host, { at: now, suppressed: 0 });
    this.log({
      evt: "feed_rpc_error",
      host,
      error: this.describe(err),
      code: (err as { code?: unknown })?.code ?? null,
      failures: this.failures,
      retryInMs: delay,
      next: this.next,
      head: this.head,
      ...(last?.suppressed ? { suppressed: last.suppressed } : {}),
    });
  }

  /** One line, with every configured RPC URL replaced by its host (URLs can carry API keys). */
  private describe(err: unknown): string {
    let msg: string;
    if (err instanceof BaseError) {
      msg = err.details && err.details !== err.shortMessage ? `${err.shortMessage} (${err.details})` : err.shortMessage;
    } else {
      msg = String((err as Error)?.message ?? err);
    }
    msg = msg.split("\n")[0]!.slice(0, 300);
    for (const { url } of this.rpcs) msg = msg.split(url).join(rpcHost(url));
    return msg;
  }

  private async time(client: FeedRpc, block: bigint): Promise<number> {
    let t = this.times.get(block);
    if (t === undefined) {
      t = Number((await client.getBlock({ blockNumber: block })).timestamp);
      this.times.set(block, t);
      if (this.times.size > MAX_TIMES) this.times.delete(this.times.keys().next().value!);
    }
    return t;
  }

  /** Books one (relevant) log into the totals and the event list. Synchronous: never half-applied. */
  private apply(log: CheckoutLog, time: number): void {
    const kind = KINDS[log.eventName]!;
    const args = log.args as Record<string, unknown>;
    const t = this.totals;
    const ev: FeedEvent = {
      kind,
      block: log.blockNumber,
      time,
      tx: log.transactionHash,
      logIndex: log.logIndex,
      data: args,
    };
    switch (log.eventName) {
      case "Joined":
        ev.ticketId = log.args.ticketId;
        ev.owner = log.args.owner;
        t.joins++;
        break;
      case "Skipped":
        ev.ticketId = log.args.ticketId;
        ev.owner = log.args.owner;
        ev.amount = log.args.compensation + log.args.fee;
        t.skips++;
        t.fees += log.args.fee;
        break;
      case "Passed": {
        ev.ticketId = log.args.passedTicketId;
        ev.owner = log.args.passedOwner;
        ev.amount = log.args.amount;
        t.passes++;
        t.paidToWaiting += log.args.amount;
        const key = log.args.passedOwner.toLowerCase();
        t.earnedBy[key] = (t.earnedBy[key] ?? 0n) + log.args.amount;
        t.passesBy[key] = (t.passesBy[key] ?? 0) + 1;
        break;
      }
      case "JoinPaid":
        // the Joined event of the same transaction is the feed entry; this one only books the fee
        t.fees += log.args.fee;
        return;
      case "PaidOut": {
        ev.owner = log.args.owner;
        ev.amount = log.args.amount;
        t.paidOut += log.args.amount;
        const key = log.args.owner.toLowerCase();
        t.receivedBy[key] = (t.receivedBy[key] ?? 0n) + log.args.amount;
        break;
      }
      case "Served":
        ev.ticketId = log.args.ticketId;
        ev.owner = log.args.owner;
        t.served++;
        break;
      case "Claimed":
        ev.owner = log.args.owner;
        ev.amount = log.args.amount;
        t.claimed += log.args.amount;
        t.receivedBy[log.args.owner.toLowerCase()] = (t.receivedBy[log.args.owner.toLowerCase()] ?? 0n) + log.args.amount;
        break;
      case "Left":
        ev.ticketId = log.args.ticketId;
        ev.owner = log.args.owner;
        break;
      case "PaymentRefunded":
        ev.owner = log.args.from;
        ev.amount = log.args.value;
        break;
    }
    this.events.push(ev);
    if (this.events.length > this.keep) this.events.shift();
  }

  private maybeSave(): void {
    if (this.dirty && this.now() - this.lastSave >= this.saveEveryMs) this.save();
  }

  /** Writes the state atomically (tmp file + rename). A failed write is logged and retried later. */
  save(): void {
    if (!this.file) return;
    const state: Stored = {
      version: STATE_VERSION,
      chainId: this.chainId,
      contract: this.contract.toLowerCase(),
      queueId: this.queueId,
      fromBlock: this.fromBlock,
      next: this.next,
      totals: this.totals,
      events: this.events,
      times: [...this.times].slice(-SAVED_TIMES),
    };
    this.lastSave = this.now();
    try {
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, encodeState(state), { mode: 0o600 });
      renameSync(tmp, this.file);
      this.dirty = false;
    } catch (err) {
      this.log({ evt: "feed_save_error", error: String((err as Error)?.message ?? err).split("\n")[0] });
    }
  }

  /** Resumes from a saved state of the same chain, contract, queue and start block; anything else is ignored. */
  private load(): void {
    let text: string;
    try {
      text = readFileSync(this.file!, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") this.log({ evt: "feed_state_unreadable", file: this.file, error: String((err as Error)?.message ?? err) });
      return;
    }
    let s: Partial<Stored>;
    try {
      const raw = decodeState(text);
      if (!isObj(raw)) throw new Error("not an object");
      s = raw as Partial<Stored>;
      if (s.version !== STATE_VERSION) throw new Error(`version ${String(s.version)}`);
      if (typeof s.next !== "bigint" || s.next < 0n) throw new Error("bad next");
      if (!validTotals(s.totals)) throw new Error("bad totals");
      if (!Array.isArray(s.events) || !s.events.every(validEvent)) throw new Error("bad events");
      if (!Array.isArray(s.times) || !s.times.every((p) => Array.isArray(p) && typeof p[0] === "bigint" && typeof p[1] === "number")) throw new Error("bad times");
    } catch (err) {
      this.log({ evt: "feed_state_corrupt", file: this.file, error: String((err as Error)?.message ?? err).split("\n")[0], from: this.fromBlock });
      return;
    }
    if (s.chainId !== this.chainId || s.contract !== this.contract.toLowerCase() || s.queueId !== this.queueId || s.fromBlock !== this.fromBlock) {
      this.log({ evt: "feed_state_mismatch", file: this.file, from: this.fromBlock });
      return;
    }
    Object.assign(this.totals, s.totals);
    this.events.push(...s.events!.slice(-this.keep));
    for (const [b, t] of s.times!) this.times.set(b, t);
    this.next = s.next;
    this.log({ evt: "feed_resumed", next: this.next, events: this.events.length, passes: this.totals.passes });
  }
}
