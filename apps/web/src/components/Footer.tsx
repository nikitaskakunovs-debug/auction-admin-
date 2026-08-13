"use client";

import Link from "next/link";
import { useT } from "@/lib/i18n";
import { pickLocalized, type Localized } from "./CmsBlocks";

export function Footer({ pages }: { pages: Array<{ slug: string; title: Localized }> }) {
  const { lang, t } = useT();
  return (
    <footer className="foot">
      <div className="wrap">
        <Link className="logo" href="/" style={{ color: "var(--on-brand)", marginBottom: 32 }}>
          <span className="logo-mark" aria-hidden="true">I</span>
          Izsoli.lv
        </Link>

        <div className="foot-grid">
          <div>
            <h4>{t("nav.auctions")}</h4>
            <ul>
              <li><Link href="/">{t("nav.auctions")}</Link></li>
              <li><Link href="/conditions">Stāvokļa skala</Link></li>
            </ul>
          </div>
          <div>
            <h4>Konts</h4>
            <ul>
              <li><Link href="/account">{t("nav.account")}</Link></li>
              <li><Link href="/login">{t("nav.signin")}</Link></li>
              <li><Link href="/register">{t("nav.register")}</Link></li>
            </ul>
          </div>
          <div>
            <h4>Informācija</h4>
            <ul>
              {pages.map((p) => (
                <li key={p.slug}>
                  <Link href={`/p/${p.slug}`}>{pickLocalized(p.title, lang)}</Link>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <h4>Saziņa</h4>
            <ul>
              <li><a href="mailto:info@izsoli.lv">info@izsoli.lv</a></li>
              <li><span style={{ opacity: 0.82 }}>Rīga, Latvija</span></li>
            </ul>
          </div>
        </div>

        <p className="foot-legal">
          Solīšana ir juridiski saistoša — uzvarot izsolē, tiek noslēgts pirkuma līgums.
          Cenai tiek pievienota pircēja komisija un PVN atbilstoši tirgum. Strīdu gadījumā
          var vērsties Patērētāju tiesību aizsardzības centrā (PTAC) vai ES strīdu
          izšķiršanas platformā.
        </p>
        <p className="foot-bottom">
          <span>© {new Date().getFullYear()} Izsoli.lv · Skakunov’s SIA</span>
          <span>Veidots Rīgā</span>
        </p>
      </div>
    </footer>
  );
}
