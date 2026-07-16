import * as Sentry from "@sentry/nextjs";

// Server-side (Node runtime) error monitoring. No-op unless the DSN was
// provided at build/run time.
const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;
if (dsn) {
  Sentry.init({ dsn, environment: process.env.NODE_ENV, tracesSampleRate: 0 });
}
