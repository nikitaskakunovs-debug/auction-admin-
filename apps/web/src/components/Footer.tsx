"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useT } from "@/lib/i18n";
import type { Country } from "@/lib/country";
import { pickLocalized, type Localized } from "@/lib/localized";
import { Icon } from "./Icon";
import { COUNTRY_LABEL, LANG_NAME, RegionMenu } from "./RegionMenu";
import { CookieSettingsLink } from "./CookieBanner";

/** Подвал утверждённого макета: тёмный, четыре колонки, соцсети, юр. текст.
 *  Колонка «Uzņēmums» подмешивает страницы из CMS, если они есть. */
export function Footer({ pages, country = "LV" }: { pages: Array<{ slug: string; title: Localized }>; country?: Country }) {
  const { t, lang } = useT();
  const [region, setRegion] = useState(false);

  useEffect(() => {
    if (!region) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setRegion(false); };
    document.addEventListener("keydown", onKey);
    document.body.classList.add("no-scroll");
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.classList.remove("no-scroll");
    };
  }, [region]);


  const cols: Array<[string, Array<[string, string]>]> = [
    ["f.auctions", [
      ["rail.live", "/tiesraide"],
      ["rail.closing", "/katalogs?closing=1d"],
      ["rail.noReserve", "/katalogs?reserve=no"],
      ["nav.results", "/rezultati"],
    ]],
    ["f.howItWorks", [
      ["f.bidRules", "/noteikumi"],
      ["f.autoBidder", "/automatiskais-solitajs"],
      ["f.conditionScale", "/conditions"],
      ["f.paymentMethods", "/maksajumi"],
    ]],
    ["f.delivery", [
      ["f.parcelMachines", "/piegade"],
      ["f.pickupRiga", "/iznemsana"],
      ["f.withdrawal", "/atteikuma-tiesibas"],
      ["f.damaged", "/bojata-prece"],
    ]],
  ];

  const company: Array<[string, string]> = pages.length
    ? pages.map((p) => [pickLocalized(p.title, lang), `/p/${p.slug}`] as [string, string])
    : [[t("f.sellWithUs"), "/pardod"], [t("f.pass"), "/pass"],
       [t("f.faq"), "/buj"], [t("f.contact"), "/kontakti"]];

  return (
    <footer><div className="wrap">
      <Link className="logo" href="/" style={{ color: "var(--on-brand)", marginBottom: "var(--s6)" }}>
        <span className="logo-mark" aria-hidden="true">I</span>Izsoli.lv
      </Link>

      <div className="f-grid">
        {cols.map(([h, links]) => (
          <div key={h}>
            <h4>{t(h)}</h4>
            <ul>{links.map(([key, href]) => (
              <li key={key}><Link href={href}>{t(key)}</Link></li>
            ))}</ul>
          </div>
        ))}
        <div>
          <h4>{t("f.company")}</h4>
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
        <button className="f-pill" type="button" aria-haspopup="dialog" aria-expanded={region}
                onClick={() => setRegion(true)}>
          <Icon name="globe" size={16} />{COUNTRY_LABEL[country].name} · {LANG_NAME[lang] ?? lang.toUpperCase()} · EUR €
        </button>
      </div>

      <p className="f-legal">{t("f.legal")}</p>

      <nav className="f-links" aria-label={t("f.legalNav")}>
        <Link href="/lietosanas-noteikumi">{t("f.terms")}</Link>
        <Link href="/privatuma-politika">{t("f.privacy")}</Link>
        <Link href="/sikdatnes">{t("f.cookies")}</Link>
        {/* Отозвать согласие должно быть так же просто, как дать его. Раньше
            в подвале была только ссылка на текст политики. */}
        <CookieSettingsLink label={t("f.cookieSettings")} />
        <Link href="/sudzibas">{t("f.complaints")}</Link>
        <Link href="/pieejamiba">{t("f.accessibility")}</Link>
        <Link href="/sitemap.xml">{t("f.sitemap")}</Link>
      </nav>

      <p className="f-bottom"><span>© 2026 Izsoli.lv SIA</span><span>{t("f.madeIn")}</span></p>

      <RegionMenu open={region} onClose={() => setRegion(false)} country={country} />

    </div></footer>
  );
}
