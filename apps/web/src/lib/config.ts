/** Server-side base URL of the auction API (SSR fetches). */
export const API_URL = process.env.API_URL ?? "http://localhost:4000";

/** Browser-side base URL (REST + WebSocket host). */
export const PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

/** Canonical site origin used for SEO tags; per-country domains are a
 * deployment concern (.lv/.ee/.lt point at the same app). */
export const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
