import { API_URL } from "@/lib/config";
import type { PublicAuction } from "@/lib/types";
import { LiveRoom } from "@/components/LiveRoom";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Tiešraide",
  description: "Izsole tiešraidē: lotus izsauc pa vienam, solī pret zāli.",
};

export default async function LivePage() {
  let auctions: PublicAuction[] = [];
  try {
    const res = await fetch(`${API_URL}/api/public/auctions`, { cache: "no-store" });
    if (res.ok) auctions = ((await res.json()) as { auctions: PublicAuction[] }).auctions;
  } catch {
    // API недоступен — покажем пустой зал, страница не должна падать на SSR.
  }
  return <LiveRoom auctions={auctions} />;
}
