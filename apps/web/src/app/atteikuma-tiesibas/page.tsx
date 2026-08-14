import { InfoPage, type InfoBlock } from "@/components/InfoPage";

export const metadata = {
  title: "Atteikuma tiesības",
  description: "Patērētājam ir tiesības atteikties no distances līgumā iegādātās preces 14 dienu laikā no tās saņemšanas.",
};

const BLOCKS: InfoBlock[] = [
  {
    "h": "Termiņš"
  },
  {
    "p": "14 dienas skaita no dienas, kad prece nonāk tavā valdījumā. Paziņojumu par atteikumu pietiek nosūtīt termiņa pēdējā dienā."
  },
  {
    "h": "Preces stāvoklis"
  },
  {
    "p": "Preci atgriež tādā stāvoklī, kādā tā saņemta. Preci drīkst apskatīt un pārbaudīt tāpat, kā to varētu darīt veikalā; ja vērtība samazinājusies plašākas lietošanas dēļ, atmaksu var attiecīgi samazināt."
  },
  {
    "h": "Izmaksas"
  },
  {
    "p": "Atgriešanas izmaksas sedz pircējs, izņemot gadījumus, kad prece ir bojāta vai neatbilst aprakstam — tad sedzam mēs."
  },
  {
    "h": "Atmaksa"
  },
  {
    "p": "Naudu atmaksājam 14 dienu laikā pēc preces saņemšanas atpakaļ, uz to pašu maksājuma līdzekli, ar kuru veikts pirkums."
  },
  {
    "h": "Kad atteikuma tiesības nav piemērojamas"
  },
  {
    "bad": [
      "Preces, kas izgatavotas pēc individuāla pasūtījuma",
      "Higiēnas preces ar atvērtu iepakojumu",
      "Atvērti audio/video ieraksti un programmatūra"
    ]
  },
  {
    "note": "Šī lapa ir informatīva. Strīdu gadījumā piemērojams Patērētāju tiesību aizsardzības likums un ES Direktīva 2011/83/ES."
  }
];

const RELATED: Array<[string, string]> = [["Bojāta prece", "/bojata-prece"], ["Sūdzību izskatīšana", "/sudzibas"], ["Kontakti", "/kontakti"]];

export default function Page() {
  return (
    <InfoPage
      title={"Atteikuma tiesības"}
      sub={"14 dienas preces atgriešanai"}
      lead={"Patērētājam ir tiesības atteikties no distances līgumā iegādātās preces 14 dienu laikā no tās saņemšanas."}
      blocks={BLOCKS}
      related={RELATED}
    />
  );
}
