import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import localFont from "next/font/local";
import type { ReactNode } from "react";
import { API_URL } from "@/lib/config";
import { resolveCountry, SITE_ORIGINS } from "@/lib/country";
import { alternatesFor } from "@/lib/seo";
import { I18nProvider, T } from "@/lib/i18n";
import type { Localized } from "@/lib/localized";
import { Chrome } from "@/components/Chrome";
import { CookieBanner } from "@/components/CookieBanner";
import { Dock } from "@/components/Dock";
import { Footer } from "@/components/Footer";
import { Modals } from "@/components/Modals";
import { Toast } from "@/components/Toast";
import "./globals.css";

// Шрифт лежит в репозитории и не тянется из сети ни в рантайме, ни на сборке:
// сборка не должна падать из-за недоступного fonts.googleapis.com.
//
// Файлы — слитые подмножества latin + latin-ext (fontTools Merger из
// @fontsource/figtree). До этого здесь лежал только latin-ext: 136 глифов
// с диакритикой, но без a–z и цифр — слово «Rēķins» рисовалось двумя
// гарнитурами сразу.
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

// Кириллицы в Figtree не существует в природе — русская версия сайта падала
// в системный шрифт. Manrope стоит вторым семейством: браузер берёт из него
// только те символы, которых нет в Figtree.
const manrope = localFont({
  src: [
    { path: "./fonts/manrope-400.woff2", weight: "400", style: "normal" },
    { path: "./fonts/manrope-500.woff2", weight: "500", style: "normal" },
    { path: "./fonts/manrope-600.woff2", weight: "600", style: "normal" },
    { path: "./fonts/manrope-700.woff2", weight: "700", style: "normal" },
    { path: "./fonts/manrope-800.woff2", weight: "800", style: "normal" },
  ],
  display: "swap",
  variable: "--font-manrope",
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
    <html lang={country.defaultLang} className={`${figtree.variable} ${manrope.variable} no-js`}>
      <head>
        {/* Снимаем no-js до первой отрисовки: правила фолбэка в globals.css
            рассчитаны на то, что с JS их не видно. */}
        <script dangerouslySetInnerHTML={{ __html: "document.documentElement.classList.remove('no-js')" }} />
      </head>
      <body>
        <I18nProvider initialLang={country.defaultLang} available={country.languages}>
          {/* Внутри провайдера: снаружи <T /> получал пустой контекст и выводил
              сам ключ — на экране стояло «nav.skipToMain». */}
          <a className="skip" href="#main"><T k="nav.skipToMain" /></a>
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
