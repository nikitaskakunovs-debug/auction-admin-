"use client";

import Link from "next/link";
import type { ReactNode } from "react";
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
  return (
    <section className="wrap">
      <div className="mybids">
        <span className="ic" aria-hidden="true"><Icon name="gavel" /></span>
        <div className="t">
          <h3>{signedIn ? "Vēl neesi solījis" : "Vēl neesi solījis"}</h3>
          <p>Kad būsi solījis, šeit redzēsi aktīvos solījumus, pārsolīšanas brīdinājumus un uzvarētos lotus.</p>
        </div>
        <Link className="btn btn-dark" href="/katalogs">Atrast pirmo lotu</Link>
      </div>
    </section>
  );
}

/** Полоса живых торгов. */
export function LiveBand({ sales }: { sales: Array<{ id: string; title: string; text: string }> }) {
  const rows = sales.length ? sales : [
    { id: "live", title: "Friday Signature Sale", text: "Pulksteņi, kameras un dizaina objekti — kolekcija no viena īpašnieka." },
    { id: "live", title: "Overstock & Returns — bez rezerves", text: "Simtiem atvērtu un noliktavas lotu. Viss tiek pārdots." },
  ];
  return (
    <section className="wrap" id="live">
      <div className="live-band">
        <div className="lb-head">
          <span className="lb-live"><i aria-hidden="true" />Live</span>
          <h2>Notiek tieši tagad</h2>
          <span className="sub">Lotus izsauc pa vienam · solī pret zāli</span>
        </div>
        <div className="lb-grid">
          {rows.map((s, i) => (
            <div className="lb-item" key={i}>
              <div className="t"><h3>{s.title}</h3><p>{s.text}</p></div>
              <Link className="btn btn-primary" href="/tiesraide">
                <Icon name="bolt" size={18} />Pievienoties
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
  return (
    <section className="section wrap">
      <SecHead id="brands" title="Meklē pēc zīmola" link="Visi zīmoli" href="/zimoli" />
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
  const bars: Array<[string, string, number, boolean]> = [
    ["Veikalā", "4 200 €", 100, false],
    ["Citas izsoļu platformas", "2 950 €", 70, false],
    ["Izsoli.lv — pašreizējais solījums", "1 900 €", 45, true],
  ];
  const steps: Array<[string, string]> = [
    ["Izvēlies lotu", "Reāli foto, godīgs stāvokļa apraksts pēc skalas A–D un ieteiktā cena salīdzinājumam."],
    ["Ievadi maksimumu", "Sistēma solī tavā vietā līdz norādītajai summai. Pārsolīšanas gadījumā saņem paziņojumu."],
    ["Samaksā un saņem", "Karte vai bankas saite. Izsūtām nākamajā darba dienā, pakomātā esi pēc 48 stundām."],
  ];
  return (
    <section className="section wrap" id="save">
      <div className="why">
        <div className="cmp">
          <div>
            <h2 data-reveal>Tā pati prece.<br />Cena, ko nosaka tirgus.</h2>
            <p className="lead" data-reveal style={{ margin: "16px 0 24px", maxWidth: "40ch" }}>
              Mēs pērkam noliktavu atlikumus un kolekcijas veselos apjomos. Tu maksā par preci, nevis par plauktu veikalā.
            </p>
            <Link className="btn btn-dark" data-reveal href="/katalogs?closing=1d">Skatīt, kas beidzas šodien</Link>
          </div>
          <div className="bars" data-bars>
            {bars.map(([who, amt, w, win]) => (
              <div className={`bar-item${win ? " win" : ""}`} key={who}>
                <p className="bar-top">
                  <span className="bar-who">{who}</span>
                  <span className="bar-amt tnum">{amt}</span>
                </p>
                <div className="bar-track"><i className="bar-fill" style={{ width: `${w}%` }} /></div>
              </div>
            ))}
            <p className="note">Vidējā uzvarējušā solījuma cena šajā kategorijā pēdējās 90 dienās. Cenas ar PVN.</p>
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
  return (
    <section className="section wrap" aria-label="Par Izsoli.lv izsolēm">
      <div className="seo">
        <div><h2>Online izsoles Latvijā — sāc solīt ar 1 EUR</h2></div>
        <div className="seo-t">
          <p>
            Izsoli.lv ir online izsoļu platforma Rīgā. Katrs lots sākas ar zemu sākumcenu, un gala cenu nosaka
            solītāji. Apskati <Link href="/katalogs">pilno katalogu</Link>, pievienojies{" "}
            <Link href="/tiesraide">izsolei tiešraidē</Link> vai sāc ar{" "}
            <Link href="/katalogs?category=jewellery_watches">pulksteņiem un rotaslietām</Link>.
          </p>
          <p>
            Populārākās kategorijas: <Link href="/katalogs?category=electronics">elektronika</Link>,{" "}
            <Link href="/katalogs?category=electronics">kameras un optika</Link>,{" "}
            <Link href="/katalogs?category=electronics">audio tehnika</Link>,{" "}
            <Link href="/katalogs?category=tools">instrumenti</Link> un{" "}
            <Link href="/katalogs?category=home_garden">mājai un dizainam</Link>.
            Var meklēt arī <Link href="/zimoli">pēc zīmola</Link>, izlasīt{" "}
            <Link href="/buj">solīšanas noteikumus</Link> vai apskatīt{" "}
            <Link href="/rezultati">iepriekšējo izsoļu rezultātus</Link>.
            Visas cenas ar PVN, piegāde uz pakomātu 48 stundās.
          </p>
        </div>
      </div>
    </section>
  );
}

const FAQ: Array<[string, ReactNode, boolean]> = [
  ["Kāpēc preces ir lētākas nekā veikalā?",
   "Mēs pērkam noliktavu atlikumus, klientu atgriezumus un vienas īpašnieka kolekcijas veselos apjomos. " +
   "Preces ir jaunas vai gandrīz jaunas, bet tirgotājs tās vairs nevar pārdot kā jaunas — visbiežāk tāpēc, " +
   "ka iepakojums ir atvērts.", true],
  ["Kas notiek, ja mani pārsola?",
   "Saņem paziņojumu e-pastā un lietotnē. Ja esi norādījis maksimālo summu, sistēma automātiski pārsola " +
   "pretinieku par vienu soli, kamēr vien nepārsniedz tavu limitu.", false],
  ["Vai varu atgriezt preci?",
   "Jā. Patērētājam ir 14 dienu atteikuma tiesības saskaņā ar Patērētāju tiesību aizsardzības likumu un " +
   "ES Direktīvu 2011/83/ES. Preci atgriež oriģinālajā stāvoklī; atgriešanas izmaksas sedz pircējs, " +
   "ja vien prece nav bojāta vai neatbilst aprakstam.", false],
  ["Cik maksā piegāde?",
   "3,90 € uz pakomātu visā Latvijā neatkarīgi no lotu skaita, ja tos apmaksā vienā pasūtījumā. " +
   "Lotus var arī izņemt klātienē Rīgā bez maksas.", false],
];

export function Faq() {
  return (
    <section className="section wrap" id="faq">
      <div className="faq-grid">
        <div className="faq-aside" data-reveal>
          <h2>Biežākie jautājumi</h2>
          <p className="lead" style={{ marginTop: 12 }}>
            Solīšana, piegāde, atgriešana un stāvokļa skala — īsi un bez juridiskās miglas.
          </p>
          <Link className="btn btn-dark" href="/buj" style={{ marginTop: 24 }}>
            Skatīt visus BUJ <Icon name="arrow" size={18} />
          </Link>
          <p className="note" style={{ marginTop: 16 }}>
            Neatradi atbildi?{" "}
            <Link href="/kontakti" style={{ color: "var(--text)", borderBottom: "2px solid var(--accent)", fontWeight: 700 }}>
              Raksti mums
            </Link> — atbildam 1 darba dienas laikā.
          </p>
        </div>
        <div className="faq">
          {FAQ.map(([q, a, open]) => (
            <details className="q" key={q} open={open}>
              <summary>{q}<span className="chev" aria-hidden="true"><Icon name="plus" size={14} /></span></summary>
              <p className="a">{a}</p>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}
