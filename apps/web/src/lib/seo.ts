/**
 * SEO metadata helpers for the per-country ccTLD strategy.
 *
 * Each country has its own domain (.lv/.ee/.lt) serving the same app; the
 * three reinforce each other via hreflang so Google understands they are
 * localized siblings, not duplicates. For a given path we emit:
 *   - the national language on each domain (lv/et/lt, unqualified),
 *   - region-qualified ru-XX / en-XX for the shared languages on each domain,
 *   - x-default → the Latvian origin,
 * and a canonical that points at the *current* country's origin.
 */

import type { Metadata } from "next";
import { COUNTRIES, SITE_ORIGINS, type CountryConfig } from "./country";

/**
 * Build the hreflang `languages` map for a path across all country domains.
 * The national language of each domain stays unqualified (lv/et/lt); the
 * shared ru/en are region-qualified (ru-LV, en-EE, …) so each domain's
 * variant is addressable without collisions.
 */
export function hreflangAlternates(path: string): Record<string, string> {
  const languages: Record<string, string> = {};
  for (const c of Object.values(COUNTRIES)) {
    const origin = SITE_ORIGINS[c.code];
    for (const lang of c.languages) {
      const key = lang === c.defaultLang ? lang : `${lang}-${c.code}`;
      languages[key] = `${origin}${path}`;
    }
  }
  languages["x-default"] = `${SITE_ORIGINS.LV}${path}`;
  return languages;
}

/**
 * Canonical + hreflang alternates for a path, anchored to the current
 * country (from the resolved Host). The canonical uses the country's own
 * origin so each domain self-references.
 */
export function alternatesFor(country: CountryConfig, path: string): NonNullable<Metadata["alternates"]> {
  return {
    canonical: `${SITE_ORIGINS[country.code]}${path}`,
    languages: hreflangAlternates(path),
  };
}
