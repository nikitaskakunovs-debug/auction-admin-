import Link from "next/link";
import { Icon } from "@/components/Icon";

export const metadata = {
  title: "Pārdod ar mums",
  description: "Novērtējums 24 h laikā. Atsūti foto — pasakām reālo tirgus cenu un paņemam lotu izsolei.",
};

const STEPS: Array<[string, string]> = [
  ["Atsūti foto", "Divi trīs kadri un daži vārdi par preci. Ja ir čeks, kaste vai sertifikāts — pievieno arī tos."],
  ["Saņem novērtējumu", "Vienas darba dienas laikā pasakām reālo tirgus cenu un ieteicamo sākumcenu."],
  ["Mēs darām pārējo", "Fotografējam, aprakstam stāvokli, publicējam un vedam sarunu ar pircējiem. Naudu pārskaitām pēc apmaksas."],
];

const WHAT: string[] = [
  "Pulksteņi un rotaslietas", "Elektronika un audio", "Kameras un optika",
  "Dizains un mēbeles", "Instrumenti un tehnika", "Kolekcijas un māksla",
];

const NOT: string[] = [
  "Preces bez īpašumtiesību apliecinājuma", "Kopijas un viltojumi",
  "Preces, kuru aprite ir ierobežota ar likumu",
];

export default function SellPage() {
  return (
    <section className="wrap" style={{ paddingTop: 24 }}>
      <nav className="crumbs" aria-label="Navigācijas ceļš">
        <ol><li><Link href="/">Sākums</Link></li><li aria-current="page">Pārdod ar mums</li></ol>
      </nav>

      <div className="page-head">
        <div>
          <h1 data-hero>Novērtējums 24 stundu laikā</h1>
          <p className="cnt">Bez maksas · bez saistībām</p>
        </div>
        <Link className="link" href="/kontakti">Sazināties <Icon name="arrow" size={16} /></Link>
      </div>

      <p className="lead" style={{ maxWidth: "52ch", marginBottom: "var(--s6)" }}>
        Tu atsūti foto — mēs pasakām, cik prece reāli maksā tirgū šodien, un, ja der,
        paņemam to izsolei. Komisiju ieturam tikai no pārdotā lota.
      </p>

      <div className="steps">
        {STEPS.map(([h, p], i) => (
          <div className="step" key={h}>
            <span className="n" aria-hidden="true">{i + 1}</span>
            <h3>{h}</h3><p>{p}</p>
          </div>
        ))}
      </div>

      <section className="section" style={{ paddingBottom: 0 }}>
        <div className="rep-cols">
          <div>
            <h3>Ko mēs pārdodam</h3>
            <ul className="rep-list">
              {WHAT.map((x) => <li className="in" key={x}><Icon name="check" size={16} />{x}</li>)}
            </ul>
          </div>
          <div>
            <h3>Ko nepieņemam</h3>
            <ul className="rep-list">
              {NOT.map((x) => <li className="out" key={x}><Icon name="x" size={16} />{x}</li>)}
            </ul>
          </div>
        </div>
      </section>

      <div className="mybids" style={{ marginBottom: "var(--s6)" }}>
        <span className="ic" aria-hidden="true"><Icon name="mail" /></span>
        <div className="t">
          <h3>Atsūti foto uz info@izsoli.lv</h3>
          <p>Norādi preces nosaukumu, stāvokli un savu tālruni — atbildam vienas darba dienas laikā.</p>
        </div>
        <a className="btn btn-dark" href="mailto:info@izsoli.lv?subject=Novērtējums">Rakstīt e-pastu</a>
      </div>

      <p className="note">
        Novērtējums ir informatīvs un neuzliek pienākumu pārdot. Gala cenu izsolē nosaka solītāji.
      </p>
    </section>
  );
}
