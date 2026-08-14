import Link from "next/link";
import { jsonLdScript } from "@/lib/jsonld";
import { Icon } from "@/components/Icon";

export const metadata = {
  title: "Sazinies ar mums",
  description: "Izsoli.lv kontakti: e-pasts, izņemšanas punkts Rīgā un darba laiks.",
};

const TOPICS: Array<[string, string, string]> = [
  ["Jautājums par lotu", "Stāvoklis, komplektācija, papildu foto", "gavel"],
  ["Apmaksa un rēķini", "Maksājumi, termiņi, grāmatvedības dokumenti", "card"],
  ["Piegāde un atgriešana", "Sūtījumi, izņemšana Rīgā, atteikuma tiesības", "box"],
  ["Pārdošana ar mums", "Novērtējums un lotu pieņemšana", "tag"],
];

export default function ContactPage() {
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: "Izsoli.lv",
    url: "https://izsoli.lv/",
    email: "info@izsoli.lv",
    address: { "@type": "PostalAddress", addressLocality: "Rīga", addressCountry: "LV" },
  };

  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdScript(jsonLd) }} />
      <section className="wrap" style={{ paddingTop: 24 }}>
        <nav className="crumbs" aria-label="Navigācijas ceļš">
          <ol><li><Link href="/">Sākums</Link></li><li aria-current="page">Sazinies ar mums</li></ol>
        </nav>

        <div className="page-head">
          <div>
            <h1 data-hero>Sazinies ar mums</h1>
            <p className="cnt">Atbildam vienas darba dienas laikā</p>
          </div>
          <Link className="link" href="/buj">Biežākie jautājumi <Icon name="arrow" size={16} /></Link>
        </div>

        <div className="facts">
          <div><span>E-pasts</span><b><a href="mailto:info@izsoli.lv">info@izsoli.lv</a></b></div>
          <div><span>Izņemšana</span><b>Rīga · darbdienās</b></div>
          <div><span>Atbildes laiks</span><b>1 darba diena</b></div>
        </div>

        <section className="section" style={{ paddingBottom: 0 }}>
          <div className="sec-head"><div><h2>Par ko raksti</h2></div></div>
          <div className="lb-grid">
            {TOPICS.map(([title, sub, icon]) => (
              <div className="lb-item" key={title}>
                <div className="t">
                  <h3><Icon name={icon} size={18} /> {title}</h3>
                  <p>{sub}</p>
                </div>
                <a className="btn btn-outline"
                   href={`mailto:info@izsoli.lv?subject=${encodeURIComponent(title)}`}>Rakstīt</a>
              </div>
            ))}
          </div>
        </section>

        <p className="note" style={{ marginTop: "var(--s5)", marginBottom: "var(--s6)" }}>
          Ja jautājums ir par konkrētu lotu vai pasūtījumu, norādi tā numuru — atbildēsim ātrāk.
          Strīdu gadījumā patērētājs var vērsties Patērētāju tiesību aizsardzības centrā (PTAC)
          vai ES strīdu izšķiršanas platformā.
        </p>
      </section>
    </>
  );
}
