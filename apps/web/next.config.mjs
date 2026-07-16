// Plain-JS config: `next start` loads this at runtime, and the production
// image has no TypeScript (dev deps are pruned) — a .ts config would crash it.
import { withSentryConfig } from "@sentry/nextjs";

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
};

// Wrap with Sentry. Without an auth token + org/project (dev/CI) it skips
// source-map upload and just wires client/server error capture — a safe
// no-op when NEXT_PUBLIC_SENTRY_DSN is also unset.
export default withSentryConfig(nextConfig, {
  silent: true,
  telemetry: false,
});
