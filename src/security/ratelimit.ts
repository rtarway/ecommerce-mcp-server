/** Fixed-window counters keyed by string. Memory is bounded: when full, the oldest keys are dropped. */
export class RateLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly maxKeys = 100_000,
  ) {}

  /** Returns true if the call is within `limit` per `windowMs` for this key (and counts it). */
  allow(key: string, limit: number, windowMs = 60_000): boolean {
    const t = this.now();
    const w = this.windows.get(key);
    if (!w || t - w.start >= windowMs) {
      this.windows.delete(key);
      this.windows.set(key, { start: t, count: 1 });
      this.trim();
      return true;
    }
    w.count += 1;
    return w.count <= limit;
  }

  private trim() {
    while (this.windows.size > this.maxKeys) {
      const oldest = this.windows.keys().next().value;
      if (oldest === undefined) break;
      this.windows.delete(oldest);
    }
  }
}
