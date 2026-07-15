import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { API_URL } from "@/lib/config";
import { resolveCountry } from "@/lib/country";
import { alternatesFor } from "@/lib/seo";
import { CmsBlocks, pickLocalized, type CmsPage } from "@/components/CmsBlocks";

export const dynamic = "force-dynamic";

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
  if (!page) return { title: "Page" };
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
  if (!page) notFound();
  return <CmsBlocks page={page} />;
}
