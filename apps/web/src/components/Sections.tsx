"use client";

import Link from "next/link";
import type { CSSProperties, ReactNode } from "react";
import { useT } from "@/lib/i18n";
import { useRail } from "@/lib/ui";
import { Icon } from "./Icon";

/** Заголовок секции макета: слева h2 (+подпись), справа ссылка «смотреть всё». */
export function SecHead({
  icon, title, sub, link, href, id,
}: { icon?: string; title: string; sub?: string; link?: string; href?: string; id?: string }) {
  return (
    <div className="sec-head">
      <div>
        <h2 id={id}>{icon && <Icon name={icon} size={28} />}{title}</h2>
        {sub && <p className="sub">{sub}</p>}
      </div>
      {link && href && (
        <Link className="link" href={href}>{link} <Icon name="arrow" size={16} /></Link>
      )}
    </div>
  );
}

/** Пустое состояние «твои ставки». */
export function MyBids({ signedIn }: { signedIn: boolean }) {
  const { t } = useT();
  void signedIn;
  return (
    <section className="wrap">
      <div className="mybids">
        <span className="ic" aria-hidden="true"><Icon name="gavel" /></span>
        <div className="t">
          <h3>{t("sec.noBidsYet")}</h3>
          <p>{t("sec.noBidsYetD")}</p>
        </div>
        <Link className="btn btn-dark" href="/katalogs">{t("sec.findFirst")}</Link>
      </div>
    </section>
  );
}

/** Полоса живых торгов. */
export function LiveBand({ sales }: { sales: Array<{ id: string; title: string; text: string }> }) {
  const { t } = useT();
  const rows = sales.length ? sales : [
    { id: "live", title: "Friday Signature Sale", text: "Pulksteņi, kameras un dizaina objekti — kolekcija no viena īpašnieka." },
    { id: "live", title: "Overstock & Returns — bez rezerves", text: "Simtiem atvērtu un noliktavas lotu. Viss tiek pārdots." },
  ];
  return (
    <section className="wrap" id="live">
      <div className="live-band">
        <div className="lb-head">
          <span className="lb-live"><i aria-hidden="true" />Live</span>
          <h2>{t("sec.rightNow")}</h2>
          <span className="sub">{t("sec.rightNowD")}</span>
        </div>
        <div className="lb-grid">
          {rows.map((s, i) => (
            <div className="lb-item" key={i}>
              <div className="t"><h3>{s.title}</h3><p>{s.text}</p></div>
              <Link className="btn btn-primary" href="/tiesraide">
                <Icon name="bolt" size={18} />{t("sec.join")}
              </Link>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

const BRANDS: Array<[string, number]> = [
  ["Filson", 4], ["Flos", 4], ["Sony", 4], ["KEF", 3], ["Omega", 3], ["Longines", 2],
  ["Nikon", 2], ["PSA", 2], ["Topps", 2], ["Apple", 1], ["Canyon", 1], ["Maison Lithographie", 3],
];

export function Brands() {
  const { t } = useT();
  return (
    <section className="section wrap">
      <SecHead id="brands" title={t("sec.byBrand")} link={t("sec.allBrands")} href="/zimoli" />
      <div className="brands">
        {BRANDS.map(([n, c]) => (
          <Link className="brand" key={n} href={`/meklet?q=${encodeURIComponent(n)}`}>
            <b>{n}</b><span>{c} live</span>
          </Link>
        ))}
      </div>
    </section>
  );
}

/** «Почему мы»: сравнение цен + три шага. */
export function WhyUs() {
  const { t } = useT();
  const bars: Array<[string, string, number, boolean]> = [
    [t("sec.barShop"), "4 200 €", 100, false],
    [t("sec.barOther"), "2 950 €", 70, false],
    [t("sec.barUs"), "1 900 €", 45, true],
  ];
  const steps: Array<[string, string]> = [
    [t("sec.step1"), t("sec.step1D")],
    [t("sec.step2"), t("sec.step2D")],
    [t("sec.step3"), t("sec.step3D")],
  ];
  return (
    <section className="section wrap" id="save">
      <div className="why">
        <div className="cmp">
          <div>
            <h2 data-reveal>{t("sec.sameGoods")}<br />{t("sec.marketPrice")}</h2>
            <p className="lead" data-reveal style={{ margin: "16px 0 24px", maxWidth: "40ch" }}>
              {t("sec.whyLead")}
            </p>
            <Link className="btn btn-dark" data-reveal href="/katalogs?closing=1d">{t("sec.endingToday")}</Link>
          </div>
          <div className="bars" data-bars>
            {bars.map(([who, amt, w, win]) => (
              <div className={`bar-item${win ? " win" : ""}`} key={who}>
                <p className="bar-top">
                  <span className="bar-who">{who}</span>
                  <span className="bar-amt tnum">{amt}</span>
                </p>
                <div className="bar-track">
                  <i className="bar-fill" style={{ ["--w" as string]: `${w}%`, width: `${w}%` } as CSSProperties} />
                </div>
              </div>
            ))}
            <p className="note">{t("sec.barNote")}</p>
          </div>
        </div>

        <div className="steps">
          {steps.map(([h, p], i) => (
            <div className="step" data-reveal key={h}>
              <span className="n" aria-hidden="true">{i + 1}</span>
              <h3>{h}</h3><p>{p}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/** SEO-блок: индексируемые внутренние ссылки. */
export function SeoBlock() {
  const { t } = useT();
  return (
    <section className="section wrap" aria-label={t("sec.seoAria")}>
      <div className="seo">
        <div><h2>{t("sec.seoH")}</h2></div>
        <div className="seo-t">
          <p>
            {t("sec.seoP1a")} <Link href="/katalogs">{t("sec.seoFullCat")}</Link>, {t("sec.seoJoin")}{" "}
            <Link href="/tiesraide">{t("sec.seoLiveAuction")}</Link> {t("sec.seoOrStart")}{" "}
            <Link href="/katalogs?category=jewellery_watches">{t("sec.seoWatches")}</Link>.
          </p>
          <p>
            {t("sec.seoPopular")} <Link href="/katalogs?category=electronics">{t("cat.electronics")}</Link>,{" "}
            <Link href="/katalogs?category=electronics">{t("sec.seoCameras")}</Link>,{" "}
            <Link href="/katalogs?category=electronics">{t("sec.seoAudio")}</Link>,{" "}
            <Link href="/katalogs?category=tools">{t("cat.tools")}</Link>,{" "}
            <Link href="/katalogs?category=home_garden">{t("sec.seoHome")}</Link>.{" "}
            {t("sec.seoAlsoBrand")} <Link href="/zimoli">{t("sec.seoByBrand")}</Link>, {t("sec.seoRead")}{" "}
            <Link href="/noteikumi">{t("sec.seoRules")}</Link> {t("sec.seoOrSee")}{" "}
            <Link href="/rezultati">{t("sec.seoPastResults")}</Link>.{" "}
            {t("sec.seoTail")}
          </p>
        </div>
      </div>
    </section>
  );
}

const FAQ: Array<[string, string, boolean]> = [
  ["faq.q1", "faq.a1", true],
  ["faq.q2", "faq.a2", false],
  ["faq.q3", "faq.a3", false],
  ["faq.q4", "faq.a4", false],
];

export function Faq() {
  const { t } = useT();
  return (
    <section className="section wrap" id="faq">
      <div className="faq-grid">
        <div className="faq-aside" data-reveal>
          <h2>{t("f.faq")}</h2>
          <p className="lead" style={{ marginTop: 12 }}>
            {t("sec.faqIntro")}
          </p>
          <Link className="btn btn-dark" href="/buj" style={{ marginTop: 24 }}>
            {t("sec.allFaq")} <Icon name="arrow" size={18} />
          </Link>
          <p className="note" style={{ marginTop: 16 }}>
            {t("sec.noAnswer")}{" "}
            <Link href="/kontakti" style={{ color: "var(--text)", borderBottom: "2px solid var(--accent)", fontWeight: 700 }}>
              {t("sec.writeUs")}
            </Link>{t("sec.replyIn")}
          </p>
        </div>
        <div className="faq">
          {FAQ.map(([q, a, open]) => (
            <details className="q" key={q} open={open}>
              <summary>{t(q)}<span className="chev" aria-hidden="true"><Icon name="plus" size={14} /></span></summary>
              <p className="a">{t(a)}</p>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}
