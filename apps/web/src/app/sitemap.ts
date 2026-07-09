import type { MetadataRoute } from "next";
import { API_URL, SITE_URL } from "@/lib/config";
import type { PublicAuction } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const entries: MetadataRoute.Sitemap = [{ url: SITE_URL, changeFrequency: "hourly", priority: 1 }];
  try {
    const res = await fetch(`${API_URL}/api/public/auctions`, { cache: "no-store" });
    if (res.ok) {
      const { auctions } = (await res.json()) as { auctions: PublicAuction[] };
      for (const a of auctions) {
        entries.push({ url: `${SITE_URL}/auction/${a.id}`, changeFrequency: "always", priority: 0.8 });
      }
    }
  } catch {
    // sitemap degrades to the homepage when the API is unreachable
  }
  return entries;
}
