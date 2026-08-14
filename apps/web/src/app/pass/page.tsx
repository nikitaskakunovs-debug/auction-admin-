import { Icon } from "@/components/Icon";
import { Crumbs } from "@/components/Crumbs";

export const metadata = {
  title: "Izsoli Pass",
  description: "Gada abonements: zemāka pircēja komisija un piegāde bez maksas.",
};

const PERKS: Array<[string, string, string]> = [
  ["Zemāka komisija", "Pircēja komisija samazinās katram uzvarētajam lotam gada garumā.", "tag"],
  ["Piegāde bez maksas", "Pakomāts visā Latvijā — bez maksas, neatkarīgi no lotu skaita.", "box"],
  ["Agrīna piekļuve", "Signature izsoles atveram abonentiem stundu ātrāk.", "bolt"],
  ["Ilgāks izņemšanas termiņš", "Vairāk laika, lai paņemtu lotu klātienē Rīgā.", "timer"],
];

export default function PassPage() {
  return (
    <section className="wrap" style={{ paddingTop: 24 }}>
      <Crumbs here="Izsoli Pass" />

      <div className="page-head">
        <div>
          <h1 data-hero>Izsoli Pass</h1>
          <p className="cnt"><span className="tag">Drīzumā</span> Gada abonements pastāvīgajiem solītājiem</p>
        </div>
      </div>

      <p className="lead" style={{ maxWidth: "52ch", marginBottom: "var(--s6)" }}>
        Ja solī regulāri, abonements atmaksājas jau pēc pāris lotiem: zemāka komisija un
        piegāde bez maksas visu gadu.
      </p>

      <div className="lb-grid">
        {PERKS.map(([title, text, icon]) => (
          <div className="lb-item" key={title}>
            <div className="t">
              <h3><Icon name={icon} size={18} /> {title}</h3>
              <p>{text}</p>
            </div>
          </div>
        ))}
      </div>

      <div className="mybids" style={{ marginTop: "var(--s6)", marginBottom: "var(--s6)" }}>
        <span className="ic" aria-hidden="true"><Icon name="bell" /></span>
        <div className="t">
          <h3>Pieteikties gaidīšanas sarakstam</h3>
          <p>Kad Izsoli Pass būs pieejams, paziņosim pirmajiem — un pirmā gada cena būs zemāka.</p>
        </div>
        <a className="btn btn-dark" href="mailto:info@izsoli.lv?subject=Izsoli%20Pass">Pieteikties</a>
      </div>

      <p className="note">
        Abonementa cena un precīzs komisijas apmērs tiks publicēts pirms starta.
        Esošie pasūtījumi netiek pārrēķināti.
      </p>
    </section>
  );
}
