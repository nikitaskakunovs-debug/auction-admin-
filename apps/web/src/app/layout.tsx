import type { Metadata } from "next";
import type { ReactNode } from "react";
import { API_URL, SITE_URL } from "@/lib/config";
import { I18nProvider } from "@/lib/i18n";
import type { Localized } from "@/components/CmsBlocks";
import { Footer } from "@/components/Footer";
import { Header } from "@/components/Header";

export const metadata: Metadata = {
  title: { default: "Baltic Auction House", template: "%s · Baltic Auction House" },
  description: "Live auctions in Latvia, Estonia and Lithuania. Watches, art, design and collectibles.",
  metadataBase: new URL(SITE_URL),
  alternates: {
    canonical: "/",
    // Per-country ccTLDs (.lv/.ee/.lt) reinforce each other via hreflang;
    // until those domains are wired, the alternates point at this origin.
    languages: { lv: "/", et: "/", lt: "/", ru: "/", en: "/" },
  },
};

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
  const footerPages = await fetchFooterPages();
  return (
    <html lang="lv">
      <body
        style={{
          margin: 0,
          fontFamily: '"Geist", system-ui, sans-serif',
          background: "#F7F7F5",
          color: "#0A0A0A",
          minHeight: "100vh",
        }}
      >
        <I18nProvider>
          <Header />
          <main style={{ maxWidth: 1080, margin: "0 auto", padding: "28px 20px 80px" }}>{children}</main>
          <Footer pages={footerPages} />
        </I18nProvider>
      </body>
    </html>
  );
}
