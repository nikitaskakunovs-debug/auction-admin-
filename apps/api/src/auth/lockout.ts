import type { Redis } from "ioredis";

/**
 * Per-account login throttling backed by Redis, so it holds across API
 * instances. Consecutive failures on an email accrue toward a ceiling; once
 * hit, the account is locked for a cooldown window regardless of whether the
 * password later becomes correct. A success clears the counter.
 *
 * The lock is keyed by the *email* (the thing being attacked), not the IP, so
 * a distributed credential-stuffing attempt can't dodge it by rotating IPs.
 * Callers must still return a generic error so lockout never reveals whether
 * an account exists.
 */
export class LoginLockout {
  constructor(
    private redis: Redis,
    private maxAttempts: number,
    private lockoutSec: number,
  ) {}

  private key(email: string): string {
    return `login:fail:${email.toLowerCase()}`;
  }

  /** True if this account is currently locked out. */
  async isLocked(email: string): Promise<boolean> {
    const raw = await this.redis.get(this.key(email));
    return raw !== null && Number(raw) >= this.maxAttempts;
  }

  /** Record a failed attempt; returns the running failure count. */
  async recordFailure(email: string): Promise<number> {
    const key = this.key(email);
    const count = await this.redis.incr(key);
    // (Re)arm the sliding expiry on every failure so the window tracks the
    // most recent activity.
    await this.redis.expire(key, this.lockoutSec);
    return count;
  }

  /** Clear the counter after a fully successful authentication. */
  async reset(email: string): Promise<void> {
    await this.redis.del(this.key(email));
  }
}
