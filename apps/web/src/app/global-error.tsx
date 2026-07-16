"use client";

import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";

/**
 * Last-resort error boundary for the App Router — reports React rendering
 * crashes to Sentry (a no-op when Sentry isn't initialised) and shows a
 * minimal fallback. Replaces the whole document, so it renders its own
 * <html>/<body>.
 */
export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui, sans-serif", padding: "48px", textAlign: "center", color: "#0A0A0A" }}>
        <h2 style={{ fontSize: 20, fontWeight: 700 }}>Something went wrong</h2>
        <p style={{ color: "#6B6B68", fontSize: 14 }}>
          Please refresh the page or try again shortly.
        </p>
      </body>
    </html>
  );
}
