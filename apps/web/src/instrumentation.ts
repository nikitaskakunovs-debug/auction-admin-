// Next.js server instrumentation hook — loads the right Sentry config per
// runtime. Inert when NEXT_PUBLIC_SENTRY_DSN is unset (the init self-skips).
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./sentry.server.config");
  }
  if (process.env.NEXT_RUNTIME === "edge") {
    await import("./sentry.edge.config");
  }
}

export { captureRequestError as onRequestError } from "@sentry/nextjs";
