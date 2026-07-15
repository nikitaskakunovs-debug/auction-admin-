/**
 * Per-country configuration keyed by ccTLD. One codebase, one deployment;
 * the country is detected from the request Host (yoursite.lv/.ee/.lt). Each
 * country has its national language plus Russian and English (design doc),
 * and the three domains reinforce each other via hreflang.
 */

import type { Lang } from "./i18n";

export type Country = "LV" | "EE" | "LT";

export interface CountryConfig {
  code: Country;
  /** ccTLD suffix used to detect the country from the Host header. */
  tld: string;
  /** National language; the default UI language on that domain. */
  defaultLang: Lang;
  /** Languages offered on that domain: national + Russian + English. */
  languages: Lang[];
  /** Market code in the API (matches @auction/domain markets). */
  marketCode: string;
}

export const COUNTRIES: Record<Country, CountryConfig> = {
  LV: { code: "LV", tld: ".lv", defaultLang: "lv", languages: ["lv", "ru", "en"], marketCode: "LV" },
  EE: { code: "EE", tld: ".ee", defaultLang: "et", languages: ["et", "ru", "en"], marketCode: "EE" },
  LT: { code: "LT", tld: ".lt", defaultLang: "lt", languages: ["lt", "ru", "en"], marketCode: "LT" },
};

/** Deploy origins per country — overridable via env for staging. */
export const SITE_ORIGINS: Record<Country, string> = {
  LV: process.env.NEXT_PUBLIC_ORIGIN_LV ?? "https://izsoli.lv",
  EE: process.env.NEXT_PUBLIC_ORIGIN_EE ?? "https://izsoli.lv",
  LT: process.env.NEXT_PUBLIC_ORIGIN_LT ?? "https://izsoli.lv",
};

/** Resolve the country from a Host header; Latvia is the default. */
export function resolveCountry(host: string | null | undefined): CountryConfig {
  const h = (host ?? "").toLowerCase().split(":")[0] ?? "";
  for (const c of Object.values(COUNTRIES)) {
    if (h.endsWith(c.tld)) return c;
  }
  return COUNTRIES.LV;
}

/** Self-referential origin for a request's host (localhost stays http). */
export function originForHost(host: string | null | undefined): string {
  const h = host ?? "localhost:3000";
  const proto = h.startsWith("localhost") || h.startsWith("127.") ? "http" : "https";
  return `${proto}://${h}`;
}
