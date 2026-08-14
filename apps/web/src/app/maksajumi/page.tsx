import { InfoPage, type InfoBlock } from "@/components/InfoPage";

export const metadata = {
  title: "Maksājumu veidi",
  description: "Pēc izsoles beigām pasūtījums parādās tavā kontā. Samaksāt var ar karti vai bankas saiti, lielākiem pirkumiem — pa daļām.",
};

const BLOCKS: InfoBlock[] = [
  {
    "h": "Kas veido gala summu"
  },
  {
    "facts": [
      [
        "Āmura cena",
        "Tava uzvarējušā likme"
      ],
      [
        "Pircēja komisija",
        "Procenti no āmura cenas"
      ],
      [
        "PVN",
        "No āmura cenas un komisijas"
      ],
      [
        "Piegāde",
        "Ja izvēlies sūtījumu"
      ]
    ]
  },
  {
    "p": "Precīza summa ar visiem komponentiem redzama vēl pirms solīšanas — solījuma apstiprināšanas logā."
  },
  {
    "h": "Pieejamie veidi"
  },
  {
    "list": [
      "Bankas karte (Visa, Mastercard)",
      "Bankas saite",
      "Maksājums pa daļām lielākiem pirkumiem"
    ]
  },
  {
    "h": "Termiņš"
  },
  {
    "p": "Rēķins jāapmaksā norādītajā termiņā — tas redzams pasūtījumā tavā kontā un e-pastā. Ja termiņš beidzas, lots var tikt piedāvāts nākamajam solītājam, un pasūtījumam tiek piemērota maksa."
  },
  {
    "h": "Rēķins un grāmatvedība"
  },
  {
    "p": "Rēķinu nosūtām uz e-pastu uzreiz pēc apmaksas. Ja vajadzīgs rēķins uz uzņēmumu, norādi rekvizītus pirms apmaksas — raksti mums."
  }
];

const RELATED: Array<[string, string]> = [["Piegāde", "/piegade"], ["Atteikuma tiesības", "/atteikuma-tiesibas"], ["Kontakti", "/kontakti"]];

export default function Page() {
  return (
    <InfoPage
      title={"Maksājumu veidi"}
      sub={"Kā samaksāt par uzvarēto lotu"}
      lead={"Pēc izsoles beigām pasūtījums parādās tavā kontā. Samaksāt var ar karti vai bankas saiti, lielākiem pirkumiem — pa daļām."}
      blocks={BLOCKS}
      related={RELATED}
    />
  );
}
