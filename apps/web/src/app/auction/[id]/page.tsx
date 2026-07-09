import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { API_URL } from "@/lib/config";
import { resolveCountry, SITE_ORIGINS } from "@/lib/country";
import { alternatesFor } from "@/lib/seo";
import { jsonLdScript } from "@/lib/jsonld";
import type { AuctionDetail } from "@/lib/types";
import { LiveAuction } from "@/components/LiveAuction";

export const dynamic = "force-dynamic";

async function fetchDetail(id: string): Promise<AuctionDetail | null> {
  try {
    const res = await fetch(`${API_URL}/api/public/auctions/${id}`, { cache: "no-store" });
    if (!res.ok) return null;
    return (await res.json()) as AuctionDetail;
  } catch {
    return null;
  }
}

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const [detail, host] = await Promise.all([fetchDetail(id), headers().then((h) => h.get("host"))]);
  if (!detail) return { title: "Auction" };
  const country = resolveCountry(host);
  return {
    title: detail.auction.title,
    description: detail.auction.description.slice(0, 160) || `Live auction: ${detail.auction.title}`,
    alternates: alternatesFor(country, `/auction/${id}`),
  };
}

export default async function AuctionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [detail, host] = await Promise.all([fetchDetail(id), headers().then((h) => h.get("host"))]);
  if (!detail) notFound();
  const origin = SITE_ORIGINS[resolveCountry(host).code];

  const a = detail.auction;
  // Structured data for rich results (design doc: JSON-LD on listings).
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "Product",
    name: a.title,
    sku: a.sku,
    description: a.description,
    offers: {
      "@type": "Offer",
      priceCurrency: "EUR",
      price: ((a.currentPriceCents ?? a.startPriceCents ?? 0) / 100).toFixed(2),
      availability: a.status === "live" ? "https://schema.org/InStock" : "https://schema.org/SoldOut",
      url: `${origin}/auction/${a.id}`,
    },
  };

  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdScript(jsonLd) }} />
      <LiveAuction initial={detail} />
    </>
  );
}
