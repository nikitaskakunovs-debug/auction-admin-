import { API_URL } from "@/lib/config";
import type { PublicAuction } from "@/lib/types";
import { Catalogue } from "@/components/Catalogue";

export const dynamic = "force-dynamic";

/** Поисковая выдача. На неё указывает SearchAction в JSON-LD, поэтому она
 *  живёт отдельным адресом, но показывает тот же каталог с фильтрами. */
export async function generateMetadata({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const { q } = await searchParams;
  return {
    title: q ? `Meklēšana: ${q}` : "Meklēšana",
    robots: { index: false },
  };
}

export default async function SearchPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const { q } = await searchParams;
  let auctions: PublicAuction[] = [];
  try {
    const url = `${API_URL}/api/public/auctions?limit=100${q ? `&q=${encodeURIComponent(q)}` : ""}`;
    const res = await fetch(url, { cache: "no-store" });
    if (res.ok) auctions = ((await res.json()) as { auctions: PublicAuction[] }).auctions;
  } catch {
    // API недоступен — покажем пустую выдачу.
  }
  return <Catalogue auctions={auctions} heading={q ? `Meklēšana: ${q}` : "Meklēšana"} />;
}
