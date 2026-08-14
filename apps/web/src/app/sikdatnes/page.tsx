import { InfoPage, type InfoBlock } from "@/components/InfoPage";

export const metadata = {
  title: "Sīkdatņu politika",
  description: "Nepieciešamās sīkdatnes uztur vietnes darbību. Pārējās ieslēdzam tikai ar tavu piekrišanu — pēc noklusējuma tās ir izslēgtas.",
};

const BLOCKS: InfoBlock[] = [
  {
    "h": "Nepieciešamās"
  },
  {
    "p": "Pieteikšanās sesija, drošība, izvēlētā valoda un tavs sīkdatņu izvēles ieraksts. Bez tām vietne nedarbojas, tāpēc tās nevar izslēgt."
  },
  {
    "h": "Analītika"
  },
  {
    "p": "Palīdz saprast, kuras lapas tiek lietotas un kur cilvēki apstājas. Ieslēdzas tikai ar piekrišanu."
  },
  {
    "h": "Mārketings"
  },
  {
    "p": "Personalizēta reklāma citās vietnēs. Ieslēdzas tikai ar piekrišanu."
  },
  {
    "h": "Kā mainīt izvēli"
  },
  {
    "p": "Izvēli var mainīt jebkurā brīdī, notīrot pārlūka datus šai vietnei — piekrišanas logs parādīsies no jauna."
  }
];

const RELATED: Array<[string, string]> = [["Privātuma politika", "/privatuma-politika"], ["Lietošanas noteikumi", "/lietosanas-noteikumi"]];

export default function Page() {
  return (
    <InfoPage
      title={"Sīkdatņu politika"}
      sub={"Kādas sīkdatnes izmantojam"}
      lead={"Nepieciešamās sīkdatnes uztur vietnes darbību. Pārējās ieslēdzam tikai ar tavu piekrišanu — pēc noklusējuma tās ir izslēgtas."}
      blocks={BLOCKS}
      related={RELATED}
    />
  );
}
