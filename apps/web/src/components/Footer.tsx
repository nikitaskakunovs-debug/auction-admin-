"use client";

import Link from "next/link";
import { useT } from "@/lib/i18n";
import { pickLocalized, type Localized } from "./CmsBlocks";
import { Icon } from "./Icon";

/** Подвал утверждённого макета: тёмный, четыре колонки, соцсети, юр. текст.
 *  Колонка «Uzņēmums» подмешивает страницы из CMS, если они есть. */
export function Footer({ pages }: { pages: Array<{ slug: string; title: Localized }> }) {
  const { lang } = useT();

  const cols: Array<[string, Array<[string, string]>]> = [
    ["Izsoles", [
      ["Tiešraidē", "/katalogs?status=live"],
      ["Drīz beidzas", "/katalogs?closing=1d"],
      ["Bez rezerves", "/katalogs?reserve=no"],
      ["Izsoļu rezultāti", "/katalogs?status=ended"],
    ]],
    ["Kā tas darbojas", [
      ["Solīšanas noteikumi", "/p/solisanas-noteikumi"],
      ["Automātiskais solītājs", "/p/automatiskais-solitajs"],
      ["Stāvokļa skala A–D", "/conditions"],
      ["Maksājumu veidi", "/p/maksajumi"],
    ]],
    ["Piegāde", [
      ["Pakomāti Latvijā", "/p/piegade"],
      ["Izņemšana Rīgā", "/p/iznemsana"],
      ["Atteikuma tiesības", "/p/atteikuma-tiesibas"],
      ["Bojāta prece", "/p/bojata-prece"],
    ]],
  ];

  const company: Array<[string, string]> = pages.length
    ? pages.map((p) => [pickLocalized(p.title, lang), `/p/${p.slug}`] as [string, string])
    : [["Par mums", "/p/par-mums"], ["No kurienes preces", "/p/preces"],
       ["Palīdzības centrs", "/p/palidziba"], ["Sazinies ar mums", "/p/kontakti"]];

  return (
    <footer><div className="wrap">
      <Link className="logo" href="/" style={{ color: "var(--on-brand)", marginBottom: "var(--s6)" }}>
        <span className="logo-mark" aria-hidden="true">I</span>Izsoli.lv
      </Link>

      <div className="f-grid">
        {cols.map(([h, links]) => (
          <div key={h}>
            <h4>{h}</h4>
            <ul>{links.map(([label, href]) => (
              <li key={label}><Link href={href}>{label}</Link></li>
            ))}</ul>
          </div>
        ))}
        <div>
          <h4>Uzņēmums</h4>
          <ul>{company.map(([label, href]) => (
            <li key={href}><Link href={href}>{label}</Link></li>
          ))}</ul>
        </div>
      </div>

      <div className="f-util">
        <div className="f-social">
          <a href="https://www.facebook.com/" aria-label="Izsoli.lv Facebook" rel="noopener noreferrer" target="_blank">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 9h3V6h-3c-2.2 0-4 1.8-4 4v2H8v3h2v7h3v-7h3l1-3h-4v-2c0-.6.4-1 1-1z" /></svg>
          </a>
          <a href="https://www.instagram.com/" aria-label="Izsoli.lv Instagram" rel="noopener noreferrer" target="_blank">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7zm0 2a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3zM17 3H7a4 4 0 0 0-4 4v10a4 4 0 0 0 4 4h10a4 4 0 0 0 4-4V7a4 4 0 0 0-4-4zm2 14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v10zm-1.5-9.6a1 1 0 1 1-2 0 1 1 0 0 1 2 0z" /></svg>
          </a>
          <a href="https://www.youtube.com/" aria-label="Izsoli.lv YouTube" rel="noopener noreferrer" target="_blank">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21.6 7.2a2.5 2.5 0 0 0-1.8-1.8C18.2 5 12 5 12 5s-6.2 0-7.8.4A2.5 2.5 0 0 0 2.4 7.2 26 26 0 0 0 2 12c0 1.6.1 3.2.4 4.8a2.5 2.5 0 0 0 1.8 1.8C5.8 19 12 19 12 19s6.2 0 7.8-.4a2.5 2.5 0 0 0 1.8-1.8c.3-1.6.4-3.2.4-4.8s-.1-3.2-.4-4.8zM10 15V9l5.2 3L10 15z" /></svg>
          </a>
        </div>
        <Link className="f-pill" href="/"><Icon name="globe" size={16} />Latvija · Latviešu · EUR €</Link>
      </div>

      <p className="f-legal">
        Izsoli.lv SIA, Rīga, Latvija. Visas cenas ar PVN. Solīšana ir juridiski saistoša — uzvarot izsolē,
        tiek noslēgts pirkuma līgums. Cenai tiek pievienota pircēja komisija un PVN atbilstoši tirgum.
        Strīdu gadījumā var vērsties Patērētāju tiesību aizsardzības centrā (PTAC) vai
        ES strīdu izšķiršanas platformā.
      </p>

      <nav className="f-links" aria-label="Juridiskā informācija">
        <Link href="/p/lietosanas-noteikumi">Lietošanas noteikumi</Link>
        <Link href="/p/privatuma-politika">Privātuma politika</Link>
        <Link href="/p/sikdatnes">Sīkdatnes</Link>
        <Link href="/p/sudzibas">Sūdzību izskatīšana</Link>
        <Link href="/p/pieejamiba">Pieejamība</Link>
        <Link href="/sitemap.xml">Vietnes karte</Link>
      </nav>

      <p className="f-bottom"><span>© 2026 Izsoli.lv SIA</span><span>Veidots Rīgā</span></p>
    </div></footer>
  );
}
