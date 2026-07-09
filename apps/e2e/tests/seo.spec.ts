import { expect, test } from "@playwright/test";

/**
 * Per-country ccTLD SEO. One deployment serves .lv/.ee/.lt; the country is
 * resolved from the request Host header, which drives the <html lang>, the
 * offered UI languages, and the canonical/hreflang alternates. These checks
 * hit the SSR HTML directly with a spoofed Host (no browser needed).
 *
 * Note: React renders the attribute as `hrefLang` (camelCase) and Next may
 * normalize away a trailing slash, so the assertions are case-insensitive and
 * tolerate an optional trailing slash.
 */

const LV_ORIGIN = "https://baltic-auctions.lv";
const EE_ORIGIN = "https://baltic-auctions.ee";
const LT_ORIGIN = "https://baltic-auctions.lt";

test("SEO: Latvian domain renders lv and cross-links its ccTLD siblings", async ({ request }) => {
  const res = await request.get("/", { headers: { host: "www.baltic-auctions.lv" } });
  expect(res.ok()).toBeTruthy();
  const html = await res.text();

  // The .lv domain's national language drives <html lang>.
  expect(html).toMatch(/<html[^>]*\blang="lv"/);

  // hreflang alternates reinforce the three ccTLD siblings + x-default.
  expect(html).toMatch(/hreflang="lv"/i);
  expect(html).toMatch(/hreflang="et"/i);
  expect(html).toMatch(/hreflang="lt"/i);
  expect(html).toMatch(/hreflang="x-default"/i);
  expect(html).toContain(EE_ORIGIN);
  expect(html).toContain(LT_ORIGIN);

  // The canonical self-references the current country's own origin.
  expect(html).toMatch(new RegExp(`rel="canonical"[^>]*href="${LV_ORIGIN}/?"`));
});

test("SEO: Estonian domain renders et as the default language", async ({ request }) => {
  const res = await request.get("/", { headers: { host: "shop.baltic-auctions.ee" } });
  const html = await res.text();
  expect(html).toMatch(/<html[^>]*\blang="et"/);
  // Estonia's canonical points at the .ee origin.
  expect(html).toMatch(new RegExp(`rel="canonical"[^>]*href="${EE_ORIGIN}/?"`));
});

test("SEO: unknown host falls back to Latvia", async ({ request }) => {
  const res = await request.get("/", { headers: { host: "localhost:3000" } });
  const html = await res.text();
  expect(html).toMatch(/<html[^>]*\blang="lv"/);
});

test("SEO: robots.txt sitemap self-references the request host origin", async ({ request }) => {
  const res = await request.get("/robots.txt", { headers: { host: "www.baltic-auctions.ee" } });
  const body = await res.text();
  expect(body).toContain("Sitemap: https://www.baltic-auctions.ee/sitemap.xml");
});
