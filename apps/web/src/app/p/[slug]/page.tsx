import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { API_URL } from "@/lib/config";
import { CmsBlocks, type CmsPage } from "@/components/CmsBlocks";

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
  const page = await fetchPage(slug);
  if (!page) return { title: "Page" };
  // Latvian is the canonical SSR language; the client can switch after load.
  return {
    title: page.seo?.title.lv || page.title.lv || page.title.en,
    description: page.seo?.description.lv || undefined,
    alternates: { canonical: `/p/${slug}` },
  };
}

export default async function CmsPageRoute({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const page = await fetchPage(slug);
  if (!page) notFound();
  return <CmsBlocks page={page} />;
}
