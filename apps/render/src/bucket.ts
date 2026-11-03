// A token bucket per client address for free (unpaid) renders: `perHour` renders, refilled evenly.
// Paid and ticket renders never take from it.
export class Buckets {
  private readonly tokens = new Map<string, { level: number; at: number }>();
  readonly perHour: number;
  private readonly now: () => number;

  constructor(perHour: number, now: () => number = Date.now) {
    this.perHour = perHour;
    this.now = now;
  }

  private level(key: string): { level: number; at: number } {
    const t = this.now();
    const b = this.tokens.get(key) ?? { level: this.perHour, at: t };
    b.level = Math.min(this.perHour, b.level + ((t - b.at) / 3_600_000) * this.perHour);
    b.at = t;
    return b;
  }

  /** Takes one render for `key`; false when its bucket is empty. */
  take(key: string): boolean {
    if (this.perHour <= 0) return false;
    const b = this.level(key);
    if (b.level < 1) return false;
    b.level -= 1;
    this.tokens.set(key, b);
    if (this.tokens.size > 50_000) this.sweep();
    return true;
  }

  /** Gives back a render that was taken but not done (the lane answered 429). */
  refund(key: string): void {
    const b = this.tokens.get(key);
    if (b) b.level = Math.min(this.perHour, b.level + 1);
  }

  /** Seconds until `key` has one render again. */
  retryAfterS(key: string): number {
    const b = this.level(key);
    if (b.level >= 1) return 0;
    return Math.max(1, Math.ceil(((1 - b.level) * 3_600_000) / this.perHour / 1000));
  }

  /** Drops full buckets (they are the default). */
  sweep(): void {
    for (const [k] of this.tokens) if (this.level(k).level >= this.perHour) this.tokens.delete(k);
  }
}
