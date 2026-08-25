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
      "Konta dati: e-pasts, segvārds, parole šifrētā veidā; ienākot caur Google, Facebook vai Telegram — arī konta identifikators pie attiecīgā pakalpojuma",
      "Darījumu dati: solījumi, pasūtījumi, rēķini, maksājumu statuss",
      "Piegādes dati: vārds, tālrunis, pakomāts vai adrese",
      "Tehniskie dati: IP adrese, pārlūka informācija un aktīvās sesijas drošības nolūkos",
      "Mārketinga atzīmes: no kuras reklāmas saites atnāci (utm) — kampaņas nosaukums, ne personas dati"
    ]
  },
  {
    "h": "Kāpēc"
  },
  {
    "p": "Lai izpildītu līgumu (dalība izsolē, pirkums, piegāde), izpildītu grāmatvedības prasības, nodrošinātu drošību pret krāpšanu un — tikai ar tavu piekrišanu — mērītu reklāmas atdevi."
  },
  {
    "h": "Kam nododam"
  },
  {
    "p": "Maksājumu pakalpojumu sniedzējiem (Klix, Inbank), piegādes partneriem (Omniva, DPD), grāmatvedībai un e-pasta piegādes pakalpojumam — tikai tādā apjomā, kāds vajadzīgs konkrētajai darbībai. Datus nepārdodam."
  },
  {
    "h": "Analītika un reklāma — tikai ar piekrišanu"
  },
  {
    "p": "Ar piekrišanu «Analītika» lietošanas statistika nonāk Google Analytics 4: lotu numuri, summas un nejaušs konta identifikators — bez vārda, e-pasta un tālruņa. Ar piekrišanu «Mārketings» pirkuma apstiprināšanai Google Ads var saņemt e-pastu un tālruni jaucējkoda (šifrētā) veidā — reklāmas kabinets redz tikai to, ka reklāma noveda pie pirkuma. Bez piekrišanas šie rīki nesaņem neko; izvēli var atsaukt jebkurā brīdī kājenē vai kontā."
  },
  {
    "h": "Cik ilgi glabājam"
  },
  {
    "p": "Konta datus — kamēr pastāv konts. Darījumu ierakstus (rēķinus, pasūtījumus) — normatīvajos aktos noteikto grāmatvedības termiņu (5 gadi). Piekrišanu žurnālu — kamēr tas vajadzīgs piekrišanas pierādīšanai."
  },
  {
    "h": "Tavas tiesības"
  },
  {
    "list": [
      "Piekļūt saviem datiem un lejupielādēt to kopiju: konts → Iestatījumi → Konts un dati",
      "Labot neprecīzus datus turpat iestatījumos",
      "Dzēst kontu pašam — turpat, poga «Dzēst kontu»; darījumu ieraksti paliek grāmatvedībā bez saistes ar publisko profilu",
      "Atsaukt piekrišanas (sīkdatnes, jaunumi) tikpat viegli, kā tās deva",
      "Iebilst pret apstrādi un iesniegt sūdzību Datu valsts inspekcijā"
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
