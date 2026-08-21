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
import { SocialCatch } from "@/components/SocialCatch";
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

/** Google Tag Manager. Включается только когда сборке передан контейнер
 *  (NEXT_PUBLIC_GTM_ID) — dev и предпросмотры живут без внешних тегов.
 *
 *  Порядок внутри скрипта важен: сначала Consent Mode запрещает всё по
 *  умолчанию, затем проигрывается сохранённое решение из нашей плашки
 *  (izsoli_cc_v1), и только после этого грузится сам GTM — ни один тег не
 *  успевает выстрелить до согласия. Свежие решения плашка шлёт через
 *  consentUpdate() из lib/track.ts. */
const GTM_ID = /^GTM-[A-Z0-9]+$/.test(process.env.NEXT_PUBLIC_GTM_ID ?? "")
  ? process.env.NEXT_PUBLIC_GTM_ID!
  : null;
const gtmBootstrap = GTM_ID && `
window.dataLayer=window.dataLayer||[];
function gtag(){dataLayer.push(arguments);}
gtag('consent','default',{ad_storage:'denied',ad_user_data:'denied',ad_personalization:'denied',analytics_storage:'denied',wait_for_update:500});
try{var c=JSON.parse(localStorage.getItem('izsoli_cc_v1')||'null');
if(c){gtag('consent','update',{analytics_storage:c.analytics?'granted':'denied',ad_storage:c.marketing?'granted':'denied',ad_user_data:c.marketing?'granted':'denied',ad_personalization:c.marketing?'granted':'denied'});}}catch(e){}
(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':new Date().getTime(),event:'gtm.js'});
var f=d.getElementsByTagName(s)[0],j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';
j.async=true;j.src='https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);
})(window,document,'script','dataLayer','${GTM_ID}');`;

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
        {gtmBootstrap && <script dangerouslySetInnerHTML={{ __html: gtmBootstrap }} />}
      </head>
      <body>
        {GTM_ID && (
          <noscript>
            <iframe src={`https://www.googletagmanager.com/ns.html?id=${GTM_ID}`}
                    height="0" width="0" style={{ display: "none", visibility: "hidden" }} title="gtm" />
          </noscript>
        )}
        <I18nProvider initialLang={country.defaultLang} available={country.languages}>
          {/* Внутри провайдера: снаружи <T /> получал пустой контекст и выводил
              сам ключ — на экране стояло «nav.skipToMain». */}
          <a className="skip" href="#main"><T k="nav.skipToMain" /></a>
          <Chrome country={country.code} />
          <main id="main">{children}</main>
          <Footer pages={footerPages} country={country.code} />
          <Dock />
          <Modals />
          <SocialCatch />
          <CookieBanner />
          <Toast />
        </I18nProvider>
      </body>
    </html>
  );
}
