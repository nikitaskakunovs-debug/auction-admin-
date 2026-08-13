import { API_URL } from "@/lib/config";
import type { PublicAuction } from "@/lib/types";
import { Results } from "@/components/Results";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Izsoļu rezultāti",
  description: "Noslēgušos izsoļu rezultāti: par cik lots tika pārdots un cik bija solījumu.",
};

export default async function ResultsPage() {
  let auctions: PublicAuction[] = [];
  try {
    const res = await fetch(`${API_URL}/api/public/auctions?status=ended&limit=100`, { cache: "no-store" });
    if (res.ok) auctions = ((await res.json()) as { auctions: PublicAuction[] }).auctions;
  } catch {
    // API недоступен — покажем пустое состояние, страница не должна падать.
  }
  return <Results auctions={auctions} />;
}
