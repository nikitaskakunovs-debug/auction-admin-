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
  /** Email transport: console (dev) or smtp (any relay / self-hosted sender). */
  emailMode: "console" | "smtp";
  smtp: { host: string; port: number; secure: boolean; user: string; pass: string; from: string } | null;
  /** Honor X-Forwarded-For — MUST be on behind Caddy/nginx, off when exposed directly. */
  trustProxy: boolean;
  /** Hours before the payment deadline to send the unpaid-winner reminder. */
  paymentReminderLeadHours: number;
  /**
   * Item-photo storage. "local" writes beneath uploadDir and the API serves
   * the files at /uploads; "s3" targets any S3-compatible endpoint
   * (DigitalOcean Spaces in production).
   */
  storageDriver: "local" | "s3";
  /** Local-driver directory (relative to the process cwd unless absolute). */
  uploadDir: string;
  /** Origin used to mint public photo URLs for the local driver. */
  publicBaseUrl: string;
  s3: {
    endpoint: string;
    region: string;
    bucket: string;
    accessKeyId: string;
    secretAccessKey: string;
    /** Public origin of the bucket/CDN, e.g. https://photos.fra1.cdn.digitaloceanspaces.com */
    publicUrl: string;
  } | null;
  /** Per-file upload ceiling in bytes. */
  maxPhotoBytes: number;
  /**
   * Klix hosted-checkout payments (BNPL, banklinks, cards). "off" hides the
   * pay button entirely (pre-contract state); "live" calls portal.klix.app
   * with the merchant credentials (Klix test credentials also use "live" —
   * the test brand is just a different key pair); "simulate" is an in-memory
   * driver for the test suite.
   */
  klixMode: "off" | "live" | "simulate";
  klix: {
    apiUrl: string;
    brandId: string;
    secretKey: string;
    /** Optional payment_method_whitelist; empty = all methods enabled on the brand. */
    methods: string[];
  } | null;
  /** Storefront origin used for post-checkout redirects (success/failure/cancel). */
  storefrontBaseUrl: string;
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
  const port = Number(env.PORT ?? 4000);
  const emailMode: "console" | "smtp" = env.EMAIL_MODE === "smtp" ? "smtp" : "console";
  if (emailMode === "smtp") {
    for (const key of ["SMTP_HOST", "EMAIL_FROM"] as const) {
      if (!env[key]) throw new Error(`${key} must be set when EMAIL_MODE=smtp`);
    }
  }
  const klixMode: "off" | "live" | "simulate" =
    env.KLIX_MODE === "live" ? "live" : env.KLIX_MODE === "simulate" ? "simulate" : "off";
  if (klixMode === "live") {
    for (const key of ["KLIX_BRAND_ID", "KLIX_SECRET_KEY"] as const) {
      if (!env[key]) throw new Error(`${key} must be set when KLIX_MODE=live`);
    }
  }
  const storageDriver: "local" | "s3" = env.STORAGE_DRIVER === "s3" ? "s3" : "local";
  if (storageDriver === "s3") {
    for (const key of ["S3_BUCKET", "S3_ACCESS_KEY", "S3_SECRET_KEY", "S3_PUBLIC_URL"] as const) {
      if (!env[key]) throw new Error(`${key} must be set when STORAGE_DRIVER=s3`);
    }
  }
  return {
    host: env.HOST ?? "0.0.0.0",
    port,
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
    totpIssuer: env.TOTP_ISSUER ?? "Izsoli.lv",
    paymentDeadlineHours: Number(env.PAYMENT_DEADLINE_HOURS ?? 72),
    allowBidSimulation: (env.ALLOW_BID_SIMULATION ?? (env.NODE_ENV === "production" ? "0" : "1")) === "1",
    schedulerEnabled: (env.SCHEDULER_ENABLED ?? "1") === "1",
    viesMode: (env.VIES_MODE ?? (env.NODE_ENV === "production" ? "live" : "simulate")) === "live" ? "live" : "simulate",
    emailMode,
    smtp:
      emailMode === "smtp"
        ? {
            host: env.SMTP_HOST ?? "",
            port: Number(env.SMTP_PORT ?? 587),
            secure: (env.SMTP_SECURE ?? "0") === "1",
            user: env.SMTP_USER ?? "",
            pass: env.SMTP_PASS ?? "",
            from: env.EMAIL_FROM ?? "",
          }
        : null,
    // Behind the bundled Caddy proxy in production; direct exposure in dev.
    trustProxy: (env.TRUST_PROXY ?? (isProduction ? "1" : "0")) === "1",
    paymentReminderLeadHours: Number(env.PAYMENT_REMINDER_LEAD_HOURS ?? 24),
    storageDriver,
    uploadDir: env.UPLOAD_DIR ?? "var/uploads",
    publicBaseUrl: (env.PUBLIC_BASE_URL ?? `http://localhost:${port}`).replace(/\/$/, ""),
    s3:
      storageDriver === "s3"
        ? {
            endpoint: env.S3_ENDPOINT ?? "",
            region: env.S3_REGION ?? "us-east-1",
            bucket: env.S3_BUCKET ?? "",
            accessKeyId: env.S3_ACCESS_KEY ?? "",
            secretAccessKey: env.S3_SECRET_KEY ?? "",
            publicUrl: (env.S3_PUBLIC_URL ?? "").replace(/\/$/, ""),
          }
        : null,
    maxPhotoBytes: Number(env.MAX_PHOTO_BYTES ?? 15 * 1024 * 1024),
    klixMode,
    klix:
      klixMode === "off"
        ? null
        : {
            apiUrl: (env.KLIX_API_URL ?? "https://portal.klix.app/api/v1").replace(/\/$/, ""),
            brandId: env.KLIX_BRAND_ID ?? "",
            secretKey: env.KLIX_SECRET_KEY ?? "",
            methods: (env.KLIX_METHODS ?? "")
              .split(",")
              .map((m) => m.trim())
              .filter(Boolean),
          },
    // Post-checkout redirect target. Production compose sets https://<DOMAIN>;
    // dev falls back to the Next.js storefront.
    storefrontBaseUrl: (env.STOREFRONT_BASE_URL ?? "http://localhost:3000").replace(/\/$/, ""),
  };
}
