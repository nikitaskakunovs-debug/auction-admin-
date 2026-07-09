/** Server-side base URL of the auction API (SSR fetches). */
export const API_URL = process.env.API_URL ?? "http://localhost:4000";

/** Browser-side base URL (REST + WebSocket host). */
export const PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

/**
 * Fallback single origin. SEO canonicals/hreflang are now derived per request
 * from the Host header via lib/country.ts (SITE_ORIGINS + originForHost), so
 * the .lv/.ee/.lt domains self-reference; this stays as a generic default.
 */
export const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
