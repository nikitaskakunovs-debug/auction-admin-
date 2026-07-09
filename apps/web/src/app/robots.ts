import type { MetadataRoute } from "next";
import { headers } from "next/headers";
import { originForHost } from "@/lib/country";

export default async function robots(): Promise<MetadataRoute.Robots> {
  const origin = originForHost((await headers()).get("host"));
  return {
    rules: { userAgent: "*", allow: "/", disallow: ["/account", "/login", "/register"] },
    sitemap: `${origin}/sitemap.xml`,
  };
}
