import * as Sentry from "@sentry/react";

/**
 * Browser error monitoring for the admin SPA. A no-op unless VITE_SENTRY_DSN
 * was provided at build time (it's inlined into the bundle) — so local dev
 * builds never report. Captures unhandled errors + promise rejections.
 */
export function initSentry(): void {
  const dsn = import.meta.env.VITE_SENTRY_DSN;
  if (!dsn) return;
  Sentry.init({
    dsn,
    environment: import.meta.env.MODE,
    release: import.meta.env.VITE_SENTRY_RELEASE || undefined,
  });
}
