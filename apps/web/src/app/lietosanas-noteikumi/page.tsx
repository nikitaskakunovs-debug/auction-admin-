import { InfoPage, type InfoBlock } from "@/components/InfoPage";

export const metadata = {
  title: "Lietošanas noteikumi",
  description: "Šie noteikumi attiecas uz Izsoli.lv vietnes lietošanu un dalību izsolēs.",
};

const BLOCKS: InfoBlock[] = [
  {
    "h": "Konts"
  },
  {
    "p": "Kontu drīkst izveidot rīcībspējīga fiziska persona vai juridiskas personas pārstāvis. Par darbībām kontā atbild tā īpašnieks; paroli nedrīkst nodot citiem."
  },
  {
    "h": "Solīšana"
  },
  {
    "p": "Solījums ir juridiski saistošs. Detalizēti solīšanas noteikumi aprakstīti atsevišķi."
  },
  {
    "h": "Aizliegtās darbības"
  },
  {
    "bad": [
      "Cenas mākslīga uzpūšana un solīšana savos lotos",
      "Vairāku kontu izmantošana viena solītāja vārdā",
      "Automatizēta datu izgūšana un slodzes radīšana vietnei"
    ]
  },
  {
    "h": "Konta ierobežošana"
  },
  {
    "p": "Noteikumu pārkāpumu vai neapmaksātu pasūtījumu gadījumā kontam var tikt ierobežota solīšana līdz situācijas nokārtošanai."
  },
  {
    "h": "Atbildība"
  },
  {
    "p": "Cenšamies nodrošināt vietnes nepārtrauktu darbību, taču neatbildam par īslaicīgiem pārtraukumiem. Lotu apraksti tiek sagatavoti godprātīgi; par preces atbilstību aprakstam atbildam saskaņā ar patērētāju tiesību regulējumu."
  },
  {
    "note": "Dokuments tiek papildināts. Aktuālā redakcija vienmēr pieejama šajā lapā."
  }
];

const RELATED: Array<[string, string]> = [["Privātuma politika", "/privatuma-politika"], ["Sīkdatnes", "/sikdatnes"], ["Solīšanas noteikumi", "/noteikumi"]];

export default function Page() {
  return (
    <InfoPage
      title={"Lietošanas noteikumi"}
      sub={"Vietnes un pakalpojuma lietošana"}
      lead={"Šie noteikumi attiecas uz Izsoli.lv vietnes lietošanu un dalību izsolēs."}
      blocks={BLOCKS}
      related={RELATED}
    />
  );
}
