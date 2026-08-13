import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import localFont from "next/font/local";
import type { ReactNode } from "react";
import { API_URL } from "@/lib/config";
import { resolveCountry, SITE_ORIGINS } from "@/lib/country";
import { alternatesFor } from "@/lib/seo";
import { I18nProvider } from "@/lib/i18n";
import type { Localized } from "@/components/CmsBlocks";
import { Chrome } from "@/components/Chrome";
import { CookieBanner } from "@/components/CookieBanner";
import { Dock } from "@/components/Dock";
import { Footer } from "@/components/Footer";
import { Modals } from "@/components/Modals";
import { Toast } from "@/components/Toast";
import "./globals.css";

// Шрифт лежит в репозитории и не тянется из сети ни в рантайме, ни на сборке:
// сборка не должна падать из-за недоступного fonts.googleapis.com.
const figtree = localFont({
  src: [
    { path: "./fonts/figtree-400.woff2", weight: "400", style: "normal" },
    { path: "./fonts/figtree-500.woff2", weight: "500", style: "normal" },
    { path: "./fonts/figtree-600.woff2", weight: "600", style: "normal" },
    { path: "./fonts/figtree-700.woff2", weight: "700", style: "normal" },
    { path: "./fonts/figtree-800.woff2", weight: "800", style: "normal" },
  ],
  display: "swap",
  variable: "--font-figtree",
});

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#163300",
  colorScheme: "light dark",
};

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
    <html lang={country.defaultLang} className={`${figtree.variable} no-js`}>
      <head>
        {/* Снимаем no-js до первой отрисовки: правила фолбэка в globals.css
            рассчитаны на то, что с JS их не видно. */}
        <script dangerouslySetInnerHTML={{ __html: "document.documentElement.classList.remove('no-js')" }} />
      </head>
      <body>
        <a className="skip" href="#main">Pāriet uz galveno saturu</a>
        <I18nProvider initialLang={country.defaultLang} available={country.languages}>
          <Chrome country={country.code} />
          <main id="main">{children}</main>
          <Footer pages={footerPages} country={country.code} />
          <Dock />
          <Modals />
          <CookieBanner />
          <Toast />
        </I18nProvider>
      </body>
    </html>
  );
}
