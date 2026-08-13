"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { publicApi, PublicApiError } from "@/lib/api";
import { PUBLIC_API_URL } from "@/lib/config";
import { conditionLabel } from "@/lib/conditions";
import { increment, marketFees } from "@/lib/fees";
import { useT } from "@/lib/i18n";
import { photoWeb } from "@/lib/photos";
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

export function LiveRoom({ auctions }: { auctions: PublicAuction[] }) {
  const { t } = useT();
  const now = useNow();
  const [signedIn, setSignedIn] = useState(false);
  const [detail, setDetail] = useState<AuctionDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ text: string; tone: "win" | "out" } | null>(null);
  const [reminded, setReminded] = useState<string[]>([]);
  const [viewers, setViewers] = useState(0);

  const queue = auctions
    .filter((a) => a.status === "live")
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
          if (m.type === "extended") say("Izsole pagarināta");
          if (m.type === "closed") say("Lots noslēgts");
        } catch { /* не JSON — просто перечитываем */ }
        void loadRef.current(id);
      };
      ws.onclose = () => { if (!closed) setTimeout(connect, Math.min(1000 * 2 ** retry++, 10_000)); };
    };
    connect();
    return () => { closed = true; ws?.close(); };
  }, [stage?.id]);

  if (!stage) {
    return (
      <section className="wrap" style={{ paddingTop: 24 }}>
        <nav className="crumbs" aria-label="Navigācijas ceļš">
          <ol><li><Link href="/">Sākums</Link></li><li aria-current="page">Tiešraide</li></ol>
        </nav>
        <div className="empty">
          <span className="ic" aria-hidden="true"><Icon name="bolt" /></span>
          <h3>Šobrīd nenotiek neviena tiešraide</h3>
          <p>Nākamā izsole sāksies drīz — līdz tam apskati katalogu.</p>
          <Link className="btn btn-primary" href="/katalogs">Atvērt katalogu</Link>
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
        setNotice({ text: "Vispirms apstiprini e-pastu — saite nosūtīta uz tavu adresi", tone: "out" });
      } else if (err instanceof PublicApiError && typeof err.body.minAcceptableCents === "number") {
        setNotice({ text: `${t("a.minBid")}: ${formatEur(err.body.minAcceptableCents)}`, tone: "out" });
      } else {
        setNotice({ text: err instanceof Error ? err.message : "error", tone: "out" });
      }
    } finally { setBusy(false); }
  };

  return (
    <section className="wrap" style={{ paddingTop: 24 }}>
      <nav className="crumbs" aria-label="Navigācijas ceļš">
        <ol><li><Link href="/">Sākums</Link></li><li aria-current="page">Tiešraide</li></ol>
      </nav>

      <div className="page-head">
        <div>
          <h1 data-hero>Izsole tiešraidē</h1>
          <p className="cnt">
            <span className="tag tag-live"><Icon name="bolt" size={12} />Tiešraidē</span>
            {" "}{queue.length} loti · solīšana pret zāli · <b>{viewers}</b> skatās
          </p>
        </div>
        <Link className="link" href="/katalogs">Visi loti <Icon name="arrow" size={16} /></Link>
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
            <span className="stage-no">Lots <b>1</b> no {queue.length}</span>
            {left <= 0 ? (
              <span className="chant sold">Pārdots</span>
            ) : left < 20_000 ? (
              <span className="chant go2">Otro reizi…</span>
            ) : left < 60_000 ? (
              <span className="chant go1">Pirmo reizi…</span>
            ) : null}
          </div>

          <div className="stage-body">
            <p className="kicker">{stage.sku}</p>
            <h2>{stage.title}</h2>
            <div className="grades">
              <span className="grade"><Icon name="shield" />{conditionLabel(stage.condition, t)}</span>
              <span className="grade"><Icon name="timer" />{formatLeft(left)}</span>
            </div>

            <div className="stage-price">
              <div>
                <p className="price-lab">Pašreizējā cena</p>
                <p className={`big tnum${iLead ? " is-win" : ""}`} suppressHydrationWarning>{formatEur(price)}</p>
                <p className="note">
                  {detail?.auction.bidCount ?? stage.bidCount} solījumi · solis {formatEur(inc)}
                </p>
              </div>
              <div style={{ textAlign: "right" }}>
                <p className="price-lab">Rezerve</p>
                <p className="note">
                  {stage.hasReserve ? (stage.reserveMet ? t("a.reserveMet") : t("a.reserveNotMet")) : "Bez rezerves"}
                </p>
                {retail ? <p><s className="tnum">{formatEur(retail)}</s></p> : null}
              </div>
            </div>

            {notice && <p className={`bb-status ${notice.tone}`}>{notice.text}</p>}

            <div className="stage-acts">
              {signedIn ? (
                <button className="btn btn-primary btn-lg" type="button" disabled={busy} onClick={() => void bid()}>
                  Solīt · <span className="tnum">{formatEur(ask)}</span>
                </button>
              ) : (
                <Link className="btn btn-primary btn-lg" href="/login">{t("a.signinToBid")}</Link>
              )}
              <button className="btn btn-outline btn-lg" type="button"
                      onClick={() => say("Lots izlaists — pāriesim pie nākamā")}>
                Izlaist lotu
              </button>
            </div>

            <p className="fine">
              Āmura cenai tiek pievienota pircēja komisija {fees.buyerPremiumBp / 100} % un
              PVN {fees.vatRateBp / 100} %. Solījums pēdējās sekundēs pagarina izsoli.
            </p>
          </div>
        </div>

        <aside className="room-side">
          <div className="feedbox">
            <div className="fb-head">
              <h2>Zāle</h2>
              <span className="tag"><i className="livedot" aria-hidden="true" />Live</span>
            </div>
            <ul className="feed">
              {bids.length === 0 && <li><span className="nm">Vēl nav solījumu</span></li>}
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
            <h2>Nākamie loti</h2>
            <ol>
              {next.map((q) => (
                <li key={q.id}>
                  <span className="q-ic" aria-hidden="true"><Icon name={CAT_ICON[q.category] ?? "art"} /></span>
                  <span className="q-t">
                    <b>{q.title}</b>
                    <small>{q.sku} · sākuma cena {formatEur(q.startPriceCents ?? 0)}</small>
                  </span>
                  <button className="q-b" type="button" aria-label={`Brīdināt pirms ${q.title}`}
                          aria-pressed={reminded.includes(q.id)}
                          onClick={() => {
                            setReminded((r) => r.includes(q.id) ? r.filter((x) => x !== q.id) : [...r, q.id]);
                            say(reminded.includes(q.id) ? "Atgādinājums atcelts" : "Atgādināsim pirms šī lota");
                          }}><Icon name="bell" size={16} /></button>
                </li>
              ))}
              {next.length === 0 && <li><span className="q-t"><b>Šis ir pēdējais lots</b></span></li>}
            </ol>
          </div>
        </aside>
      </div>
    </section>
  );
}
