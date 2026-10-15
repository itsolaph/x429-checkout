// Reads the onchain queue and prices skips the same way the contract does.
import type { Address, PublicClient } from "viem";
import { checkoutAbi } from "./abi.ts";

export const MAX_PASSES = 64;

export type TicketRow = {
  position: number; // 1 = served next
  id: bigint;
  owner: Address;
  skipPrice: bigint;
  joinedAt: number; // chain time, seconds
  timesPassed: number;
  earned: bigint;
  paid: bigint;
  firstSeenMs: number; // when this server first saw the ticket (wall clock)
};

export type Snapshot = {
  queueId: number;
  operator: Address;
  feeBps: number;
  length: number;
  maxLength: number;
  skips: number;
  joined: bigint;
  served: bigint;
  totalCompensation: bigint;
  feesAccrued: bigint;
  meta: string;
  tickets: TicketRow[];
  blockNumber: bigint;
  blockTime: number; // seconds
  fetchedAt: number; // ms
};

export type PassedTicket = { position: number; ticketId: bigint; owner: Address; amount: bigint };

export type Quote = {
  owner: Address | null;
  ticketId: bigint | null;
  fromPosition: number;
  targetPosition: number;
  passes: number;
  compensation: bigint;
  fee: bigint;
  cost: bigint;
  /** cost plus the slippage buffer: what the 402 asks the payer to authorize. */
  maxAmountRequired: bigint;
  passed: PassedTicket[];
};

export type QuoteError = { error: "invalid_target" | "nothing_to_pass" | "too_many_passes" | "queue_full"; message: string };

/** Prices moving `owner` (or a newcomer at the tail) to `targetPosition`, exactly as `skip` would. */
export function quoteSkip(
  snap: Snapshot,
  owner: Address | null,
  targetPosition: number,
  slippageBps: number,
): Quote | QuoteError {
  if (!Number.isInteger(targetPosition) || targetPosition < 1) {
    return { error: "invalid_target", message: "target position must be an integer >= 1" };
  }
  const mine = owner ? snap.tickets.find((t) => t.owner.toLowerCase() === owner.toLowerCase()) : undefined;
  if (!mine && snap.length >= snap.maxLength) return { error: "queue_full", message: "the queue is full" };
  const fromPosition = mine ? mine.position : snap.length + 1;
  const passes = Math.max(0, fromPosition - targetPosition);
  if (passes === 0) {
    return { error: "nothing_to_pass", message: `already at position ${fromPosition}, nothing to pass` };
  }
  if (passes > MAX_PASSES) {
    return { error: "too_many_passes", message: `at most ${MAX_PASSES} tickets can be passed in one skip` };
  }
  const passed = snap.tickets
    .filter((t) => t.position >= targetPosition && t.position < fromPosition)
    .map((t) => ({ position: t.position, ticketId: t.id, owner: t.owner, amount: t.skipPrice }));
  const compensation = passed.reduce((s, p) => s + p.amount, 0n);
  const fee = (compensation * BigInt(snap.feeBps)) / 10_000n;
  const cost = compensation + fee;
  let maxAmountRequired = cost + (cost * BigInt(slippageBps)) / 10_000n;
  if (maxAmountRequired === 0n) maxAmountRequired = 1n; // x402 needs a positive amount; it is refunded
  return {
    owner,
    ticketId: mine?.id ?? null,
    fromPosition,
    targetPosition,
    passes,
    compensation,
    fee,
    cost,
    maxAmountRequired,
    passed,
  };
}

export function isQuoteError(q: Quote | QuoteError): q is QuoteError {
  return "error" in q;
}

/** Polls `queueInfo` + `getQueue` and keeps the latest snapshot. */
export class QueueReader {
  private snap: Snapshot | undefined;
  private inflight: Promise<Snapshot> | undefined;
  private readonly firstSeen = new Map<bigint, number>();

  private readonly client: PublicClient;
  private readonly contract: Address;
  readonly queueId: number;
  private readonly maxAgeMs: number;

  constructor(client: PublicClient, contract: Address, queueId: number, maxAgeMs: number) {
    this.client = client;
    this.contract = contract;
    this.queueId = queueId;
    this.maxAgeMs = maxAgeMs;
  }

  get latest(): Snapshot | undefined {
    return this.snap;
  }

  /** A snapshot no older than `maxAgeMs` (pass 0 to force a read). */
  async get(maxAgeMs = this.maxAgeMs): Promise<Snapshot> {
    if (this.snap && Date.now() - this.snap.fetchedAt <= maxAgeMs) return this.snap;
    return this.refresh();
  }

  refresh(): Promise<Snapshot> {
    if (!this.inflight) {
      this.inflight = this.read().finally(() => {
        this.inflight = undefined;
      });
    }
    return this.inflight;
  }

  private async read(): Promise<Snapshot> {
    const block = await this.client.getBlock();
    const [info, list] = await Promise.all([
      this.client.readContract({
        address: this.contract,
        abi: checkoutAbi,
        functionName: "queueInfo",
        args: [this.queueId],
        blockNumber: block.number,
      }),
      this.client.readContract({
        address: this.contract,
        abi: checkoutAbi,
        functionName: "getQueue",
        args: [this.queueId, 0, 256],
        blockNumber: block.number,
      }),
    ]);
    const now = Date.now();
    const live = new Set<bigint>();
    const tickets: TicketRow[] = list.map((t, i) => {
      live.add(t.id);
      if (!this.firstSeen.has(t.id)) this.firstSeen.set(t.id, now);
      return {
        position: i + 1,
        id: t.id,
        owner: t.owner,
        skipPrice: t.skipPrice,
        joinedAt: t.joinedAt,
        timesPassed: t.timesPassed,
        earned: t.earned,
        paid: t.paid,
        firstSeenMs: this.firstSeen.get(t.id)!,
      };
    });
    for (const id of this.firstSeen.keys()) if (!live.has(id)) this.firstSeen.delete(id);
    const snap: Snapshot = {
      queueId: this.queueId,
      operator: info.operator,
      feeBps: info.feeBps,
      length: info.length,
      maxLength: info.maxLength,
      skips: info.skips,
      joined: info.joined,
      served: info.served,
      totalCompensation: info.totalCompensation,
      feesAccrued: info.feesAccrued,
      meta: info.meta,
      tickets,
      blockNumber: block.number,
      blockTime: Number(block.timestamp),
      fetchedAt: now,
    };
    if (!this.snap || snap.blockNumber >= this.snap.blockNumber) this.snap = snap;
    return snap;
  }

  /** Marks a ticket as seen now (e.g. right after we relayed its join), for the admission round. */
  markSeen(id: bigint): void {
    if (!this.firstSeen.has(id)) this.firstSeen.set(id, Date.now());
  }
}
