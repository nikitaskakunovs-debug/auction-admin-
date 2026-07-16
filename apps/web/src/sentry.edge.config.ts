import * as Sentry from "@sentry/nextjs";

// Edge runtime error monitoring (middleware / edge routes).
const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;
if (dsn) {
  Sentry.init({ dsn, environment: process.env.NODE_ENV, tracesSampleRate: 0 });
}
