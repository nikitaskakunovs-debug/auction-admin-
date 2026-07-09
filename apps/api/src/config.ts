export interface ApiConfig {
  host: string;
  port: number;
  databaseUrl: string;
  redisUrl: string;
  jwtSecret: string;
  accessTokenTtlSec: number;
  refreshTokenTtlSec: number;
  /** True in production — flips cookie Secure, weak-secret guards, etc. */
  isProduction: boolean;
  /** Exact origins allowed by CORS (the admin panel + storefront hosts). */
  corsOrigins: string[];
  /** Consecutive failed logins (per account) before a temporary lockout. */
  loginMaxAttempts: number;
  /** Lockout window in seconds once the attempt ceiling is hit. */
  loginLockoutSec: number;
  /** Global per-IP request ceiling per minute (coarse DoS protection). */
  rateLimitMax: number;
  /** Issuer shown in the authenticator app for TOTP enrollment. */
  totpIssuer: string;
  paymentDeadlineHours: number;
  /**
   * Dev/staging bid simulation endpoint. The public bidder API is a later
   * phase; production keeps this OFF (shill bidding is explicitly excluded
   * by design — admins must never place bids on behalf of customers).
   */
  allowBidSimulation: boolean;
  schedulerEnabled: boolean;
  /**
   * "live" calls the EU VIES REST service; "simulate" stamps a synthetic
   * consultation (format-valid ⇒ valid) for dev/tests without network.
   */
  viesMode: "live" | "simulate";
  /** Email transport. Only "console" is wired today; SMTP lands with a provider. */
  emailMode: "console";
  /** Hours before the payment deadline to send the unpaid-winner reminder. */
  paymentReminderLeadHours: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const isProduction = env.NODE_ENV === "production";
  // The JWT secret is the entire trust anchor for admin + bidder auth. In
  // production it MUST be provided — never fall back to a source-published
  // value (that would let anyone forge a super_admin token) — and must carry
  // real entropy (a short secret is brute-forceable offline from any token).
  if (isProduction) {
    if (!env.JWT_SECRET) throw new Error("JWT_SECRET must be set in production");
    if (env.JWT_SECRET.length < 32) throw new Error("JWT_SECRET must be at least 32 characters in production");
    if (!env.CORS_ORIGINS) throw new Error("CORS_ORIGINS must be set in production (comma-separated admin/storefront origins)");
  }
  const corsOrigins = (env.CORS_ORIGINS ?? "http://localhost:5173,http://localhost:3000")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
  return {
    host: env.HOST ?? "0.0.0.0",
    port: Number(env.PORT ?? 4000),
    databaseUrl: env.DATABASE_URL ?? "postgres://auction:auction@localhost:5432/auction",
    redisUrl: env.REDIS_URL ?? "redis://localhost:6379",
    jwtSecret: env.JWT_SECRET ?? "dev-secret-change-in-production",
    accessTokenTtlSec: Number(env.ACCESS_TOKEN_TTL_SEC ?? 900),
    refreshTokenTtlSec: Number(env.REFRESH_TOKEN_TTL_SEC ?? 60 * 60 * 24 * 7),
    isProduction,
    corsOrigins,
    loginMaxAttempts: Number(env.LOGIN_MAX_ATTEMPTS ?? 8),
    loginLockoutSec: Number(env.LOGIN_LOCKOUT_SEC ?? 900),
    // Coarse per-IP ceiling. Tests drive many requests from one address, so
    // the limiter is relaxed under NODE_ENV=test (the per-account lockout,
    // which the suite does assert, is unaffected).
    rateLimitMax: Number(env.RATE_LIMIT_MAX ?? (env.NODE_ENV === "test" ? 100_000 : 300)),
    totpIssuer: env.TOTP_ISSUER ?? "Baltic Auctions",
    paymentDeadlineHours: Number(env.PAYMENT_DEADLINE_HOURS ?? 72),
    allowBidSimulation: (env.ALLOW_BID_SIMULATION ?? (env.NODE_ENV === "production" ? "0" : "1")) === "1",
    schedulerEnabled: (env.SCHEDULER_ENABLED ?? "1") === "1",
    viesMode: (env.VIES_MODE ?? (env.NODE_ENV === "production" ? "live" : "simulate")) === "live" ? "live" : "simulate",
    emailMode: "console",
    paymentReminderLeadHours: Number(env.PAYMENT_REMINDER_LEAD_HOURS ?? 24),
  };
}
