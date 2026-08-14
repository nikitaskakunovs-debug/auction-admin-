import { API_URL } from "@/lib/config";
import type { AdCard, FixedListing, PublicAuction } from "@/lib/types";
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
  let listings: FixedListing[] = [];
  let ads: AdCard[] = [];
  const tail = `limit=100${q ? `&q=${encodeURIComponent(q)}` : ""}`;
  try {
    // Поиск тоже искал только по аукционам: лот «Купить сразу» найти было нельзя.
    const [aRes, lRes] = await Promise.all([
      fetch(`${API_URL}/api/public/auctions?${tail}`, { cache: "no-store" }),
      fetch(`${API_URL}/api/public/listings?${tail}`, { cache: "no-store" }),
    ]);
    if (aRes.ok) auctions = ((await aRes.json()) as { auctions: PublicAuction[] }).auctions;
    if (lRes.ok) listings = ((await lRes.json()) as { listings: FixedListing[] }).listings;
    // Реклама не должна ронять каталог: не пришла — просто её нет.
    const adRes = await fetch(`${API_URL}/api/public/ads`, { cache: "no-store" });
    if (adRes.ok) ads = ((await adRes.json()) as { ads: AdCard[] }).ads;
  } catch {
    // API недоступен — покажем пустую выдачу.
  }
  return <Catalogue auctions={auctions} listings={listings} ads={ads} heading={q ? `Meklēšana: ${q}` : "Meklēšana"} />;
}
