import { InfoPage, type InfoBlock } from "@/components/InfoPage";

export const metadata = {
  title: "Sūdzību izskatīšana",
  description: "Sūdzību var iesniegt jebkurā brīdī. Atbildam rakstiski.",
};

const BLOCKS: InfoBlock[] = [
  {
    "h": "Kā iesniegt"
  },
  {
    "p": "Uzraksti uz info@izsoli.lv no sava konta e-pasta. Norādi pasūtījuma vai lota numuru, situācijas aprakstu un vēlamo risinājumu. Pievieno foto, ja tas attiecas uz preci."
  },
  {
    "h": "Termiņi"
  },
  {
    "facts": [
      [
        "Saņemšanas apstiprinājums",
        "1 darba diena"
      ],
      [
        "Atbilde pēc būtības",
        "Līdz 15 darba dienām"
      ],
      [
        "Sarežģītos gadījumos",
        "Informējam par pagarinājumu"
      ]
    ]
  },
  {
    "h": "Ja atbilde neapmierina"
  },
  {
    "p": "Patērētājs var vērsties Patērētāju tiesību aizsardzības centrā (PTAC) vai izmantot ES strīdu izšķiršanas platformu tiešsaistē."
  }
];

const RELATED: Array<[string, string]> = [["Atteikuma tiesības", "/atteikuma-tiesibas"], ["Kontakti", "/kontakti"]];

export default function Page() {
  return (
    <InfoPage
      title={"Sūdzību izskatīšana"}
      sub={"Kā iesniegt un kā izskatām"}
      lead={"Sūdzību var iesniegt jebkurā brīdī. Atbildam rakstiski."}
      blocks={BLOCKS}
      related={RELATED}
    />
  );
}
