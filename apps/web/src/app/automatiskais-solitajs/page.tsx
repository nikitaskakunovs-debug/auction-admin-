import { InfoPage, type InfoBlock } from "@/components/InfoPage";

export const metadata = {
  title: "Automātiskais solītājs",
  description: "Automātiskais solītājs ļauj nesēdēt pie ekrāna: tu nosaki griestus, sistēma solī tavā vietā.",
};

const BLOCKS: InfoBlock[] = [
  {
    "h": "Kā tas strādā"
  },
  {
    "steps": [
      [
        "Ievadi maksimumu",
        "Piemēram, 500 €. Tas ir griesti, nevis tava cena."
      ],
      [
        "Solām minimāli",
        "Ja pretinieks apstājas pie 300 €, tu vadi ar 310 €, nevis ar 500 €."
      ],
      [
        "Brīdinām, ja pārsniegts",
        "Ja kāds pārsolī tavu maksimumu, saņem paziņojumu un vari to paaugstināt."
      ]
    ]
  },
  {
    "h": "Ko redz citi"
  },
  {
    "p": "Publiskajā solījumu plūsmā redzama tikai faktiskā cena un segvārds. Tavs maksimums nav redzams ne citiem solītājiem, ne pārdevējam."
  },
  {
    "h": "Vienāds maksimums diviem solītājiem"
  },
  {
    "p": "Ja diviem solītājiem sakrīt maksimālā summa, priekšroka ir tam, kurš to iestatīja pirmais."
  },
  {
    "h": "Maksimuma maiņa"
  },
  {
    "p": "Maksimumu var paaugstināt jebkurā brīdī līdz izsoles beigām. Samazināt to nevar — solījums jau ir izdarīts."
  }
];

const RELATED: Array<[string, string]> = [["Solīšanas noteikumi", "/noteikumi"], ["Biežākie jautājumi", "/buj"]];

export default function Page() {
  return (
    <InfoPage
      title={"Automātiskais solītājs"}
      sub={"Maksimālais solījums soli pa solim"}
      lead={"Automātiskais solītājs ļauj nesēdēt pie ekrāna: tu nosaki griestus, sistēma solī tavā vietā."}
      blocks={BLOCKS}
      related={RELATED}
    />
  );
}
