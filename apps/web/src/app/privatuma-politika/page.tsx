import { InfoPage, type InfoBlock } from "@/components/InfoPage";

export const metadata = {
  title: "Privātuma politika",
  description: "Apstrādājam tikai tos datus, kas vajadzīgi izsoles, apmaksas un piegādes nodrošināšanai.",
};

const BLOCKS: InfoBlock[] = [
  {
    "h": "Kādus datus vācam"
  },
  {
    "list": [
      "Konta dati: e-pasts, segvārds, parole šifrētā veidā",
      "Darījumu dati: solījumi, pasūtījumi, maksājumu statuss",
      "Piegādes dati: vārds, tālrunis, pakomāts vai adrese",
      "Tehniskie dati: IP adrese un pārlūka informācija drošības nolūkos"
    ]
  },
  {
    "h": "Kāpēc"
  },
  {
    "p": "Lai izpildītu līgumu (dalība izsolē, pirkums, piegāde), izpildītu grāmatvedības prasības un nodrošinātu drošību pret krāpšanu."
  },
  {
    "h": "Kam nododam"
  },
  {
    "p": "Maksājumu pakalpojumu sniedzējiem, piegādes partneriem un grāmatvedībai — tikai tādā apjomā, kāds vajadzīgs konkrētajai darbībai. Datus nepārdodam."
  },
  {
    "h": "Cik ilgi glabājam"
  },
  {
    "p": "Konta datus — kamēr pastāv konts. Darījumu ierakstus — normatīvajos aktos noteikto grāmatvedības termiņu."
  },
  {
    "h": "Tavas tiesības"
  },
  {
    "list": [
      "Piekļūt saviem datiem un saņemt to kopiju",
      "Labot neprecīzus datus",
      "Dzēst kontu un ar to saistītos datus",
      "Iebilst pret apstrādi un iesniegt sūdzību uzraudzības iestādē"
    ]
  },
  {
    "note": "Pieprasījumus par datiem sūti no sava konta e-pasta — atbildam viena mēneša laikā."
  }
];

const RELATED: Array<[string, string]> = [["Sīkdatnes", "/sikdatnes"], ["Lietošanas noteikumi", "/lietosanas-noteikumi"]];

export default function Page() {
  return (
    <InfoPage
      title={"Privātuma politika"}
      sub={"Kā apstrādājam personas datus"}
      lead={"Apstrādājam tikai tos datus, kas vajadzīgi izsoles, apmaksas un piegādes nodrošināšanai."}
      blocks={BLOCKS}
      related={RELATED}
    />
  );
}
