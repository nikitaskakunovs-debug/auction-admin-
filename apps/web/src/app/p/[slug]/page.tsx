import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { API_URL } from "@/lib/config";
import { resolveCountry } from "@/lib/country";
import { alternatesFor } from "@/lib/seo";
import { CmsBlocks, type CmsPage } from "@/components/CmsBlocks";
import { pickLocalized } from "@/lib/localized";
import { Crumbs } from "@/components/Crumbs";
import { T } from "@/lib/i18n";

export const dynamic = "force-dynamic";

/** Юридические страницы ведёт CMS. Пока текст не заведён — показываем
 *  оформленную заглушку с контактом вместо 404: ссылки в подвале не должны
 *  упираться в пустоту. Страница при этом закрыта от индексации. */
const TITLES: Record<string, string> = {
  "lietosanas-noteikumi": "Lietošanas noteikumi",
  "privatuma-politika": "Privātuma politika",
  "sikdatnes": "Sīkdatņu politika",
  "sudzibas": "Sūdzību izskatīšana",
  "pieejamiba": "Pieejamība",
  "atteikuma-tiesibas": "Atteikuma tiesības",
};

async function fetchPage(slug: string): Promise<CmsPage | null> {
  try {
    const res = await fetch(`${API_URL}/api/public/pages/${slug}`, { cache: "no-store" });
    if (!res.ok) return null;
    return ((await res.json()) as { page: CmsPage }).page;
  } catch {
    return null;
  }
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const [page, host] = await Promise.all([fetchPage(slug), headers().then((h) => h.get("host"))]);
  if (!page) return { title: TITLES[slug] ?? "Informācija", robots: { index: false } };
  const country = resolveCountry(host);
  // The domain's national language is the canonical SSR language; the client
  // can switch after load. CMS content is authored in lv/ru/en, so et/lt
  // domains fall back to LV via pickLocalized.
  const lang = country.defaultLang;
  return {
    title: page.seo ? pickLocalized(page.seo.title, lang) : pickLocalized(page.title, lang),
    description: page.seo ? pickLocalized(page.seo.description, lang) || undefined : undefined,
    alternates: alternatesFor(country, `/p/${slug}`),
  };
}

export default async function CmsPageRoute({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const page = await fetchPage(slug);
  if (!page) {
    return (
      <section className="wrap" style={{ paddingTop: 24, paddingBottom: 80 }}>
        <Crumbs here={TITLES[slug] ?? "Informācija"} />
        <div className="page-head">
          <div>
            <h1 data-hero>{TITLES[slug] ?? "Informācija"}</h1>
            <p className="cnt"><T k="misc.textInProgress" /></p>
          </div>
        </div>
        <p className="lead" style={{ maxWidth: "52ch" }}>
          Šī dokumenta galīgā redakcija tiek sagatavota. Ja tas ir vajadzīgs jau tagad —
          uzraksti mums, un nosūtīsim to e-pastā.
        </p>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 24 }}>
          <Link className="btn btn-primary" href="/kontakti"><T k="misc.contactUs" /></Link>
          <Link className="btn btn-outline" href="/buj"><T k="f.faq" /></Link>
        </div>
      </section>
    );
  }
  return <CmsBlocks page={page} />;
}
