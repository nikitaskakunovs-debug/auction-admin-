import type { Metadata } from "next";
import { headers } from "next/headers";
import type { ReactNode } from "react";
import { API_URL } from "@/lib/config";
import { resolveCountry, SITE_ORIGINS } from "@/lib/country";
import { alternatesFor } from "@/lib/seo";
import { I18nProvider } from "@/lib/i18n";
import type { Localized } from "@/components/CmsBlocks";
import { Footer } from "@/components/Footer";
import { Header } from "@/components/Header";

export async function generateMetadata(): Promise<Metadata> {
  const host = (await headers()).get("host");
  const country = resolveCountry(host);
  return {
    title: { default: "Izsoli.lv — tiešsaistes izsoles", template: "%s · Izsoli.lv" },
    description: "Live auctions in Latvia, Estonia and Lithuania. Watches, art, design and collectibles.",
    metadataBase: new URL(SITE_ORIGINS[country.code]),
    // The current country's own domain is the canonical base; the ccTLD
    // siblings (.lv/.ee/.lt) reinforce each other via hreflang.
    alternates: alternatesFor(country, "/"),
    openGraph: {
      siteName: "Izsoli.lv",
      locale: country.defaultLang,
      type: "website",
    },
  };
}

async function fetchFooterPages(): Promise<Array<{ slug: string; title: Localized }>> {
  try {
    const res = await fetch(`${API_URL}/api/public/pages`, { next: { revalidate: 120 } });
    if (!res.ok) return [];
    return ((await res.json()) as { pages: Array<{ slug: string; title: Localized }> }).pages;
  } catch {
    return [];
  }
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  const host = (await headers()).get("host");
  const country = resolveCountry(host);
  const footerPages = await fetchFooterPages();
  return (
    <html lang={country.defaultLang}>
      <body
        style={{
          margin: 0,
          fontFamily: '"Geist", system-ui, sans-serif',
          background: "#F7F7F5",
          color: "#0A0A0A",
          minHeight: "100vh",
        }}
      >
        <I18nProvider initialLang={country.defaultLang} available={country.languages}>
          <Header />
          <main style={{ maxWidth: 1080, margin: "0 auto", padding: "28px 20px 80px" }}>{children}</main>
          <Footer pages={footerPages} />
        </I18nProvider>
      </body>
    </html>
  );
}
