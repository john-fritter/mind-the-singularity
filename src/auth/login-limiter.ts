/**
 * Counts failed logins per account name and refuses further attempts once a
 * name passes the limit, until its window expires. In memory: a restart
 * resets it, which is acceptable for one process. Fritter Board's, as it is.
 */
export class LoginLimiter {
  private failures = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly maxFailures: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  private key(name: string): string {
    return name.trim().toLowerCase();
  }

  isBlocked(name: string): boolean {
    const entry = this.failures.get(this.key(name));
    if (!entry) return false;
    if (entry.resetAt <= this.now()) {
      this.failures.delete(this.key(name));
      return false;
    }
    return entry.count >= this.maxFailures;
  }

  recordFailure(name: string): void {
    const key = this.key(name);
    const entry = this.failures.get(key);
    if (!entry || entry.resetAt <= this.now()) {
      this.failures.set(key, { count: 1, resetAt: this.now() + this.windowMs });
    } else {
      entry.count += 1;
    }
  }

  recordSuccess(name: string): void {
    this.failures.delete(this.key(name));
  }
}
