"use client";

import { useT } from "@/lib/i18n";
import { pickLocalized, type Localized } from "@/lib/localized";
import { Crumbs } from "@/components/Crumbs";

export type { Localized };
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

export function CmsBlocks({ page }: { page: CmsPage }) {
  const { lang } = useT();
  return (
    <section className="wrap" style={{ paddingTop: 24 }}>
      <Crumbs here={pickLocalized(page.title, lang)} />

      <div className="page-head">
        <div><h1 data-hero>{pickLocalized(page.title, lang)}</h1></div>
      </div>

      <article className="prose">
        {page.blocks.map((b, i) => {
          switch (b.type) {
            case "heading":
              return <h2 key={i}>{pickLocalized(b.text, lang)}</h2>;
            case "text":
              return <p key={i} style={{ whiteSpace: "pre-line" }}>{pickLocalized(b.text, lang)}</p>;
            case "image":
              return b.url ? (
                // Картинки из CMS — произвольные URL, размеры на сборке неизвестны.
                // eslint-disable-next-line @next/next/no-img-element
                <img key={i} src={b.url} alt={pickLocalized(b.alt, lang)} loading="lazy" />
              ) : null;
            case "faq":
              return (
                <details className="q" key={i}>
                  <summary>{pickLocalized(b.question, lang)}</summary>
                  <p className="a" style={{ whiteSpace: "pre-line" }}>{pickLocalized(b.answer, lang)}</p>
                </details>
              );
            case "divider":
              return <hr key={i} />;
            default:
              return null;
          }
        })}
      </article>
    </section>
  );
}
