"use client";

import Link from "next/link";
import { useState } from "react";
import { conditionLabel } from "@/lib/conditions";
import { useT } from "@/lib/i18n";
import { photoThumb } from "@/lib/photos";
import { formatEur, type PublicAuction } from "@/lib/types";
import { Icon } from "./Icon";

/** Результаты прошедших изсоле: что продано, за сколько и сколько было ставок.
 *  Индексируемая страница — на неё ссылается утилити-полоса и SEO-блок. */
export function Results({ auctions }: { auctions: PublicAuction[] }) {
  const { t } = useT();
  const [cat, setCat] = useState("all");
  const [only, setOnly] = useState<"all" | "sold" | "unsold">("all");

  const cats = Array.from(new Set(auctions.map((a) => a.category)));
  const sold = (a: PublicAuction) => a.status === "ended_won";

  const rows = auctions.filter((a) => {
    if (cat !== "all" && a.category !== cat) return false;
    if (only === "sold" && !sold(a)) return false;
    if (only === "unsold" && sold(a)) return false;
    return true;
  });

  const total = rows.filter(sold).reduce((s, a) => s + (a.currentPriceCents ?? 0), 0);

  return (
    <section className="wrap" style={{ paddingTop: 24 }}>
      <nav className="crumbs" aria-label="Navigācijas ceļš">
        <ol><li><Link href="/">Sākums</Link></li><li aria-current="page">Izsoļu rezultāti</li></ol>
      </nav>

      <div className="page-head">
        <div>
          <h1 data-hero>Izsoļu rezultāti</h1>
          <p className="cnt">
            {rows.length} noslēgti loti · pārdošanas summa {formatEur(total)}
          </p>
        </div>
        <Link className="link" href="/katalogs">Aktīvie loti <Icon name="arrow" size={16} /></Link>
      </div>

      <div className="hrail" style={{ gap: 8, paddingBottom: 8 }}>
        {([["all", "Visi"], ["sold", "Pārdotie"], ["unsold", "Nepārdotie"]] as const).map(([id, label]) => (
          <button key={id} className={`chip${only === id ? " chip-dark" : ""}`} type="button"
                  aria-pressed={only === id} style={{ flex: "0 0 auto" }}
                  onClick={() => setOnly(id)}>{label}</button>
        ))}
        <span style={{ flex: "0 0 8px" }} aria-hidden="true" />
        <button className={`chip${cat === "all" ? " chip-dark" : ""}`} type="button"
                aria-pressed={cat === "all"} style={{ flex: "0 0 auto" }}
                onClick={() => setCat("all")}>Visas kategorijas</button>
        {cats.map((c) => (
          <button key={c} className={`chip${cat === c ? " chip-dark" : ""}`} type="button"
                  aria-pressed={cat === c} style={{ flex: "0 0 auto" }}
                  onClick={() => setCat(c)}>{t(`cat.${c}`)}</button>
        ))}
      </div>

      {rows.length === 0 ? (
        <div className="empty">
          <span className="ic" aria-hidden="true"><Icon name="search" /></span>
          <h3>Rezultātu vēl nav</h3>
          <p>Kad pirmās izsoles noslēgsies, tās parādīsies šeit.</p>
          <Link className="btn btn-primary" href="/katalogs">Skatīt aktīvos lotus</Link>
        </div>
      ) : (
        <table className="rslt">
          <thead>
            <tr>
              <th scope="col">Lots</th>
              <th scope="col">Stāvoklis</th>
              <th scope="col">Solījumi</th>
              <th scope="col">Rezultāts</th>
              <th scope="col">Beidzās</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((a) => (
              <tr key={a.id}>
                <td>
                  <Link className="rslt-lot" href={`/auction/${a.id}`}>
                    <span className="ic" aria-hidden="true">
                      {a.photos[0] ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={photoThumb(a.photos[0])} alt="" loading="lazy" />
                      ) : <Icon name="art" />}
                    </span>
                    <span><b>{a.title}</b><small>{a.sku}</small></span>
                  </Link>
                </td>
                <td>{conditionLabel(a.condition, t)}</td>
                <td className="tnum">{a.bidCount}</td>
                <td>
                  {sold(a)
                    ? <b className="tnum">{formatEur(a.currentPriceCents ?? 0)}</b>
                    : <span className="tag">Nepārdots</span>}
                </td>
                <td className="tnum" suppressHydrationWarning>
                  {new Date(a.endsAt).toLocaleDateString("lv-LV")}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <p className="note" style={{ marginTop: "var(--s5)" }}>
        Rezultāti rāda āmura cenu bez pircēja komisijas un PVN.
        Nepārdotie loti ir tie, kuriem netika sasniegta rezerves cena.
      </p>
    </section>
  );
}
