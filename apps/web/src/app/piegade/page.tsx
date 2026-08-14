import { InfoPage, type InfoBlock } from "@/components/InfoPage";

export const metadata = {
  title: "Pakomāti Latvijā",
  description: "Apmaksātos lotus izsūtām nākamajā darba dienā. Pakomātā sūtījums parasti ir pēc 48 stundām.",
};

const BLOCKS: InfoBlock[] = [
  {
    "h": "Kā izvēlēties"
  },
  {
    "p": "Piegādes veidu izvēlies apmaksas solī. Pieejamie veidi un cenas rādās uzreiz, un kopsumma pārrēķinās turpat."
  },
  {
    "h": "Vairāki loti"
  },
  {
    "p": "Ja vairāki loti apmaksāti vienā pasūtījumā, piegādi rēķinām vienu reizi un sūtām kopā."
  },
  {
    "h": "Neizņemts sūtījums"
  },
  {
    "p": "Neizņemts sūtījums atgriežas pie mums, un pasūtījumam tiek piemērota atkārtotas noliktavas maksa. Ja nesanāk paspēt — raksti iepriekš, pagarināsim termiņu."
  },
  {
    "h": "Lielgabarīta preces"
  },
  {
    "p": "Mēbeles un citus lielgabarīta lotus pakomātā nesūtām — tie ir izņemami Rīgā vai piegādājami ar kurjeru pēc atsevišķas vienošanās."
  }
];

const RELATED: Array<[string, string]> = [["Izņemšana Rīgā", "/iznemsana"], ["Bojāta prece", "/bojata-prece"], ["Maksājumu veidi", "/maksajumi"]];

export default function Page() {
  return (
    <InfoPage
      title={"Pakomāti Latvijā"}
      sub={"Piegāde un tās izmaksas"}
      lead={"Apmaksātos lotus izsūtām nākamajā darba dienā. Pakomātā sūtījums parasti ir pēc 48 stundām."}
      blocks={BLOCKS}
      related={RELATED}
    />
  );
}
