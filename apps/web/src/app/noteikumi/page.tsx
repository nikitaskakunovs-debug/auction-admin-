import { InfoPage, type InfoBlock } from "@/components/InfoPage";

export const metadata = {
  title: "Solīšanas noteikumi",
  description: "Īsi un bez juridiskās miglas: kā notiek solīšana, kas ir maksimālais solījums, kāpēc izsole var pagarināties un kas notiek pēc uzvaras.",
};

const BLOCKS: InfoBlock[] = [
  {
    "h": "Solījums ir saistošs"
  },
  {
    "p": "Nospiežot «Solīt», tu izdari juridiski saistošu piedāvājumu. Ja izsole noslēdzas ar tavu solījumu kā augstāko un ir sasniegta rezerves cena, pirkuma līgums ir noslēgts."
  },
  {
    "h": "Solis"
  },
  {
    "p": "Minimālais solis aug kopā ar cenu — jo dārgāks lots, jo lielāks solis. Nākamais minimums vienmēr redzams zem summas ievades lauka."
  },
  {
    "h": "Maksimālais solījums"
  },
  {
    "steps": [
      [
        "Norādi maksimumu",
        "Ievadi augstāko summu, ko esi gatavs maksāt."
      ],
      [
        "Sistēma solī tavā vietā",
        "Pa vienam solim, tikai tik, cik vajag, lai vadītu."
      ],
      [
        "Uzvari par zemāko cenu",
        "Bieži gala cena ir krietni zemāka par tavu maksimumu."
      ]
    ]
  },
  {
    "note": "Citi solītāji tavu maksimālo summu neredz nekad."
  },
  {
    "h": "Pagarinājums beigās"
  },
  {
    "p": "Ja solījums pienāk pēdējā minūtē, izsoles beigas tiek pārceltas, lai pārējiem būtu laiks atbildēt. Pagarinājumu skaits nav ierobežots — izsole beidzas, kad solījumi apstājas."
  },
  {
    "h": "Rezerves cena"
  },
  {
    "p": "Daļai lotu ir rezerve — minimālā cena, par kādu pārdevējs ir gatavs šķirties no preces. Summa netiek atklāta; kartītē redzams tikai tas, vai rezerve ir sasniegta. Ja nav — lots netiek pārdots."
  },
  {
    "h": "Solījuma atcelšana"
  },
  {
    "p": "Solījumu atsaukt nevar. Acīmredzamas kļūdas gadījumā raksti mums nekavējoties — izskatām katru gadījumu atsevišķi. Sistemātiska nemaksāšana noved pie konta ierobežojuma."
  }
];

const RELATED: Array<[string, string]> = [["Automātiskais solītājs", "/automatiskais-solitajs"], ["Maksājumu veidi", "/maksajumi"], ["Stāvokļa skala", "/conditions"]];

export default function Page() {
  return (
    <InfoPage
      title={"Solīšanas noteikumi"}
      sub={"Kā strādā solīšana Izsoli.lv"}
      lead={"Īsi un bez juridiskās miglas: kā notiek solīšana, kas ir maksimālais solījums, kāpēc izsole var pagarināties un kas notiek pēc uzvaras."}
      blocks={BLOCKS}
      related={RELATED}
    />
  );
}
