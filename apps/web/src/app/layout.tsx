import type { Metadata } from "next";
import type { ReactNode } from "react";
import { SITE_URL } from "@/lib/config";
import { I18nProvider } from "@/lib/i18n";
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

export default function RootLayout({ children }: { children: ReactNode }) {
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
          <footer style={{ borderTop: "1px solid rgba(10,10,10,0.08)", padding: "22px 20px", textAlign: "center" }}>
            <span style={{ fontSize: 12, color: "#6B6B68" }}>
              Baltic Auction House · LV · EE · LT
            </span>
          </footer>
        </I18nProvider>
      </body>
    </html>
  );
}
