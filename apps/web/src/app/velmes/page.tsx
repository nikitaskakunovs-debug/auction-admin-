import { API_URL } from "@/lib/config";
import type { FixedListing, PublicAuction } from "@/lib/types";
import { Watchlist } from "@/components/Watchlist";

export const dynamic = "force-dynamic";

export const metadata = { title: "Vēlmju saraksts", robots: { index: false } };

export default async function WatchlistPage() {
  let auctions: PublicAuction[] = [];
  let listings: FixedListing[] = [];
  try {
    // Сохранённый лот «Купить сразу» раньше исчезал из списка: сюда грузились
    // только аукционы, и он молча попадал в «больше не продаётся».
    const [aRes, lRes] = await Promise.all([
      fetch(`${API_URL}/api/public/auctions?limit=100`, { cache: "no-store" }),
      fetch(`${API_URL}/api/public/listings?limit=100`, { cache: "no-store" }),
    ]);
    if (aRes.ok) auctions = ((await aRes.json()) as { auctions: PublicAuction[] }).auctions;
    if (lRes.ok) listings = ((await lRes.json()) as { listings: FixedListing[] }).listings;
  } catch {
    // API недоступен — покажем пустой список.
  }
  return <Watchlist auctions={auctions} listings={listings} />;
}
