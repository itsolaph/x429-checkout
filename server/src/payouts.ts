// Automatic compensation: owners passed by a skip get their USDC pushed by the operator (payoutBatch),
// so a waiting agent never has to claim, sign or hold ETH. Owners are queued right after each skip;
// a periodic sweep also picks up anyone with a claimable balance (e.g. after a restart). An owner
// whose transfer USDC refuses (blocklist) is left to claim later and not retried in this process.
import type { Address } from "viem";
import { checkoutAbi } from "./abi.ts";
import type { Checkout, Log } from "./checkout.ts";
import type { Feed } from "./feed.ts";

const BATCH = 64;

export class Payouts {
  private readonly pending = new Set<string>();
  private readonly refused = new Set<string>();
  private running = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  private lastSweep = 0;
  readonly stats = { batches: 0, paid: 0, amount: 0n, errors: 0 };

  private readonly checkout: Checkout;
  private readonly feed: Feed;
  private readonly log: Log;

  constructor(checkout: Checkout, feed: Feed, log: Log) {
    this.checkout = checkout;
    this.feed = feed;
    this.log = log;
  }

  start(intervalMs: number, sweepMs = 60_000): void {
    if (this.timer || !this.checkout.relayer) return;
    this.checkout.onPassed = (owners) => {
      this.enqueue(owners);
      void this.flush();
    };
    this.timer = setInterval(() => {
      if (Date.now() - this.lastSweep >= sweepMs) void this.sweep();
      void this.flush();
    }, intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.checkout.onPassed = undefined;
  }

  enqueue(owners: Address[]): void {
    for (const o of owners) if (!this.refused.has(o.toLowerCase())) this.pending.add(o);
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  /** Queues every owner the feed has seen earn something who still has a claimable balance. */
  async sweep(): Promise<void> {
    this.lastSweep = Date.now();
    const owners = Object.keys(this.feed.totals.earnedBy) as Address[];
    for (const owner of owners) {
      if (this.refused.has(owner.toLowerCase())) continue;
      const owed = await this.checkout.client
        .readContract({ address: this.checkout.cfg.contract, abi: checkoutAbi, functionName: "claimable", args: [owner] })
        .catch(() => 0n);
      if (owed > 0n) this.pending.add(owner);
    }
  }

  /** Sends pending payouts in batches. One flush at a time; failures go back to the queue. */
  async flush(): Promise<void> {
    if (this.running || this.pending.size === 0) return;
    this.running = true;
    try {
      while (this.pending.size > 0) {
        const batch = [...this.pending].slice(0, BATCH) as Address[];
        for (const o of batch) this.pending.delete(o);
        try {
          const r = await this.checkout.payout(batch);
          this.stats.batches++;
          this.stats.paid += r.paid.length;
          for (const p of r.paid) this.stats.amount += p.amount;
          for (const f of r.failed) this.refused.add(f.toLowerCase());
        } catch (err) {
          this.stats.errors++;
          this.enqueue(batch);
          this.log({ evt: "payout_error", owners: batch.length, error: String((err as Error)?.message ?? err).split("\n")[0] });
          break; // retry on the next tick
        }
      }
    } finally {
      this.running = false;
    }
  }
}
