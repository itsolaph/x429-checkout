// Indexes contract events for the dashboard and /earnings: who joined, who skipped, who earned what,
// and what reached their wallets (operator payouts and claims).
import { parseEventLogs, type Address, type PublicClient } from "viem";
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

export class Feed {
  readonly events: FeedEvent[] = [];
  readonly totals: FeedTotals = { paidToWaiting: 0n, fees: 0n, claimed: 0n, paidOut: 0n, skips: 0, passes: 0, served: 0, joins: 0, earnedBy: {}, passesBy: {}, receivedBy: {} };
  private next: bigint;
  private timer: ReturnType<typeof setInterval> | undefined;
  private busy = false;
  private readonly times = new Map<bigint, number>();
  private readonly client: PublicClient;
  private readonly contract: Address;
  private readonly queueId: number;
  private readonly keep: number;

  constructor(client: PublicClient, contract: Address, queueId: number, fromBlock: bigint, keep = 500) {
    this.client = client;
    this.contract = contract;
    this.queueId = queueId;
    this.keep = keep;
    this.next = fromBlock;
  }

  start(pollMs: number): void {
    if (!this.timer) this.timer = setInterval(() => void this.poll(), pollMs);
    void this.poll();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async poll(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const latest = await this.client.getBlockNumber();
      if (this.next === 0n) this.next = latest > 5_000n ? latest - 5_000n : 0n;
      while (this.next <= latest) {
        const to = this.next + 2_000n > latest ? latest : this.next + 1_999n;
        const raw = await this.client.getLogs({ address: this.contract, fromBlock: this.next, toBlock: to });
        const logs = parseEventLogs({ abi: checkoutAbi, logs: raw });
        for (const log of logs) await this.add(log);
        this.next = to + 1n;
      }
    } catch {
      // try again next tick
    } finally {
      this.busy = false;
    }
  }

  private async time(block: bigint): Promise<number> {
    let t = this.times.get(block);
    if (t === undefined) {
      t = Number((await this.client.getBlock({ blockNumber: block })).timestamp);
      this.times.set(block, t);
      if (this.times.size > 2_000) this.times.delete(this.times.keys().next().value!);
    }
    return t;
  }

  private async add(log: ReturnType<typeof parseEventLogs<typeof checkoutAbi>>[number]): Promise<void> {
    const kind = KINDS[log.eventName];
    if (!kind) return;
    const args = log.args as Record<string, unknown>;
    if ("queueId" in args && Number(args.queueId) !== this.queueId) return;
    const t = this.totals;
    const ev: FeedEvent = {
      kind,
      block: log.blockNumber,
      time: await this.time(log.blockNumber),
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

  recent(limit: number): FeedEvent[] {
    return this.events.slice(-limit).reverse();
  }
}
