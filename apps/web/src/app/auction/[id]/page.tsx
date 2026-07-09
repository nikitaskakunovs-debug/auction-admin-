import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { API_URL, SITE_URL } from "@/lib/config";
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
  const detail = await fetchDetail(id);
  if (!detail) return { title: "Auction" };
  return {
    title: detail.auction.title,
    description: detail.auction.description.slice(0, 160) || `Live auction: ${detail.auction.title}`,
    alternates: { canonical: `/auction/${id}` },
  };
}

/**
 * Escape a JSON string for safe embedding inside a <script> element.
 * JSON.stringify does NOT escape "<", ">" or "&", so a "</script>" sequence in
 * any embedded (admin-entered) value would break out of the element. Also
 * escape U+2028/U+2029, which are valid JSON but illegal raw in JS string
 * literals. Every HTML-significant char becomes a \uXXXX escape.
 */
function escapeJsonForScript(json: string): string {
  return json.replace(/[<>&\u2028\u2029]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
}

export default async function AuctionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const detail = await fetchDetail(id);
  if (!detail) notFound();

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
      url: `${SITE_URL}/auction/${a.id}`,
    },
  };

  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: escapeJsonForScript(JSON.stringify(jsonLd)) }} />
      <LiveAuction initial={detail} />
    </>
  );
}
