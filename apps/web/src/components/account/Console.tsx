"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { publicApi, PublicApiError } from "@/lib/api";
import { PUBLIC_API_URL } from "@/lib/config";
import { useT, type Lang } from "@/lib/i18n";
import { photoThumb } from "@/lib/photos";
import { formatEur, type PublicAuction } from "@/lib/types";
import { Countdown } from "../Countdown";
import { Ph } from "../Ph";
import { say } from "../Toast";
import type { MyBidAuction } from "./data";

/** Живая консоль (макет № 02–04): до четырёх лотов одновременно.
 *
 *  Выбор лотов хранится в браузере — консоль это рабочий стол, а не данные.
 *  Каждая карточка опрашивает свой лот раз в ~2,5 с: цена, статус, минимальный
 *  следующий шаг и полная стоимость с комиссией и НДС приходят из движка,
 *  сами мы ничего не считаем.
 */
const STORE = "izsoli_konsole_v1";
const MAX_LOTS = 4;

function readIds(): string[] {
  try { return (JSON.parse(localStorage.getItem(STORE) ?? "[]") as string[]).slice(0, MAX_LOTS); }
  catch { return []; }
}

interface LotState {
  auction: PublicAuction;
  minNextBidCents: number;
  estimatedTotalCents: number;
  youLead: boolean;
}

export function Console({ bids, watched }: { bids: MyBidAuction[]; watched: PublicAuction[] }) {
  const { t, lang } = useT();
  const [ids, setIds] = useState<string[]>([]);
  const [lots, setLots] = useState<Record<string, LotState>>({});
  const alive = useRef(true);

  useEffect(() => { setIds(readIds()); }, []);
  useEffect(() => () => { alive.current = false; }, []);

  const save = (next: string[]) => {
    setIds(next);
    try { localStorage.setItem(STORE, JSON.stringify(next)); } catch { /* приватный режим */ }
  };

  const load = useCallback(async (id: string) => {
    try {
      const r = await publicApi.get<{
        auction: PublicAuction; minNextBidCents: number; estimatedTotalCents: number;
        bids: Array<{ isYou: boolean; outbid: boolean }>;
      }>(`/api/public/auctions/${id}`);
      if (!alive.current) return;
      const youLead = r.bids.some((b) => b.isYou && !b.outbid);
      setLots((cur) => ({ ...cur, [id]: { auction: r.auction, minNextBidCents: r.minNextBidCents, estimatedTotalCents: r.estimatedTotalCents, youLead } }));
    } catch { /* лот пропал — карточка покажет последнее известное */ }
  }, []);

  // Опрос: все карточки по кругу, живым — каждые 2,5 с.
  useEffect(() => {
    if (ids.length === 0) return;
    for (const id of ids) void load(id);
    const timer = setInterval(() => { for (const id of ids) void load(id); }, 2_500);
    return () => clearInterval(timer);
  }, [ids, load]);

  const bid = async (id: string, maxCents: number) => {
    try {
      await publicApi.post(`/api/public/auctions/${id}/bids`, { maxCents });
      say(t("kb.bidOk"));
      void load(id);
    } catch (err) {
      if (err instanceof PublicApiError) say(err.message);
      void load(id);
    }
  };

  // Кандидаты в консоль: мои живые ставки + наблюдаемые живые лоты.
  const inConsole = new Set(ids);
  const candidates: PublicAuction[] = [
    ...bids.filter((b) => b.status === "live"),
    ...watched.filter((w) => w.status === "live" && !bids.some((b) => b.id === w.id)),
  ].filter((a) => !inConsole.has(a.id));

  const totalIfWin = ids.reduce((sum, id) => sum + (lots[id]?.estimatedTotalCents ?? 0), 0);

  return (
    <div className="konsole">
      <div className="k-head">
        <p className="k-intro">{t("kb.consoleIntro")}</p>
        {ids.length > 0 && (
          <button className="btn btn-outline btn-sm" type="button" onClick={() => save([])}>{t("kb.clearAll")}</button>
        )}
      </div>

      {ids.length === 0 ? (
        <div className="empty">
          <span className="ic" aria-hidden="true"><Ph name="gavel" size={22} /></span>
          <h3>{t("kb.consoleEmptyT")}</h3>
          <p>{t("kb.consoleEmptyD")}</p>
        </div>
      ) : (
        <>
          <div className={`k-grid n${ids.length}`}>
            {ids.map((id) => (
              <ConsoleCard
                key={id}
                state={lots[id]}
                lang={lang}
                onBid={(max) => bid(id, max)}
                onRemove={() => save(ids.filter((x) => x !== id))}
              />
            ))}
          </div>
          {totalIfWin > 0 && (
            <p className="k-sum">
              <Ph name="shield-check" size={18} />
              <span className="lbl">{t("kb.ifWinAll")} <small>{t("kb.withFees")}</small></span>
              <b className="tnum">{formatEur(totalIfWin)}</b>
            </p>
          )}
        </>
      )}

      <div className="k-add">
        <div className="k-add-head">
          <h3 className="ttl-sm">{t("kb.addToConsole")}</h3>
          <span className="cnt">{t("kb.addedCount", { n: ids.length })}</span>
        </div>
        {candidates.length === 0 ? (
          <p className="note">{t("kb.noMoreLots")}</p>
        ) : (
          candidates.slice(0, 6).map((a) => (
            <div className="k-cand" key={a.id}>
              <span className="pic" aria-hidden="true">{a.photos[0] ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={photoThumb(a.photos[0])} alt="" loading="lazy" />
              ) : <Ph name="gavel" size={18} />}</span>
              <span className="t">
                <b>{a.title}</b>
                <small className="tnum">{a.sku} · {formatEur(a.currentPriceCents ?? a.startPriceCents ?? 0)} · <Countdown endsAt={a.endsAt} lang={lang} /></small>
              </span>
              <button
                className="btn btn-outline btn-sm" type="button"
                disabled={ids.length >= MAX_LOTS}
                onClick={() => save([...ids, a.id].slice(0, MAX_LOTS))}
              >
                <Ph name="plus" size={14} /> {t("kb.add")}
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function ConsoleCard({
  state, lang, onBid, onRemove,
}: {
  state: LotState | undefined;
  lang: Lang;
  onBid: (maxCents: number) => void;
  onRemove: () => void;
}) {
  const { t } = useT();
  const [autoOpen, setAutoOpen] = useState(false);
  const [maxDraft, setMaxDraft] = useState("");

  if (!state) {
    return <article className="kcard loading" aria-busy="true" />;
  }
  const a = state.auction;
  const live = a.status === "live";
  const won = !live && state.youLead;
  const price = a.currentPriceCents ?? a.startPriceCents ?? 0;
  const tone = state.youLead ? "lead" : "out";

  const submitMax = () => {
    const eur = Number(maxDraft.replace(",", "."));
    if (!Number.isFinite(eur) || eur <= 0) return;
    onBid(Math.round(eur * 100));
    setAutoOpen(false);
    setMaxDraft("");
  };

  return (
    <article className={`kcard ${tone}`}>
      <div className="k-media">
        {a.photos[0] ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={photoThumb(a.photos[0])} alt="" loading="lazy" />
        ) : (
          <Ph name="gavel" size={28} className="ph-empty" />
        )}
        <span className="k-timer"><Countdown endsAt={a.endsAt} lang={lang} /></span>
        <button className="k-x" type="button" aria-label={t("kb.remove")} onClick={onRemove}><Ph name="x" size={14} /></button>
        <span className={`k-state ${tone}`}>
          <i aria-hidden="true" />
          {live ? (state.youLead ? t("kb.youLead") : t("kb.youOutbid")) : won ? t("ac.youWon") : t("card.ended")}
        </span>
      </div>

      <div className="k-body">
        <div className="k-meta">
          <span className="tnum">{a.sku}</span>
          <span>{t("kb.bidsN", { n: a.bidCount })}</span>
        </div>
        <h3><Link href={`/auction/${a.id}`}>{a.title}</Link></h3>
        <p className="k-now">
          <small>{t("kb.nowPrice")}</small>
          <b className="tnum">{formatEur(price)}</b>
        </p>

        {live && (
          <>
            <button className="btn btn-primary k-bid" type="button" onClick={() => onBid(state.minNextBidCents)}>
              {t("kb.bidSum", { sum: formatEur(state.minNextBidCents) })}
            </button>
            <div className={`k-auto${autoOpen ? " open" : ""}`}>
              <button
                className="k-auto-t" type="button" role="switch" aria-checked={autoOpen}
                onClick={() => setAutoOpen((v) => !v)}
              >
                <i aria-hidden="true" />
                <span>{autoOpen ? t("kb.autoToShort") : t("kb.autoTo")}</span>
              </button>
              {autoOpen && (
                <span className="k-auto-in">
                  <input
                    inputMode="decimal" placeholder={formatEur(state.minNextBidCents)} value={maxDraft}
                    aria-label={t("kb.autoTo")}
                    onChange={(e) => setMaxDraft(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") submitMax(); }}
                  />
                  <button className="btn btn-primary btn-sm" type="button" onClick={submitMax}>{t("ac.save")}</button>
                </span>
              )}
            </div>
          </>
        )}
      </div>
    </article>
  );
}
