import Link from "next/link";
import { jsonLdScript } from "@/lib/jsonld";
import { Icon } from "@/components/Icon";

export const metadata = {
  title: "Biežākie jautājumi",
  description: "Solīšana, maksimālais solījums, komisija un PVN, piegāde, atgriešana un stāvokļa skala — atbildes uz biežākajiem jautājumiem.",
};

/** Полный BUJ. Ответы сгруппированы так же, как разделы подвала, чтобы
 *  человек находил свой вопрос по тому же ярлыку, по которому пришёл. */
const GROUPS: Array<{ title: string; icon: string; qa: Array<[string, string]> }> = [
  {
    title: "Solīšana", icon: "gavel", qa: [
      ["Kā notiek solīšana?",
       "Katrs lots sākas ar zemu sākumcenu. Solījumu var paaugstināt par vienu soli — solis aug kopā ar cenu. " +
       "Kad izsole noslēdzas, lotu iegūst augstākais solītājs."],
      ["Kas ir maksimālais solījums?",
       "Norādi augstāko summu, ko esi gatavs maksāt. Sistēma solīs tavā vietā pa vienam solim, līdz sasniegs " +
       "tavu maksimumu. Citi solītāji tavu maksimumu neredz, un bieži uzvari par summu, kas ir krietni zemāka."],
      ["Kas notiek, ja mani pārsola?",
       "Saņem paziņojumu e-pastā un vietnē. Ja esi norādījis maksimālo solījumu, sistēma pārsola pretinieku " +
       "automātiski, kamēr nepārsniedz tavu limitu."],
      ["Kāpēc izsoles beigas pārceļas?",
       "Ja solījums pienāk pēdējā minūtē, izsole tiek pagarināta, lai pārējiem būtu laiks atbildēt. " +
       "Pagarinājumu skaits nav ierobežots — izsole beidzas, kad solījumi apstājas."],
      ["Kas ir rezerves cena?",
       "Minimālā cena, par kādu pārdevējs ir gatavs šķirties no lota. Pati summa netiek atklāta — " +
       "kartītē redzams tikai tas, vai rezerve ir sasniegta. Ja nav, lots netiek pārdots."],
      ["Vai solījumu var atsaukt?",
       "Nē. Solījums ir juridiski saistošs piedāvājums. Kļūdas gadījumā (piemēram, aizmirsts komats) " +
       "raksti mums nekavējoties — izskatīsim katru gadījumu atsevišķi."],
    ],
  },
  {
    title: "Cena un maksājumi", icon: "card", qa: [
      ["No kā veidojas gala summa?",
       "Āmura cena + pircēja komisija + PVN. Piegāde tiek pievienota, ja izvēlies sūtījumu. " +
       "Precīzu summu redzi solījuma apstiprināšanas logā vēl pirms solīšanas."],
      ["Kāpēc preces ir lētākas nekā veikalā?",
       "Mēs pērkam noliktavu atlikumus, klientu atgriezumus un veselas kolekcijas apjomā. Preces ir jaunas " +
       "vai gandrīz jaunas, bet tirgotājs tās vairs nevar pārdot kā jaunas — visbiežāk tāpēc, ka iepakojums ir atvērts."],
      ["Kā var samaksāt?",
       "Ar karti vai bankas saiti. Lielākiem pirkumiem pieejams arī maksājums pa daļām."],
      ["Cik ilgi jāsamaksā?",
       "Rēķins jāapmaksā norādītajā termiņā pēc izsoles beigām. Termiņš ir redzams pasūtījumā tavā kontā."],
    ],
  },
  {
    title: "Piegāde un saņemšana", icon: "box", qa: [
      ["Kā saņemt lotu?",
       "Uz pakomātu visā Latvijā vai bez maksas klātienē Rīgā. Piegādes veidu izvēlies apmaksas solī."],
      ["Cik ilgi jāgaida?",
       "Apmaksātos lotus izsūtām nākamajā darba dienā. Pakomātā sūtījums parasti ir pēc 48 stundām."],
      ["Vai vairākus lotus var saņemt vienā sūtījumā?",
       "Jā, ja tie ir apmaksāti vienā pasūtījumā — piegādi rēķinām vienu reizi."],
      ["Kas notiek, ja neizņemu sūtījumu?",
       "Neizņemts sūtījums atgriežas pie mums, un pasūtījumam tiek piemērota atkārtotas noliktavas maksa. " +
       "Ja nesanāk paspēt, raksti mums iepriekš — pagarināsim termiņu."],
    ],
  },
  {
    title: "Stāvoklis un atgriešana", icon: "shield", qa: [
      ["Kā jūs novērtējat stāvokli?",
       "Katrs lots pirms publicēšanas tiek pārbaudīts un saņem vienu no stāvokļa pakāpēm. " +
       "Ja ir konkrēts defekts, tas ir aprakstīts lota piezīmēs un redzams foto."],
      ["Vai varu atgriezt preci?",
       "Jā. Patērētājam ir 14 dienu atteikuma tiesības saskaņā ar Patērētāju tiesību aizsardzības likumu un " +
       "ES Direktīvu 2011/83/ES. Preci atgriež oriģinālajā stāvoklī; atgriešanas izmaksas sedz pircējs, " +
       "ja vien prece nav bojāta vai neatbilst aprakstam."],
      ["Prece atnāca bojāta — ko darīt?",
       "Nofotografē preci un iepakojumu un raksti mums 48 stundu laikā pēc saņemšanas. " +
       "Bojātu vai aprakstam neatbilstošu preci mainām vai atmaksājam pilnībā, ieskaitot piegādi."],
      ["Vai ir garantija?",
       "Preces tiek pārdotas ar patērētāja likumā noteiktajām tiesībām. Ražotāja garantija saglabājas, " +
       "ja tā ir norādīta lota aprakstā."],
    ],
  },
  {
    title: "Konts", icon: "shield", qa: [
      ["Vai reģistrācija ir obligāta?",
       "Katalogu var pārlūkot bez konta. Solīšanai konts ir vajadzīgs — solījums ir līgumsaistība, " +
       "tāpēc mums jāzina, kas solī."],
      ["Kāpēc citi redz segvārdu, nevis manu vārdu?",
       "Publiskajā solījumu plūsmā rādām tikai segvārdu. Tavs vārds, e-pasts un tālrunis nav redzami citiem."],
      ["Kā dzēst kontu?",
       "Raksti mums no sava konta e-pasta. Dzēšam kontu un personas datus, saglabājot tikai " +
       "grāmatvedībai obligātos ierakstus par pabeigtiem darījumiem."],
    ],
  },
];

export default function FaqPage() {
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: GROUPS.flatMap((g) => g.qa.map(([q, a]) => ({
      "@type": "Question", name: q,
      acceptedAnswer: { "@type": "Answer", text: a },
    }))),
  };

  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdScript(jsonLd) }} />
      <section className="wrap" style={{ paddingTop: 24 }}>
        <nav className="crumbs" aria-label="Navigācijas ceļš">
          <ol><li><Link href="/">Sākums</Link></li><li aria-current="page">Biežākie jautājumi</li></ol>
        </nav>

        <div className="page-head">
          <div>
            <h1 data-hero>Biežākie jautājumi</h1>
            <p className="cnt">Solīšana, cenas, piegāde, atgriešana un konts</p>
          </div>
          <Link className="link" href="/kontakti">Neatradi atbildi? <Icon name="arrow" size={16} /></Link>
        </div>

        {GROUPS.map((g) => (
          <section className="section" key={g.title} style={{ paddingTop: 0 }}>
            <div className="sec-head">
              <div><h2><Icon name={g.icon} size={28} />{g.title}</h2></div>
            </div>
            <div className="faq">
              {g.qa.map(([q, a]) => (
                <details className="q" key={q}>
                  <summary>{q}<span className="chev" aria-hidden="true"><Icon name="plus" size={14} /></span></summary>
                  <p className="a">{a}</p>
                </details>
              ))}
            </div>
          </section>
        ))}

        <div className="mybids" style={{ marginBottom: "var(--s6)" }}>
          <span className="ic" aria-hidden="true"><Icon name="mail" /></span>
          <div className="t">
            <h3>Jautājums palika bez atbildes?</h3>
            <p>Raksti mums — atbildam vienas darba dienas laikā.</p>
          </div>
          <Link className="btn btn-dark" href="/kontakti">Sazināties</Link>
        </div>
      </section>
    </>
  );
}
