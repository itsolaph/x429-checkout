// Spending limits for the demo agents: at most N joins per rolling hour and at most X USDC per
// rolling day, across all demo wallets. Pure (clock injected) so it can be unit-tested.

export type BudgetDecision = { ok: true } | { ok: false; reason: "joins_per_hour" | "usdc_per_day"; retryInMs: number };

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export class DemoBudget {
  private readonly joins: number[] = [];
  private readonly spends: { t: number; amount: bigint }[] = [];
  readonly maxJoinsPerHour: number;
  readonly maxSpendPerDay: bigint;
  private readonly now: () => number;

  constructor(maxJoinsPerHour: number, maxSpendPerDay: bigint, now: () => number = Date.now) {
    this.maxJoinsPerHour = maxJoinsPerHour;
    this.maxSpendPerDay = maxSpendPerDay;
    this.now = now;
  }

  private prune(t: number): void {
    while (this.joins.length && this.joins[0]! <= t - HOUR) this.joins.shift();
    while (this.spends.length && this.spends[0]!.t <= t - DAY) this.spends.shift();
  }

  spentToday(): bigint {
    this.prune(this.now());
    return this.spends.reduce((s, x) => s + x.amount, 0n);
  }

  joinsThisHour(): number {
    this.prune(this.now());
    return this.joins.length;
  }

  /** May one more join costing `fee` happen now? */
  canJoin(fee: bigint): BudgetDecision {
    const t = this.now();
    this.prune(t);
    if (this.joins.length >= this.maxJoinsPerHour) return { ok: false, reason: "joins_per_hour", retryInMs: this.joins[0]! + HOUR - t };
    if (this.spentToday() + fee > this.maxSpendPerDay) {
      return { ok: false, reason: "usdc_per_day", retryInMs: this.spends.length ? this.spends[0]!.t + DAY - t : DAY };
    }
    return { ok: true };
  }

  record(fee: bigint): void {
    const t = this.now();
    this.joins.push(t);
    this.spends.push({ t, amount: fee });
  }
}

/** A wallet that cannot pay `fee` while keeping `minBalance` is out of the demo. */
export function walletLow(balance: bigint, fee: bigint, minBalance: bigint): boolean {
  return balance < fee || balance - fee < minBalance;
}
