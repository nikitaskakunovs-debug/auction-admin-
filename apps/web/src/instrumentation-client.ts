import * as Sentry from "@sentry/nextjs";

// Browser error monitoring for the storefront. No-op unless the DSN is
// inlined at build time.
const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;
if (dsn) {
  Sentry.init({ dsn, environment: process.env.NODE_ENV, tracesSampleRate: 0 });
}

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
