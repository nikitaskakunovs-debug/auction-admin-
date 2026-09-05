import { InfoPage, type InfoBlock } from "@/components/InfoPage";

export const metadata = {
  title: "Sīkdatņu politika",
  description: "Nepieciešamās sīkdatnes uztur vietnes darbību. Pārējās ieslēdzam tikai ar tavu piekrišanu — pēc noklusējuma tās ir izslēgtas.",
};

/** Политика честно называет инструменты по именам — тот же список, что в
 *  плашке согласия. Меняешь стек аналитики → меняешь и этот текст. */
const BLOCKS: InfoBlock[] = [
  {
    "h": "Nepieciešamās"
  },
  {
    "p": "Pieteikšanās sesija, drošība, izvēlētā valoda, grozs un tavs sīkdatņu izvēles ieraksts. Šeit pieder arī tehniskie ieraksti pārlūka atmiņā (localStorage): sesijas talons, saglabātie meklējumi un tiešās konsoles saraksts. Bez tām vietne nedarbojas, tāpēc tās nevar izslēgt."
  },
  {
    "h": "Analītika — Google Analytics 4"
  },
  {
    "p": "Palīdz saprast, kuras lapas tiek lietotas, kur cilvēki apstājas un kuras izsoļu kategorijas interesē. Lietojam Google Analytics 4 caur Google Tag Manager. Analītikai nododam tikai lotu numurus, summas un notikumus (piemēram, «apskatīts lots», «veikts pirkums») un nejaušu konta identifikatoru — ne e-pastu, ne vārdu, ne tālruni. Ieslēdzas tikai ar piekrišanu; pirms tās Google saņem signālu «aizliegts» (Google Consent Mode)."
  },
  {
    "h": "Mārketings — Google Ads, Meta Pixel, TikTok"
  },
  {
    "p": "Personalizēta reklāma un reklāmas atdeves mērīšana. Ar piekrišanu Google Ads var saņemt pirkuma apstiprināšanai arī e-pastu un tālruni šifrētā (jaucējkoda) veidā — tā reklāmas kabinets saprot, ka reklāma noveda pie pirkuma, neredzot pašus datus atklātā veidā. Meta Pixel un TikTok tiks pieslēgti ar tiem pašiem noteikumiem. Bez piekrišanas nekas no šī nenotiek."
  },
  {
    "h": "No kurienes tu atnāci"
  },
  {
    "p": "Ja atnāc no reklāmas saites, pirmā apmeklējuma atzīmes (utm) un atsauces vietne tiek saglabātas pārlūkā un pēc reģistrācijas piesaistītas kontam — tā mēs zinām, kura reklāma strādā. Tie nav personas dati: tikai kampaņas nosaukums un vietnes adrese."
  },
  {
    "h": "Kā mainīt izvēli"
  },
  {
    "p": "Jebkurā brīdī: lapas kājenē spied «Sīkdatņu iestatījumi», vai kontā — Iestatījumi → Sīkdatnes. Piekrišanu var atsaukt tikpat viegli, kā to deva; atsaukšana neietekmē vietnes darbību. Katru izvēli glabājam žurnālā kā pierādījumu (GDPR 7. pants)."
  }
];

const RELATED: Array<[string, string]> = [["Privātuma politika", "/privatuma-politika"], ["Lietošanas noteikumi", "/lietosanas-noteikumi"]];

export default function Page() {
  return (
    <InfoPage
      title={"Sīkdatņu politika"}
      sub={"Kādas sīkdatnes lietojam un kāpēc"}
      lead={"Nepieciešamās sīkdatnes uztur vietnes darbību. Pārējās ieslēdzam tikai ar tavu piekrišanu — pēc noklusējuma tās ir izslēgtas."}
      blocks={BLOCKS}
      related={RELATED}
    />
  );
}
