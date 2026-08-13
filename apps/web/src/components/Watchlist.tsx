"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { PublicAuction } from "@/lib/types";
import { watchStore } from "@/lib/watch";
import { Icon } from "./Icon";
import { LotCard, type CardLot } from "./LotCard";

/** Вэлмес — сохранённые лоты. Список ID живёт локально (в движке пока нет
 *  вотчлиста), сами лоты приходят из каталога. */
export function Watchlist({ auctions }: { auctions: PublicAuction[] }) {
  const [ids, setIds] = useState<string[] | null>(null);

  useEffect(() => {
    const sync = () => setIds(watchStore.list());
    sync();
    return watchStore.subscribe(sync);
  }, []);

  const rows = ids === null ? [] : auctions.filter((a) => ids.includes(a.id));
  const missing = ids === null ? 0 : ids.length - rows.length;

  return (
    <section className="wrap" style={{ paddingTop: 24 }}>
      <nav className="crumbs" aria-label="Navigācijas ceļš">
        <ol><li><Link href="/">Sākums</Link></li><li aria-current="page">Vēlmju saraksts</li></ol>
      </nav>

      <div className="page-head">
        <div>
          <h1 data-hero>Vēlmju saraksts</h1>
          <p className="cnt">
            {ids === null ? "Ielādē…" : `${rows.length} aktīvi loti`}
            {missing > 0 && ` · ${missing} jau noslēgušies`}
          </p>
        </div>
        {rows.length > 0 && (
          <button className="btn btn-outline btn-sm" type="button"
                  onClick={() => rows.forEach((r) => watchStore.toggle(r.id))}>
            Notīrīt sarakstu
          </button>
        )}
      </div>

      {ids !== null && rows.length === 0 ? (
        <div className="empty">
          <span className="ic" aria-hidden="true"><Icon name="heart" /></span>
          <h3>Saraksts ir tukšs</h3>
          <p>Nospied sirsniņu uz jebkura lota — tas parādīsies šeit, un mēs brīdināsim pirms beigām.</p>
          <Link className="btn btn-primary" href="/katalogs">Atrast lotus</Link>
        </div>
      ) : (
        <div className="results">
          {rows.map((a) => <LotCard key={a.id} lot={a as CardLot} />)}
        </div>
      )}

      <p className="note" style={{ marginTop: "var(--s5)" }}>
        Saraksts glabājas šajā pārlūkā. Pēc pieteikšanās tas tiks piesaistīts kontam.
      </p>
    </section>
  );
}
