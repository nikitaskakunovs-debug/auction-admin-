import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { API_URL } from "@/lib/config";
import { resolveCountry, SITE_ORIGINS } from "@/lib/country";
import { alternatesFor } from "@/lib/seo";
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
  const [l, host] = await Promise.all([fetchListing(id), headers().then((h) => h.get("host"))]);
  if (!l) return { title: "Listing" };
  const country = resolveCountry(host);
  const origin = SITE_ORIGINS[country.code];
  const description = `€${(l.priceCents / 100).toFixed(2)} · ${l.description.slice(0, 140) || l.title}`;
  return {
    title: l.title,
    description,
    alternates: alternatesFor(country, `/listing/${id}`),
    // Превью в мессенджерах и соцсетях: фото товара, цена, название (№ 05).
    openGraph: {
      title: l.title,
      description,
      url: `${origin}/listing/${id}`,
      siteName: "Izsoli.lv",
      type: "website",
      ...(l.photos[0] ? { images: [{ url: l.photos[0], width: 1200, height: 900, alt: l.title }] } : {}),
    },
    twitter: {
      card: l.photos[0] ? "summary_large_image" : "summary",
      title: l.title,
      description,
      ...(l.photos[0] ? { images: [l.photos[0]] } : {}),
    },
  };
}

export default async function ListingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [listing, host] = await Promise.all([fetchListing(id), headers().then((h) => h.get("host"))]);
  if (!listing) notFound();
  const origin = SITE_ORIGINS[resolveCountry(host).code];

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
      url: `${origin}/listing/${listing.id}`,
    },
  };

  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdScript(jsonLd) }} />
      <BuyNow listing={listing} />
    </>
  );
}
