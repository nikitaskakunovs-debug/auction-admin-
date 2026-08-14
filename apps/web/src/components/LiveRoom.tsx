"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { publicApi, PublicApiError } from "@/lib/api";
import { PUBLIC_API_URL } from "@/lib/config";
import { conditionLabel } from "@/lib/conditions";
import { increment, marketFees } from "@/lib/fees";
import { useT } from "@/lib/i18n";
import { photoWeb } from "@/lib/photos";
import { useStickyBar } from "@/lib/ui";
import { formatEur, type AuctionDetail, type PublicAuction } from "@/lib/types";
import { Icon } from "./Icon";
import { useNow, formatLeft } from "./Countdown";
import { say } from "./Toast";

/** Зал живых торгов утверждённого макета.
 *
 *  Лот «на молотке» — тот, что закрывается первым; остальные живые лоты
 *  выстраиваются в очередь справа. Когда лот закрывается, зал сам переходит
 *  к следующему. */
const CAT_ICON: Record<string, string> = {
  electronics: "tv", appliances: "coffee", furniture: "chair", tools: "tools",
  home_garden: "home", jewellery_watches: "watch", art_antiques: "art",
  sports_outdoors: "bike", kids_toys: "card", fashion: "box",
  food_household: "box", other: "art",
};

const HOLD_MS = 6000;

export function LiveRoom({ auctions }: { auctions: PublicAuction[] }) {
  const { t, lang } = useT();
  const now = useNow();
  const [signedIn, setSignedIn] = useState(false);
  const [detail, setDetail] = useState<AuctionDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ text: string; tone: "win" | "out" } | null>(null);
  const [reminded, setReminded] = useState<string[]>([]);
  const [viewers, setViewers] = useState(0);
  // Список лотов зала обновляем сами: когда лот уходит с молотка,
  // в зал могут добавиться новые.
  const [live, setLive] = useState<PublicAuction[]>(auctions);

  useEffect(() => { setLive(auctions); }, [auctions]);

  useEffect(() => {
    const id = setInterval(() => {
      void publicApi.get<{ auctions: PublicAuction[] }>("/api/public/auctions?limit=24")
        .then((r) => setLive(r.auctions))
        .catch(() => { /* сеть моргнула — покажем прежний зал */ });
    }, 30_000);
    return () => clearInterval(id);
  }, []);

  // Закрытый лот держим на сцене ещё шесть секунд — чтобы «Pārdots»
  // успели увидеть, — и только потом зал переходит к следующему.
  const queue = live
    .filter((a) => a.status === "live" && new Date(a.endsAt).getTime() > now - HOLD_MS)
    .sort((a, b) => new Date(a.endsAt).getTime() - new Date(b.endsAt).getTime());
  const stage = queue[0] ?? null;
  const next = queue.slice(1, 6);

  // «Дышащий» счётчик зала. Реального числа зрителей в API пока нет —
  // считаем от числа ставок текущего лота, чтобы цифра не была выдуманной.
  useEffect(() => {
    const base = 40 + (detail?.auction.bidCount ?? 0) * 6;
    setViewers(base);
    const id = setInterval(() => setViewers(base + Math.floor(Math.random() * 12) - 6), 4000);
    return () => clearInterval(id);
  }, [detail?.auction.bidCount]);

  useEffect(() => {
    setSignedIn(publicApi.hasSession);
    const fn = () => setSignedIn(publicApi.hasSession);
    publicApi.listeners.add(fn);
    return () => { publicApi.listeners.delete(fn); };
  }, []);

  const load = useCallback(async (id: string) => {
    try { setDetail(await publicApi.get<AuctionDetail>(`/api/public/auctions/${id}`)); }
    catch { setDetail(null); }
  }, []);

  useEffect(() => { if (stage) void load(stage.id); }, [stage?.id, load]);

  // Живая лента зала.
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    if (!stage) return;
    let ws: WebSocket | null = null;
    let closed = false, retry = 0;
    const id = stage.id;
    const connect = () => {
      if (closed) return;
      ws = new WebSocket(`${PUBLIC_API_URL.replace(/^http/, "ws")}/ws`);
      ws.onopen = () => { retry = 0; ws?.send(JSON.stringify({ type: "subscribe", auctionId: id })); };
      ws.onmessage = (e) => {
        try {
          const m = JSON.parse(String(e.data)) as { type?: string };
          if (m.type === "extended") say(t("lp.extended"));
          if (m.type === "closed") say(t("lr.closed"));
        } catch { /* не JSON — просто перечитываем */ }
        void loadRef.current(id);
      };
      ws.onclose = () => { if (!closed) setTimeout(connect, Math.min(1000 * 2 ** retry++, 10_000)); };
    };
    connect();
    return () => { closed = true; ws?.close(); };
  }, [stage?.id]);

  // Хук должен вызываться до раннего возврата, иначе порядок хуков плывёт.
  useStickyBar(!!stage && new Date(stage.endsAt).getTime() - now > 0);

  if (!stage) {
    return (
      <section className="wrap" style={{ paddingTop: 24 }}>
        <nav className="crumbs" aria-label={t("nav.breadcrumb")}>
          <ol><li><Link href="/">{t("nav.home")}</Link></li><li aria-current="page">{t("lr.crumb")}</li></ol>
        </nav>
        <div className="empty">
          <span className="ic" aria-hidden="true"><Icon name="bolt" /></span>
          <h3>{t("lr.noneNow")}</h3>
          <p>{t("lr.noneNowD")}</p>
          <Link className="btn btn-primary" href="/katalogs">{t("lr.openCatalogue")}</Link>
        </div>
      </section>
    );
  }

  const price = detail?.auction.currentPriceCents ?? stage.currentPriceCents ?? stage.startPriceCents ?? 0;
  const inc = increment(price);
  const ask = detail?.minNextBidCents ?? price + inc;
  const fees = marketFees(stage.marketCode);
  const left = new Date(stage.endsAt).getTime() - now;
  const bids = detail?.bids ?? [];
  const icon = CAT_ICON[stage.category] ?? "art";
  const iLead = bids[0]?.isYou === true && !bids[0]?.outbid;
  const photo = stage.photos[0];
  const retail = (detail?.auction as { report?: { retailCents?: number | null } } | undefined)?.report?.retailCents ?? null;

  const bid = async () => {
    setBusy(true); setNotice(null);
    try {
      const r = await publicApi.post<{ youLead: boolean; currentPriceCents: number; extended: boolean }>(
        `/api/public/auctions/${stage.id}/bids`, { maxCents: ask },
      );
      setNotice(r.youLead
        ? { text: t("a.youLead"), tone: "win" }
        : { text: `${t("a.outbid")} — ${formatEur(r.currentPriceCents)}`, tone: "out" });
      say(r.youLead ? t("a.youLead") : t("a.outbid"));
      await load(stage.id);
    } catch (err) {
      if (err instanceof PublicApiError && err.body.code === "EMAIL_NOT_VERIFIED") {
        setNotice({ text: t("lc.verifyFirst"), tone: "out" });
      } else if (err instanceof PublicApiError && typeof err.body.minAcceptableCents === "number") {
        setNotice({ text: `${t("a.minBid")}: ${formatEur(err.body.minAcceptableCents)}`, tone: "out" });
      } else {
        setNotice({ text: err instanceof Error ? err.message : "error", tone: "out" });
      }
    } finally { setBusy(false); }
  };

  return (
    <section className="wrap" style={{ paddingTop: 24 }}>
      <nav className="crumbs" aria-label={t("nav.breadcrumb")}>
        <ol><li><Link href="/">{t("nav.home")}</Link></li><li aria-current="page">{t("lr.crumb")}</li></ol>
      </nav>

      <div className="page-head">
        <div>
          <h1 data-hero>{t("lr.title")}</h1>
          <p className="cnt">
            <span className="tag tag-live"><Icon name="bolt" size={12} />{t("rail.live")}</span>
            {" "}<span suppressHydrationWarning>{t("lr.meta", { n: queue.length, v: viewers })}</span>
          </p>
        </div>
        <Link className="link" href="/katalogs">{t("lr.allLots")} <Icon name="arrow" size={16} /></Link>
      </div>

      <div className="room">
        <div className="stage">
          <div className="stage-art">
            {photo ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={photoWeb(photo)} alt={stage.title} />
            ) : (
              <span className="frame-2" aria-hidden="true"><Icon name={icon} className="pic" /></span>
            )}
            <span className="stage-no">{t("lr.lotOf", { i: 1, n: queue.length })}</span>
            {left <= 0 ? (
              <span className="chant sold">{t("lr.sold")}</span>
            ) : left < 20_000 ? (
              <span className="chant go2">{t("lr.go2")}</span>
            ) : left < 60_000 ? (
              <span className="chant go1">{t("lr.go1")}</span>
            ) : null}
          </div>

          <div className="stage-body">
            <p className="kicker">{stage.sku}</p>
            <h2>{stage.title}</h2>
            <div className="grades">
              <span className="grade"><Icon name="shield" />{conditionLabel(stage.condition, t)}</span>
              <span className="grade" suppressHydrationWarning><Icon name="timer" />{formatLeft(left, lang)}</span>
            </div>

            <div className="stage-price">
              <div>
                <p className="price-lab">{t("card.currentBid")}</p>
                <p className={`big tnum${iLead ? " is-win" : ""}`} suppressHydrationWarning>{formatEur(price)}</p>
                <p className="note">
                  {t("lr.bidsStep", { n: detail?.auction.bidCount ?? stage.bidCount, inc: formatEur(inc) })}
                </p>
              </div>
              <div style={{ textAlign: "right" }}>
                <p className="price-lab">{t("lr.reserve")}</p>
                <p className="note">
                  {stage.hasReserve ? (stage.reserveMet ? t("a.reserveMet") : t("a.reserveNotMet")) : t("lr.noReserve")}
                </p>
                {retail ? <p><s className="tnum">{formatEur(retail)}</s></p> : null}
              </div>
            </div>

            {notice && <p className={`bb-status ${notice.tone}`}>{notice.text}</p>}

            <div className="stage-acts">
              {left <= 0 ? (
                <p className="bb-ended">{t("lr.hammerFell")}</p>
              ) : signedIn ? (
                <button className="btn btn-primary btn-lg" type="button" disabled={busy} onClick={() => void bid()}>
                  {t("lc.bid")}<span className="tnum">{formatEur(ask)}</span>
                </button>
              ) : (
                <Link className="btn btn-primary btn-lg" href="/login">{t("a.signinToBid")}</Link>
              )}
              {left > 0 && (
                <button className="btn btn-outline btn-lg" type="button"
                        onClick={() => say(t("lr.skipped"))}>
                  {t("lr.skipLot")}
                </button>
              )}
            </div>

            <p className="fine">
              {t("lr.fine", { prem: fees.buyerPremiumBp / 100, vat: fees.vatRateBp / 100 })}
            </p>
          </div>
        </div>

        <aside className="room-side">
          <div className="feedbox">
            <div className="fb-head">
              <h2>{t("lr.room")}</h2>
              <span className="tag"><i className="livedot" aria-hidden="true" />Live</span>
            </div>
            <ul className="feed">
              {bids.length === 0 && <li><span className="nm">{t("lp.noBidsYet")}</span></li>}
              {bids.slice(0, 8).map((b) => (
                <li key={b.seq} className={b.isYou ? "you" : undefined}
                    style={b.outbid ? { opacity: 0.62 } : undefined}>
                  <span className="av" aria-hidden="true">{b.isYou ? "★" : b.alias.slice(0, 1)}</span>
                  <span className="nm">{b.alias}{b.isYou && ` · ${t("a.you")}`}</span>
                  <span className="am tnum">{formatEur(b.amountCents)}</span>
                  <span className="ago" suppressHydrationWarning>
                    {new Date(b.createdAt).toLocaleTimeString("lv-LV", { hour: "2-digit", minute: "2-digit" })}
                  </span>
                </li>
              ))}
            </ul>
          </div>

          <div className="queue">
            <h2>{t("lr.nextLots")}</h2>
            <ol>
              {next.map((q) => (
                <li key={q.id}>
                  <span className="q-ic" aria-hidden="true"><Icon name={CAT_ICON[q.category] ?? "art"} /></span>
                  <span className="q-t">
                    <b>{q.title}</b>
                    <small>{q.sku} · {t("lr.startPrice", { sum: formatEur(q.startPriceCents ?? 0) })}</small>
                  </span>
                  <button className="q-b" type="button" aria-label={t("lr.remindBefore", { title: q.title })}
                          aria-pressed={reminded.includes(q.id)}
                          onClick={() => {
                            setReminded((r) => r.includes(q.id) ? r.filter((x) => x !== q.id) : [...r, q.id]);
                            say(reminded.includes(q.id) ? t("lr.remindOff") : t("lr.remindOn"));
                          }}><Icon name="bell" size={16} /></button>
                </li>
              ))}
              {next.length === 0 && <li><span className="q-t"><b>{t("lr.lastLot")}</b></span></li>}
            </ol>
          </div>
        </aside>
      </div>

      {left > 0 && (
        <div className="bidbar">
          <div className="t">
            <span className="lab" suppressHydrationWarning>{formatLeft(left, lang)}{iLead ? t("lp.youLeadShort") : ""}</span>
            <b className="tnum">{formatEur(price)}</b>
          </div>
          {signedIn ? (
            <button className="btn btn-primary" type="button" disabled={busy} onClick={() => void bid()}>
              {t("lc.bid")}<span className="tnum">{formatEur(ask)}</span>
            </button>
          ) : (
            <Link className="btn btn-primary" href="/login?next=/tiesraide">{t("a.signinToBid")}</Link>
          )}
        </div>
      )}
    </section>
  );
}
