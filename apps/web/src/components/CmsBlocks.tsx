"use client";

import { useT, type Lang } from "@/lib/i18n";

export type Localized = { lv: string; ru: string; en: string };
export type CmsBlock =
  | { type: "heading"; text: Localized }
  | { type: "text"; text: Localized }
  | { type: "image"; url: string; alt: Localized }
  | { type: "faq"; question: Localized; answer: Localized }
  | { type: "divider" };

export interface CmsPage {
  slug: string;
  title: Localized;
  blocks: CmsBlock[];
  seo: { title: Localized; description: Localized } | null;
  updatedAt: string;
}

/**
 * Localized value with fallback: requested language → LV (house language) → EN.
 * CMS content is authored in lv/ru/en only; on the et/lt domains (whose
 * languages aren't Localized keys) this falls back to LV.
 */
export function pickLocalized(l: Localized, lang: Lang): string {
  return (l as Record<string, string>)[lang] || l.lv || l.en;
}

export function CmsBlocks({ page }: { page: CmsPage }) {
  const { lang } = useT();
  return (
    <article style={{ maxWidth: 720, margin: "0 auto", display: "grid", gap: 4 }}>
      <h1 style={{ fontSize: 28, fontWeight: 700, letterSpacing: "-0.02em", margin: "0 0 10px" }}>
        {pickLocalized(page.title, lang)}
      </h1>
      {page.blocks.map((b, i) => {
        switch (b.type) {
          case "heading":
            return (
              <h2 key={i} style={{ fontSize: 19, fontWeight: 700, letterSpacing: "-0.01em", margin: "18px 0 4px" }}>
                {pickLocalized(b.text, lang)}
              </h2>
            );
          case "text":
            return (
              <p key={i} style={{ fontSize: 15, lineHeight: 1.7, color: "#333330", margin: "6px 0", whiteSpace: "pre-line" }}>
                {pickLocalized(b.text, lang)}
              </p>
            );
          case "image":
            return b.url ? (
              // CMS images are editor-provided URLs; dimensions unknown at build time.
              // eslint-disable-next-line @next/next/no-img-element
              <img key={i} src={b.url} alt={pickLocalized(b.alt, lang)} style={{ maxWidth: "100%", borderRadius: 12, margin: "10px 0" }} />
            ) : null;
          case "faq":
            return (
              <details key={i} style={{ background: "#fff", border: "1px solid rgba(10,10,10,0.10)", borderRadius: 12, padding: "12px 16px", margin: "6px 0" }}>
                <summary style={{ fontWeight: 700, fontSize: 14.5, cursor: "pointer" }}>{pickLocalized(b.question, lang)}</summary>
                <p style={{ fontSize: 14, lineHeight: 1.65, color: "#333330", margin: "10px 0 2px", whiteSpace: "pre-line" }}>
                  {pickLocalized(b.answer, lang)}
                </p>
              </details>
            );
          case "divider":
            return <hr key={i} style={{ border: 0, borderTop: "1px solid rgba(10,10,10,0.10)", margin: "16px 0" }} />;
          default:
            return null;
        }
      })}
    </article>
  );
}
