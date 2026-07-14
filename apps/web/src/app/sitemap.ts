import type { MetadataRoute } from "next";
import { headers } from "next/headers";
import { API_URL } from "@/lib/config";
import { originForHost } from "@/lib/country";
import type { FixedListing, PublicAuction } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  // Serve each ccTLD its own-origin URLs so the sitemap on .ee lists .ee links.
  const origin = originForHost((await headers()).get("host"));
  const entries: MetadataRoute.Sitemap = [
    { url: origin, changeFrequency: "hourly", priority: 1 },
    { url: `${origin}/conditions`, changeFrequency: "monthly", priority: 0.4 },
  ];
  try {
    const [aRes, lRes] = await Promise.all([
      fetch(`${API_URL}/api/public/auctions`, { cache: "no-store" }),
      fetch(`${API_URL}/api/public/listings`, { cache: "no-store" }),
    ]);
    if (aRes.ok) {
      const { auctions } = (await aRes.json()) as { auctions: PublicAuction[] };
      for (const a of auctions) {
        entries.push({ url: `${origin}/auction/${a.id}`, changeFrequency: "always", priority: 0.8 });
      }
    }
    if (lRes.ok) {
      const { listings } = (await lRes.json()) as { listings: FixedListing[] };
      for (const l of listings) {
        entries.push({ url: `${origin}/listing/${l.id}`, changeFrequency: "daily", priority: 0.7 });
      }
    }
  } catch {
    // sitemap degrades to the homepage when the API is unreachable
  }
  return entries;
}
