import { API_URL } from "@/lib/config";
import type { FixedListing, PublicAuction } from "@/lib/types";
import { HomeSections } from "@/components/HomeSections";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  let auctions: PublicAuction[] = [];
  let listings: FixedListing[] = [];
  try {
    const [aRes, lRes] = await Promise.all([
      fetch(`${API_URL}/api/public/auctions`, { cache: "no-store" }),
      fetch(`${API_URL}/api/public/listings`, { cache: "no-store" }),
    ]);
    if (aRes.ok) auctions = ((await aRes.json()) as { auctions: PublicAuction[] }).auctions;
    if (lRes.ok) listings = ((await lRes.json()) as { listings: FixedListing[] }).listings;
  } catch {
    // API down — render the empty state; the page must never 500 on SSR.
  }
  return <HomeSections auctions={auctions} listings={listings} />;
}
