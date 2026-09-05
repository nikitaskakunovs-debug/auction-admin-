"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { publicApi } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { formatEur } from "@/lib/types";

/**
 * «Ieteikts tev» (MD §4, §7.1): вошедшему с историей — живые лоты его
 * топ-категории (+ категория-компаньон по совместным покупкам, §6.9).
 * Гостю и новичку блок не показывается вовсе — главная остаётся общей.
 * Это и есть «динамическая главная» честного размера: блок появляется и
 * встаёт первым только когда о человеке уже что-то известно.
 */

interface RecLot { id: string; title: string; priceCents: number; type: string; category: string }
interface Recs { category: string | null; companionCategory: string | null; lots: RecLot[]; companionLots: RecLot[] }

export function PersonalizedRail() {
  const { t } = useT();
  const [recs, setRecs] = useState<Recs | null>(null);

  useEffect(() => {
    if (!publicApi.hasSession) return;
    let cancelled = false;
    void publicApi.get<Recs>("/api/public/recommendations")
      .then((r) => { if (!cancelled && r.category && r.lots.length > 0) setRecs(r); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, []);

  if (!recs) return null;
  const lots = [...recs.lots.slice(0, 6), ...recs.companionLots.slice(0, 2)];

  return (
    <section className="wrap" style={{ paddingTop: 18 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 10 }}>
        <h2 style={{ margin: 0 }}>{t("pr.title")}</h2>
        <Link href={`/katalogs?category=${recs.category}`} className="note">{t("pr.all")}</Link>
      </div>
      <ul style={{
        listStyle: "none", margin: 0, padding: 0,
        display: "grid", gap: 10, gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
      }}>
        {lots.map((l) => (
          <li key={l.id} style={{ border: "1px solid var(--rule, rgba(0,0,0,.12))", borderRadius: 10 }}>
            <Link href={l.type === "fixed" ? `/listing/${l.id}` : `/auction/${l.id}`}
                  style={{ display: "flex", flexDirection: "column", gap: 4, padding: "10px 12px" }}>
              <span style={{ fontSize: 14, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{l.title}</span>
              <span className="tnum" style={{ fontWeight: 700 }}>{formatEur(l.priceCents)}</span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
