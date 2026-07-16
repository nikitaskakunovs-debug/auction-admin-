import * as Sentry from "@sentry/node";

/**
 * Sentry error monitoring for the API. Imported as the VERY FIRST thing in
 * index.ts so the SDK can auto-instrument the runtime before other modules
 * load. A pure no-op unless SENTRY_DSN is set — so dev and the whole test
 * suite never touch Sentry. Errors only (tracesSampleRate 0 = no perf
 * sampling overhead).
 */
const dsn = process.env.SENTRY_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV ?? "production",
    release: process.env.SENTRY_RELEASE || undefined,
    tracesSampleRate: 0,
  });
}

export const sentryEnabled = Boolean(dsn);
