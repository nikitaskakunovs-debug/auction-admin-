"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { publicApi, PublicApiError } from "@/lib/api";
import { dateLocale, useT } from "@/lib/i18n";
import { formatEur, type PublicAuction } from "@/lib/types";
import { Ph } from "../Ph";
import { say } from "../Toast";

/** История ставок по лоту (макет № 79).
 *
 *  Публичная лента движка уже отдаёт всё нужное: псевдонимы вместо имён,
 *  флаг «авто», отметку своих строк. Максимумы в ленте не показываются
 *  никому — это правило движка, не вёрстки.
 */
interface LedgerRow {
  alias: string;
  amountCents: number;
  auto: boolean;
  outbid: boolean;
  seq: number;
  createdAt: string;
  isYou: boolean;
}

export function BidHistory({ auctionId, onBack }: { auctionId: string; onBack: () => void }) {
  const { t, lang } = useT();
  const [auction, setAuction] = useState<PublicAuction | null>(null);
  const [rows, setRows] = useState<LedgerRow[]>([]);
  const [minNext, setMinNext] = useState(0);
  const [maxDraft, setMaxDraft] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () =>
      void publicApi
        .get<{ auction: PublicAuction; minNextBidCents: number; bids: LedgerRow[] }>(`/api/public/auctions/${auctionId}`)
        .then((r) => { if (alive) { setAuction(r.auction); setRows(r.bids); setMinNext(r.minNextBidCents); } })
        .catch(() => undefined);
    load();
    const timer = setInterval(load, 3_000);
    return () => { alive = false; clearInterval(timer); };
  }, [auctionId]);

  if (!auction) return <div className="acct" aria-busy="true" />;

  const bidders = new Set(rows.map((r) => r.alias)).size;
  const live = auction.status === "live";
  const when = (iso: string) =>
    new Date(iso).toLocaleString(dateLocale(lang), { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });

  const bid = async (maxCents: number) => {
    try {
      await publicApi.post(`/api/public/auctions/${auction.id}/bids`, { maxCents });
      say(t("kb.bidOk"));
    } catch (err) {
      if (err instanceof PublicApiError) say(err.message);
    }
  };

  return (
    <div className="acct">
      <button className="btn-back" type="button" onClick={onBack}>
        <Ph name="caret-right" size={14} className="flip" /> {t("acc.myBids")}
      </button>
      <div className="page-head" style={{ alignItems: "flex-start" }}>
        <div>
          <h1 data-hero>{t("kb.historyTitle")}</h1>
          <p className="cnt tnum">{t("kb.lot")} {auction.sku} · {auction.title}</p>
        </div>
      </div>

      <p className="ledger-sum">
        <Ph name="gavel" size={18} />
        <span>
          {t("kb.historySummary", {
            bidders, bids: rows.length,
            start: formatEur(auction.startPriceCents ?? 0),
          })}
        </span>
        <small>{t("kb.historyAnon")}</small>
      </p>

      <div className="ledger">
        <div className="ledger-h">
          <span>{t("kb.historyTitle")}</span>
          <span className="r">{t("kb.yourBid")}</span>
        </div>
        {rows.map((r) => (
          <div className={`ledger-r${r.isYou ? " you" : ""}`} key={r.seq}>
            <span className="ava" aria-hidden="true">{r.alias.slice(0, 1).toUpperCase()}</span>
            <span className="t">
              <b>{r.alias}</b>
              <small className="tnum">
                {when(r.createdAt)}
                {r.auto && <i className="tag-auto">{t("kb.auto")}</i>}
                {live && !r.outbid && <i className="tag-lead">{t("kb.leads")}</i>}
              </small>
            </span>
            <b className="am tnum">{formatEur(r.amountCents)}</b>
          </div>
        ))}
      </div>

      <p className="note">{t("kb.whyAuto")}</p>

      <div className="acts">
        {live && (
          <button className="btn btn-primary" type="button" onClick={() => bid(minNext)}>
            {t("kb.bidSum", { sum: formatEur(minNext) })}
          </button>
        )}
        {live && maxDraft === null && (
          <button className="btn btn-outline" type="button" onClick={() => setMaxDraft("")}>{t("kb.changeMax")}</button>
        )}
        {live && maxDraft !== null && (
          <span className="edit">
            <input
              inputMode="decimal" autoFocus placeholder={formatEur(minNext)} value={maxDraft}
              aria-label={t("kb.changeMax")}
              onChange={(e) => setMaxDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== "Enter") return;
                const eur = Number(maxDraft.replace(",", "."));
                if (Number.isFinite(eur) && eur > 0) { void bid(Math.round(eur * 100)); setMaxDraft(null); }
              }}
            />
            <button
              className="btn btn-primary btn-sm" type="button"
              onClick={() => {
                const eur = Number(maxDraft.replace(",", "."));
                if (Number.isFinite(eur) && eur > 0) { void bid(Math.round(eur * 100)); setMaxDraft(null); }
              }}
            >{t("ac.save")}</button>
          </span>
        )}
        <Link className="btn btn-outline" href={`/auction/${auction.id}`}>{t("kb.toLot")}</Link>
      </div>
    </div>
  );
}
