// Counts failed sign-ins per client IP in memory. Better Auth's limiter already slows guessing down;
// this only turns a sustained burst into one audit_log entry per window, so admins notice it.
export interface Burst {
  count: number;
  windowMinutes: number;
}

interface Entry {
  start: number;
  count: number;
  reported: boolean;
}

export class SignInFailureTracker {
  readonly #entries = new Map<string, Entry>();
  readonly #threshold: number;
  readonly #windowMs: number;
  readonly #now: () => number;

  constructor(opts: { threshold?: number; windowMinutes?: number; now?: () => number } = {}) {
    this.#threshold = opts.threshold ?? 10;
    this.#windowMs = (opts.windowMinutes ?? 15) * 60_000;
    this.#now = opts.now ?? Date.now;
  }

  /** Records a failure; returns the burst the first time `ip` reaches the threshold in a window. */
  fail(ip: string): Burst | undefined {
    const now = this.#now();
    if (this.#entries.size > 10_000) this.#prune(now);
    let e = this.#entries.get(ip);
    if (!e || now - e.start > this.#windowMs) {
      e = { start: now, count: 0, reported: false };
      this.#entries.set(ip, e);
    }
    e.count++;
    if (e.count < this.#threshold || e.reported) return undefined;
    e.reported = true;
    return { count: e.count, windowMinutes: this.#windowMs / 60_000 };
  }

  #prune(now: number): void {
    for (const [ip, e] of this.#entries) if (now - e.start > this.#windowMs) this.#entries.delete(ip);
  }
}
