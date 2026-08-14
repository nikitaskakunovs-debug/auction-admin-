import { API_URL } from "@/lib/config";
import type { PublicAuction } from "@/lib/types";
import { Catalogue } from "@/components/Catalogue";

export const dynamic = "force-dynamic";

export const metadata = { title: "Katalogs" };

export default async function CataloguePage() {
  let auctions: PublicAuction[] = [];
  try {
    const res = await fetch(`${API_URL}/api/public/auctions`, { cache: "no-store" });
    if (res.ok) auctions = ((await res.json()) as { auctions: PublicAuction[] }).auctions;
  } catch {
    // API down — отдаём пустой каталог, страница не должна падать на SSR.
  }
  return <Catalogue auctions={auctions} />;
}
