import Link from "next/link";
import { API_URL } from "@/lib/config";
import type { PublicAuction } from "@/lib/types";
import { Icon } from "@/components/Icon";
import { T } from "@/lib/i18n";
import { Crumbs } from "@/components/Crumbs";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Zīmoli",
  description: "Visi zīmoli, kuru preces šobrīd ir izsolēs: pulksteņi, elektronika, audio, instrumenti.",
};

/** Зная бренд-справочника в движке нет, поэтому имя бренда берём как первое
 *  слово заголовка лота. Когда в API появится поле brand — меняется только
 *  эта функция. */
function brandOf(title: string): string {
  const first = title.trim().split(/\s+/)[0] ?? "";
  return first.replace(/[^\p{L}\p{N}&.-]/gu, "");
}

export default async function BrandsPage() {
  let auctions: PublicAuction[] = [];
  try {
    const res = await fetch(`${API_URL}/api/public/auctions?limit=100`, { cache: "no-store" });
    if (res.ok) auctions = ((await res.json()) as { auctions: PublicAuction[] }).auctions;
  } catch {
    // API недоступен — покажем пустое состояние.
  }

  const counts = new Map<string, number>();
  for (const a of auctions) {
    const b = brandOf(a.title);
    if (b.length < 2) continue;
    counts.set(b, (counts.get(b) ?? 0) + 1);
  }
  const brands = [...counts.entries()].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]));

  return (
    <section className="wrap" style={{ paddingTop: 24 }}>
      <Crumbs here={<T k="misc.brands" />} />

      <div className="page-head">
        <div>
          <h1 data-hero><T k="sec.byBrand" /></h1>
          <p className="cnt">{brands.length} zīmoli · {auctions.length} aktīvi loti</p>
        </div>
        <Link className="link" href="/katalogs"><T k="hs.wholeCatalogue" /> <Icon name="arrow" size={16} /></Link>
      </div>

      {brands.length === 0 ? (
        <div className="empty">
          <span className="ic" aria-hidden="true"><Icon name="search" /></span>
          <h3><T k="misc.noActiveLots" /></h3>
          <Link className="btn btn-primary" href="/katalogs"><T k="lr.openCatalogue" /></Link>
        </div>
      ) : (
        <div className="brands">
          {brands.map(([name, n]) => (
            <Link className="brand" key={name} href={`/meklet?q=${encodeURIComponent(name)}`}>
              <b>{name}</b><span>{n} live</span>
            </Link>
          ))}
        </div>
      )}

      <p className="note" style={{ marginTop: "var(--s5)" }}>
        Zīmoli tiek noteikti pēc lota nosaukuma un atjaunojas kopā ar katalogu.
      </p>
    </section>
  );
}
