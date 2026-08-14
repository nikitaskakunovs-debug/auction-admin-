import { API_URL } from "@/lib/config";
import type { FixedListing, PublicAuction } from "@/lib/types";
import { headers } from "next/headers";
import { originForHost } from "@/lib/country";
import { jsonLdScript } from "@/lib/jsonld";
import { HomeSections } from "@/components/HomeSections";

export const dynamic = "force-dynamic";

/** Те же четыре вопроса, что стоят в FAQ-блоке главной (Sections.tsx). */
const HOME_FAQ: Array<[string, string]> = [
  ["Kāpēc preces ir lētākas nekā veikalā?",
   "Mēs pērkam noliktavu atlikumus, klientu atgriezumus un vienas īpašnieka kolekcijas veselos apjomos."],
  ["Kas notiek, ja mani pārsola?",
   "Saņem paziņojumu e-pastā un lietotnē. Ja esi norādījis maksimālo summu, sistēma automātiski pārsola pretinieku par vienu soli."],
  ["Vai varu atgriezt preci?",
   "Jā. Patērētājam ir 14 dienu atteikuma tiesības saskaņā ar Patērētāju tiesību aizsardzības likumu."],
  ["Cik maksā piegāde?",
   "Piegāde uz pakomātu visā Latvijā ir ar fiksētu cenu; lotus var arī izņemt klātienē Rīgā bez maksas."],
];

export default async function HomePage() {
  let auctions: PublicAuction[] = [];
  let listings: FixedListing[] = [];
  try {
    const [aRes, lRes] = await Promise.all([
      fetch(`${API_URL}/api/public/auctions`, { cache: "no-store" }),
      fetch(`${API_URL}/api/public/listings`, { cache: "no-store" }),
    ]);
    if (aRes.ok) auctions = ((await aRes.json()) as { auctions: PublicAuction[] }).auctions;
    if (lRes.ok) listings = ((await lRes.json()) as { listings: FixedListing[] }).listings;
  } catch {
    // API down — render the empty state; the page must never 500 on SSR.
  }
  // Разметка, которую Google реально показывает в выдаче: строка поиска по сайту
  // и раскрытые вопросы FAQ-блока, который стоит внизу главной.
  const origin = originForHost((await headers()).get("host"));
  const jsonLd = [
    {
      "@context": "https://schema.org", "@type": "WebSite", name: "Izsoli.lv",
      url: `${origin}/`, inLanguage: "lv",
      potentialAction: {
        "@type": "SearchAction",
        target: { "@type": "EntryPoint", urlTemplate: `${origin}/meklet?q={search_term_string}` },
        "query-input": "required name=search_term_string",
      },
    },
    {
      "@context": "https://schema.org", "@type": "FAQPage",
      mainEntity: HOME_FAQ.map(([name, text]) => ({
        "@type": "Question", name,
        acceptedAnswer: { "@type": "Answer", text },
      })),
    },
  ];

  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdScript(jsonLd) }} />
      <HomeSections auctions={auctions} listings={listings} />
    </>
  );
}
