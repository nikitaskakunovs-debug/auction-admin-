import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { API_URL } from "@/lib/config";
import { resolveCountry, SITE_ORIGINS } from "@/lib/country";
import { alternatesFor } from "@/lib/seo";
import { jsonLdScript } from "@/lib/jsonld";
import type { AuctionDetail, PublicAuction } from "@/lib/types";
import { LotPage } from "@/components/LotPage";

export const dynamic = "force-dynamic";

/** Похожие лоты той же категории — блок «Vēl šajā kategorijā» из макета. */
async function fetchRelated(category: string, exceptId: string): Promise<PublicAuction[]> {
  try {
    const res = await fetch(`${API_URL}/api/public/auctions`, { cache: "no-store" });
    if (!res.ok) return [];
    const { auctions } = (await res.json()) as { auctions: PublicAuction[] };
    return auctions.filter((x) => x.id !== exceptId && x.category === category).slice(0, 4);
  } catch {
    return [];
  }
}

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
  const a = detail.auction;
  const origin = SITE_ORIGINS[country.code];
  const price = ((a.currentPriceCents ?? a.startPriceCents ?? 0) / 100).toFixed(2);
  const description = `€${price} · ${a.description.slice(0, 140) || a.title}`;
  return {
    title: a.title,
    description,
    alternates: alternatesFor(country, `/auction/${id}`),
    // Превью в мессенджерах и соцсетях: фото лота, цена, название (№ 05).
    openGraph: {
      title: a.title,
      description,
      url: `${origin}/auction/${id}`,
      siteName: "Izsoli.lv",
      type: "website",
      ...(a.photos[0] ? { images: [{ url: a.photos[0], width: 1200, height: 900, alt: a.title }] } : {}),
    },
    twitter: {
      card: a.photos[0] ? "summary_large_image" : "summary",
      title: a.title,
      description,
      ...(a.photos[0] ? { images: [a.photos[0]] } : {}),
    },
  };
}

export default async function AuctionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [detail, host] = await Promise.all([fetchDetail(id), headers().then((h) => h.get("host"))]);
  if (!detail) {
    // Старые разосланные ссылки: кнопка «далīties» до исправления собирала
    // /auction/<id> и для товаров «Pirkt tagad». Если такой товар существует —
    // молча ведём на его настоящий адрес, а не в «Šādas lapas nav».
    const asListing = await fetch(`${API_URL}/api/public/listings/${id}`, { cache: "no-store" })
      .then((r) => (r.ok ? r : null))
      .catch(() => null);
    if (asListing) redirect(`/listing/${id}`);
    notFound();
  }
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

  const related = await fetchRelated(a.category, a.id);

  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdScript(jsonLd) }} />
      <LotPage initial={detail} related={related} />
    </>
  );
}
