import { API_URL } from "@/lib/config";
import type { FixedListing, PublicAuction } from "@/lib/types";
import { Catalogue } from "@/components/Catalogue";

export const dynamic = "force-dynamic";

export const metadata = { title: "Katalogs" };

export default async function CataloguePage() {
  let auctions: PublicAuction[] = [];
  let listings: FixedListing[] = [];
  try {
    // Оба типа: до этого каталог грузил только аукционы, и лоты «Купить сразу»
    // не показывались в нём вообще — даже по ссылке «?type=fixed» из макета.
    const [aRes, lRes] = await Promise.all([
      fetch(`${API_URL}/api/public/auctions`, { cache: "no-store" }),
      fetch(`${API_URL}/api/public/listings`, { cache: "no-store" }),
    ]);
    if (aRes.ok) auctions = ((await aRes.json()) as { auctions: PublicAuction[] }).auctions;
    if (lRes.ok) listings = ((await lRes.json()) as { listings: FixedListing[] }).listings;
  } catch {
    // API down — отдаём пустой каталог, страница не должна падать на SSR.
  }
  return <Catalogue auctions={auctions} listings={listings} />;
}
