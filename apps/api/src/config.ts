export interface ApiConfig {
  host: string;
  port: number;
  databaseUrl: string;
  redisUrl: string;
  jwtSecret: string;
  accessTokenTtlSec: number;
  refreshTokenTtlSec: number;
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
  // The JWT secret is the entire trust anchor for admin + bidder auth. In
  // production it MUST be provided — never fall back to a source-published
  // value (that would let anyone forge a super_admin token).
  if (env.NODE_ENV === "production" && !env.JWT_SECRET) {
    throw new Error("JWT_SECRET must be set in production");
  }
  return {
    host: env.HOST ?? "0.0.0.0",
    port: Number(env.PORT ?? 4000),
    databaseUrl: env.DATABASE_URL ?? "postgres://auction:auction@localhost:5432/auction",
    redisUrl: env.REDIS_URL ?? "redis://localhost:6379",
    jwtSecret: env.JWT_SECRET ?? "dev-secret-change-in-production",
    accessTokenTtlSec: Number(env.ACCESS_TOKEN_TTL_SEC ?? 900),
    refreshTokenTtlSec: Number(env.REFRESH_TOKEN_TTL_SEC ?? 60 * 60 * 24 * 30),
    paymentDeadlineHours: Number(env.PAYMENT_DEADLINE_HOURS ?? 72),
    allowBidSimulation: (env.ALLOW_BID_SIMULATION ?? (env.NODE_ENV === "production" ? "0" : "1")) === "1",
    schedulerEnabled: (env.SCHEDULER_ENABLED ?? "1") === "1",
    viesMode: (env.VIES_MODE ?? (env.NODE_ENV === "production" ? "live" : "simulate")) === "live" ? "live" : "simulate",
    emailMode: "console",
    paymentReminderLeadHours: Number(env.PAYMENT_REMINDER_LEAD_HOURS ?? 24),
  };
}
