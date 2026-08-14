import { InfoPage, type InfoBlock } from "@/components/InfoPage";

export const metadata = {
  title: "Pieejamība",
  description: "Vietni veidojam tā, lai to varētu lietot ar tastatūru, ekrāna lasītāju un palielinājumu.",
};

const BLOCKS: InfoBlock[] = [
  {
    "h": "Ko esam izdarījuši"
  },
  {
    "list": [
      "Visu var izdarīt ar tastatūru; fokuss ir redzams",
      "Saites un pogas ir vismaz 24 px, ikonu pogas — 44 px",
      "Teksta un fona kontrasts atbilst WCAG 2.2 AA",
      "Katram attēlam ir alternatīvais teksts, dekoratīvie ir paslēpti no lasītāja",
      "Taimeri un statusi tiek paziņoti ekrāna lasītājam",
      "Ir tumšais režīms un tiek ievērots «samazināt kustību» iestatījums"
    ]
  },
  {
    "h": "Kur vēl strādājam"
  },
  {
    "p": "Turpinām uzlabot sarežģītākos elementus — filtru paneli un galeriju. Ja kaut kas nestrādā, uzraksti mums: tas nonāk uzdevumu sarakstā ar prioritāti."
  },
  {
    "h": "Atsauksmes"
  },
  {
    "p": "Raksti uz info@izsoli.lv un norādi, kuru lapu un ar kādu palīgtehnoloģiju lieto — tā atradīsim problēmu ātrāk."
  }
];

const RELATED: Array<[string, string]> = [["Kontakti", "/kontakti"], ["Biežākie jautājumi", "/buj"]];

export default function Page() {
  return (
    <InfoPage
      title={"Pieejamība"}
      sub={"Kā vietne strādā ar palīgtehnoloģijām"}
      lead={"Vietni veidojam tā, lai to varētu lietot ar tastatūru, ekrāna lasītāju un palielinājumu."}
      blocks={BLOCKS}
      related={RELATED}
    />
  );
}
