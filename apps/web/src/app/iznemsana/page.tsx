import { InfoPage, type InfoBlock } from "@/components/InfoPage";

export const metadata = {
  title: "Izņemšana Rīgā",
  description: "Apmaksātos lotus var izņemt klātienē. Tas ir bez maksas un ātrāk nekā sūtījums.",
};

const BLOCKS: InfoBlock[] = [
  {
    "h": "Kā tas notiek"
  },
  {
    "steps": [
      [
        "Apmaksā pasūtījumu",
        "Izvēlies «Izņemšana» apmaksas solī."
      ],
      [
        "Saņem kodu",
        "Izņemšanas kods un QR parādās tavā kontā sadaļā «Izņemšana»."
      ],
      [
        "Atnāc pēc lota",
        "Parādi kodu vai QR — izsniedzam preci."
      ]
    ]
  },
  {
    "h": "Termiņš"
  },
  {
    "p": "Lots jāizņem norādītajā termiņā. Konkrētais datums redzams pasūtījumā. Ja nesanāk — raksti mums, parasti termiņu var pagarināt."
  },
  {
    "h": "Izņemšana ar pilnvaru"
  },
  {
    "p": "Lotu var izņemt cita persona, ja tai ir izņemšanas kods. Vērtīgākiem lotiem varam lūgt uzrādīt personu apliecinošu dokumentu."
  }
];

const RELATED: Array<[string, string]> = [["Pakomāti Latvijā", "/piegade"], ["Kontakti un darba laiks", "/kontakti"]];

export default function Page() {
  return (
    <InfoPage
      title={"Izņemšana Rīgā"}
      sub={"Bez maksas, darbdienās"}
      lead={"Apmaksātos lotus var izņemt klātienē. Tas ir bez maksas un ātrāk nekā sūtījums."}
      blocks={BLOCKS}
      related={RELATED}
    />
  );
}
