import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { API_URL, SITE_URL } from "@/lib/config";
import { jsonLdScript } from "@/lib/jsonld";
import type { FixedListing } from "@/lib/types";
import { BuyNow } from "@/components/BuyNow";

export const dynamic = "force-dynamic";

async function fetchListing(id: string): Promise<FixedListing | null> {
  try {
    const res = await fetch(`${API_URL}/api/public/listings/${id}`, { cache: "no-store" });
    if (!res.ok) return null;
    return ((await res.json()) as { listing: FixedListing }).listing;
  } catch {
    return null;
  }
}

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const l = await fetchListing(id);
  if (!l) return { title: "Listing" };
  return {
    title: l.title,
    description: l.description.slice(0, 160) || `Buy now: ${l.title}`,
    alternates: { canonical: `/listing/${id}` },
  };
}

export default async function ListingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const listing = await fetchListing(id);
  if (!listing) notFound();

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "Product",
    name: listing.title,
    sku: listing.sku,
    description: listing.description,
    offers: {
      "@type": "Offer",
      priceCurrency: "EUR",
      price: (listing.priceCents / 100).toFixed(2),
      availability: listing.soldOut ? "https://schema.org/SoldOut" : "https://schema.org/InStock",
      url: `${SITE_URL}/listing/${listing.id}`,
    },
  };

  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdScript(jsonLd) }} />
      <BuyNow listing={listing} />
    </>
  );
}
