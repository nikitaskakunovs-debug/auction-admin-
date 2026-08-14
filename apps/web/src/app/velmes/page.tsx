import { API_URL } from "@/lib/config";
import type { PublicAuction } from "@/lib/types";
import { Watchlist } from "@/components/Watchlist";

export const dynamic = "force-dynamic";

export const metadata = { title: "Vēlmju saraksts", robots: { index: false } };

export default async function WatchlistPage() {
  let auctions: PublicAuction[] = [];
  try {
    const res = await fetch(`${API_URL}/api/public/auctions?limit=100`, { cache: "no-store" });
    if (res.ok) auctions = ((await res.json()) as { auctions: PublicAuction[] }).auctions;
  } catch {
    // API недоступен — покажем пустой список.
  }
  return <Watchlist auctions={auctions} />;
}
