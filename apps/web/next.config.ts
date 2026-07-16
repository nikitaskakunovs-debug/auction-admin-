import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";

const nextConfig: NextConfig = {
  reactStrictMode: true,
};

// Wrap with Sentry. Without an auth token + org/project (dev/CI) it skips
// source-map upload and just wires client/server error capture — a safe
// no-op when NEXT_PUBLIC_SENTRY_DSN is also unset.
export default withSentryConfig(nextConfig, {
  silent: true,
  telemetry: false,
});
