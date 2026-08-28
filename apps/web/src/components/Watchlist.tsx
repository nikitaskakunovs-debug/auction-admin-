"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { FixedListing, PublicAuction } from "@/lib/types";
import { publicApi } from "@/lib/api";
import { watchStore } from "@/lib/watch";
import { useT } from "@/lib/i18n";
import { Icon } from "./Icon";
import { fixedToCard, LotCard, type CardLot } from "./LotCard";

/** Вэлмес — сохранённые лоты. Список ID хранится у вошедшего в базе, у гостя —
 *  в браузере; сами лоты приходят из каталога. */
export function Watchlist({ auctions, listings = [] }: { auctions: PublicAuction[]; listings?: FixedListing[] }) {
  const { t } = useT();
  const [ids, setIds] = useState<string[] | null>(null);
  const [signedIn, setSignedIn] = useState(false);

  useEffect(() => {
    const sync = () => setIds(watchStore.list());
    sync();
    setSignedIn(publicApi.hasSession);
    const onSession = () => setSignedIn(publicApi.hasSession);
    publicApi.listeners.add(onSession);
    const off = watchStore.subscribe(sync);
    return () => { publicApi.listeners.delete(onSession); off(); };
  }, []);

  const pool: CardLot[] = [...auctions, ...listings.map(fixedToCard)];
  const rows = ids === null ? [] : pool.filter((a) => ids.includes(a.id));
  const missing = ids === null ? 0 : ids.length - rows.length;

  return (
    <section className="wrap" style={{ paddingTop: 24 }}>
      <nav className="crumbs" aria-label={t("nav.breadcrumb")}>
        <ol><li><Link href="/">{t("nav.home")}</Link></li><li aria-current="page">{t("wl.title")}</li></ol>
      </nav>

      <div className="page-head">
        <div>
          <h1 data-hero>{t("wl.title")}</h1>
          <p className="cnt">
            {ids === null ? t("wl.loading") : t("wl.activeN", { n: rows.length })}
            {missing > 0 && t("wl.closedN", { n: missing })}
          </p>
        </div>
        {rows.length > 0 && (
          <button className="btn btn-outline btn-sm" type="button"
                  onClick={() => rows.forEach((r) => watchStore.toggle(r.id))}>
            {t("wl.clear")}
          </button>
        )}
      </div>

      {ids !== null && rows.length === 0 ? (
        <div className="empty">
          <span className="ic" aria-hidden="true"><Icon name="heart" /></span>
          <h3>{t("wl.emptyTitle")}</h3>
          <p>{t("wl.emptyText")}</p>
          <Link className="btn btn-primary" href="/katalogs">{t("catalog.all")}</Link>
        </div>
      ) : (
        <div className="results">
          {rows.map((a) => <LotCard key={a.id} lot={a as CardLot} />)}
        </div>
      )}

      <p className="note" style={{ marginTop: "var(--s5)" }}>
        {t(signedIn ? "wl.syncedNote" : "wl.localNote")}
      </p>
    </section>
  );
}
