import { InfoPage, type InfoBlock } from "@/components/InfoPage";

export const metadata = {
  title: "Bojāta prece",
  description: "Ja prece atnāca bojāta vai neatbilst aprakstam, to risinām uz sava rēķina.",
};

const BLOCKS: InfoBlock[] = [
  {
    "h": "Rīkojies uzreiz"
  },
  {
    "steps": [
      [
        "Nofotografē",
        "Preci un iepakojumu, tostarp uzlīmes un plombas."
      ],
      [
        "Uzraksti mums",
        "48 stundu laikā pēc saņemšanas, norādot pasūtījuma numuru."
      ],
      [
        "Saņem risinājumu",
        "Maiņa, remonts vai pilna atmaksa, ieskaitot piegādi."
      ]
    ]
  },
  {
    "h": "Kas skaitās neatbilstība"
  },
  {
    "list": [
      "Prece nedarbojas, lai gan aprakstā norādīts pretējais",
      "Trūkst komplektācijas, kas norādīta aprakstā",
      "Defekts, kas nav minēts stāvokļa aprakstā un nav redzams foto"
    ]
  },
  {
    "h": "Kas neskaitās"
  },
  {
    "bad": [
      "Defekti, kas aprakstīti lota piezīmēs",
      "Nolietojums, kas atbilst norādītajai stāvokļa pakāpei",
      "Iepakojuma bojājumi, ja lots pārdots kā «iepakojums bojāts»"
    ]
  }
];

const RELATED: Array<[string, string]> = [["Atteikuma tiesības", "/atteikuma-tiesibas"], ["Stāvokļa skala", "/conditions"]];

export default function Page() {
  return (
    <InfoPage
      title={"Bojāta prece"}
      sub={"Ko darīt, ja lots atnāca bojāts"}
      lead={"Ja prece atnāca bojāta vai neatbilst aprakstam, to risinām uz sava rēķina."}
      blocks={BLOCKS}
      related={RELATED}
    />
  );
}
