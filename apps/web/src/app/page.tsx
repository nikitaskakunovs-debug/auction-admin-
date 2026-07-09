import { API_URL } from "@/lib/config";
import type { PublicAuction } from "@/lib/types";
import { HomeSections } from "@/components/HomeSections";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  let auctions: PublicAuction[] = [];
  try {
    const res = await fetch(`${API_URL}/api/public/auctions`, { cache: "no-store" });
    if (res.ok) auctions = ((await res.json()) as { auctions: PublicAuction[] }).auctions;
  } catch {
    // API down — render the empty state; the page must never 500 on SSR.
  }
  return <HomeSections auctions={auctions} />;
}
