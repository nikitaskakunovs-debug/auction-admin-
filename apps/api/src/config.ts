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
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
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
  };
}
