"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { publicApi, PublicApiError } from "@/lib/api";
import { PUBLIC_API_URL } from "@/lib/config";
import { conditionLabel } from "@/lib/conditions";
import { computeInvoice, increment, marketFees } from "@/lib/fees";
import { dateLocale, useT } from "@/lib/i18n";
import { photoWeb, photoThumb } from "@/lib/photos";
import { formatEur, type AuctionDetail, type PublicAuction } from "@/lib/types";
import { useStickyBar } from "@/lib/ui";
import { watchStore } from "@/lib/watch";
import { KlixPayLater } from "./KlixPayLater";
import { Icon } from "./Icon";
import { LotCard, type CardLot } from "./LotCard";
import { useNow, formatLeft } from "./Countdown";
import { openScale, openShare } from "./Modals";
import { say } from "./Toast";

/** Страница лота утверждённого макета.
 *
 *  Блоков отчёта о состоянии (что в комплекте, чего нет, замечания инспектора,
 *  спецификация, аутентификация) в движке пока нет — они объявлены
 *  опциональными и появятся сами, когда API начнёт их отдавать. */
export type LotReport = {
  inspectedOn?: string | null;
  tested?: [string, string] | null;
  packaging?: [string, string] | null;
  included?: string[];
  missing?: string[];
  flaws?: string[];
  specs?: Array<[string, string]>;
  authenticity?: string | null;
  terms?: string | null;
  seller?: string | null;
  watching?: number | null;
  gradeCode?: string | null;
  retailCents?: number | null;
  buyNowCents?: number | null;
};

const FALLBACK_FRAMES = 5;

export function LotPage({
  initial, related,
}: { initial: AuctionDetail; related: PublicAuction[] }) {
  const { t, lang } = useT();
  const [detail, setDetail] = useState(initial);
  const [signedIn, setSignedIn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ text: string; tone: "win" | "out" } | null>(null);

  const a = detail.auction;
  const rep = (a as PublicAuction & { report?: LotReport }).report ?? {};
  const live = a.status === "live";
  const settled = a.status.startsWith("ended");
  const now = useNow();

  const price = a.currentPriceCents ?? a.startPriceCents ?? 0;
  const inc = increment(price);
  const minNext = detail.minNextBidCents;
  const fees = marketFees(a.marketCode);

  // ── галерея ───────────────────────────────────────────────────────────
  const shots = a.photos.length ? a.photos : new Array<string | null>(FALLBACK_FRAMES).fill(null);
  const [frame, setFrame] = useState(0);
  const [zoom, setZoom] = useState(false);
  const [box, setBox] = useState(false);
  const [bidVisible, setBidVisible] = useState(true);
  const bidBox = useRef<HTMLDivElement>(null);
  const [lens, setLens] = useState<{ x: number; y: number; bx: number; by: number } | null>(null);
  const gal = useRef<HTMLDivElement>(null);
  const goto = (i: number) => setFrame(((i % shots.length) + shots.length) % shots.length);

  // ── ставка ────────────────────────────────────────────────────────────
  const [amount, setAmount] = useState(minNext);
  const [proxy, setProxy] = useState(true);
  const [confirm, setConfirm] = useState(false);
  const [proxyInfo, setProxyInfo] = useState(false);
  const [watched, setWatched] = useState(false);
  const [alerted, setAlerted] = useState(false);

  useEffect(() => { setAmount((v) => (v < minNext ? minNext : v)); }, [minNext]);

  // Полноэкранная галерея и модалки блокируют прокрутку страницы под ними.
  useEffect(() => {
    if (!box && !confirm && !proxyInfo) return;
    document.body.classList.add("no-scroll");
    return () => document.body.classList.remove("no-scroll");
  }, [box, confirm, proxyInfo]);

  useEffect(() => {
    setWatched(watchStore.has(a.id));
    return watchStore.subscribe(() => setWatched(watchStore.has(a.id)));
  }, [a.id]);

  // Липкая полоса ставки на телефоне: показываем, когда сам блок уехал за экран.
  useEffect(() => {
    const el = bidBox.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(([e]) => setBidVisible(!!e?.isIntersecting), { threshold: 0.15 });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const reload = useCallback(async () => {
    try {
      setDetail(await publicApi.get<AuctionDetail>(`/api/public/auctions/${a.id}`));
    } catch { /* сеть моргнула — оставляем текущее состояние */ }
  }, [a.id]);

  useEffect(() => {
    setSignedIn(publicApi.hasSession);
    const fn = () => setSignedIn(publicApi.hasSession);
    publicApi.listeners.add(fn);
    return () => { publicApi.listeners.delete(fn); };
  }, []);

  // Живые обновления по WebSocket, с переподключением.
  const reloadRef = useRef(reload);
  reloadRef.current = reload;
  useEffect(() => {
    let ws: WebSocket | null = null;
    let closed = false, retry = 0;
    const connect = () => {
      if (closed) return;
      ws = new WebSocket(`${PUBLIC_API_URL.replace(/^http/, "ws")}/ws`);
      ws.onopen = () => { retry = 0; ws?.send(JSON.stringify({ type: "subscribe", auctionId: a.id })); };
      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(String(e.data)) as { type?: string };
          if (msg.type === "extended") say(t("lp.extended"));
        } catch { /* сообщение не JSON — просто перечитываем лот */ }
        void reloadRef.current();
      };
      ws.onclose = () => { if (!closed) setTimeout(connect, Math.min(1000 * 2 ** retry++, 10_000)); };
    };
    connect();
    return () => { closed = true; ws?.close(); };
  }, [a.id]);

  const placeBid = async () => {
    setBusy(true); setNotice(null);
    try {
      const r = await publicApi.post<{ youLead: boolean; currentPriceCents: number; extended: boolean }>(
        `/api/public/auctions/${a.id}/bids`, { maxCents: amount },
      );
      setConfirm(false);
      setNotice(r.youLead
        ? { text: t("a.youLead"), tone: "win" }
        : { text: `${t("a.outbid")} — ${formatEur(r.currentPriceCents)}`, tone: "out" });
      say(r.youLead ? t("a.youLead") : t("a.outbid"));
      if (r.extended) say(t("a.extended"));
      await reload();
    } catch (err) {
      if (err instanceof PublicApiError && err.body.code === "EMAIL_NOT_VERIFIED") {
        setNotice({ text: t("lc.verifyFirst"), tone: "out" });
      } else if (err instanceof PublicApiError && typeof err.body.minAcceptableCents === "number") {
        setNotice({ text: `${t("a.minBid")}: ${formatEur(err.body.minAcceptableCents)}`, tone: "out" });
      } else if (err instanceof PublicApiError && err.body.code === "FEES_OUTSTANDING") {
        setNotice({ text: t("fees.blockedShort"), tone: "out" });
      } else {
        setNotice({ text: err instanceof Error ? err.message : "error", tone: "out" });
      }
    } finally { setBusy(false); }
  };

  const inv = computeInvoice(amount, a.marketCode);
  const won = computeInvoice(price, a.marketCode);
  const left = new Date(a.endsAt).getTime() - now;
  const over = left <= 0;
  const off = rep.retailCents ? Math.max(0, Math.round((1 - price / rep.retailCents) * 100)) : null;
  const myTop = detail.bids.find((b) => b.isYou);
  const iLead = detail.bids[0]?.isYou === true && !detail.bids[0]?.outbid;

  const quick = [minNext, price + inc * 2, price + inc * 5];


  useStickyBar(live && !over && !bidVisible);
  return (
    <section className="wrap" style={{ paddingTop: 24 }}>
      <nav className="crumbs" aria-label={t("nav.breadcrumb")}>
        <ol>
          <li><Link href="/">{t("nav.home")}</Link></li>
          <li><Link href="/katalogs">Katalogs</Link></li>
          <li aria-current="page">{a.title}</li>
        </ol>
      </nav>

      <div className="lot-page">
        {/* ═══ ЛЕВАЯ КОЛОНКА ═══ */}
        <div>
          <div
            className={`lgal${zoom ? " zoom" : ""}`} ref={gal}
            onPointerMove={(e) => {
              if (!zoom) return;
              const r = e.currentTarget.getBoundingClientRect();
              // Круг 170 px центрируем по курсору и держим внутри рамки — как в макете.
              const px = Math.min(Math.max(e.clientX - r.left - 85, 0), Math.max(r.width - 170, 0));
              const py = Math.min(Math.max(e.clientY - r.top - 85, 0), Math.max(r.height - 170, 0));
              setLens({
                x: px, y: py,
                bx: ((e.clientX - r.left) / r.width) * 100,
                by: ((e.clientY - r.top) / r.height) * 100,
              });
            }}
            onPointerLeave={() => setLens(null)}
            tabIndex={0}
            role="group"
            aria-label={`Foto: ${a.title}`}
            onKeyDown={(e) => {
              if (e.key === "ArrowLeft") { e.preventDefault(); goto(frame - 1); }
              if (e.key === "ArrowRight") { e.preventDefault(); goto(frame + 1); }
            }}
          >
            {shots.map((p, i) => (
              <span key={i} className={`lframe frame-${i + 1}${i === frame ? " on" : ""}`}
                    onClick={() => { if (!zoom) setBox(true); }}>
                {p ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={photoWeb(p)} alt={i === 0 ? a.title : ""} loading={i === 0 ? "eager" : "lazy"} />
                ) : <Icon name="art" className="pic" />}
              </span>
            ))}
            <button className="lnav p" type="button" aria-label={t("lp.prevPhoto")}
                    onClick={() => goto(frame - 1)}><Icon name="arrow" /></button>
            <button className="lnav n" type="button" aria-label={t("lp.nextPhoto")}
                    onClick={() => goto(frame + 1)}><Icon name="arrow" /></button>
            <span className="lcount">{frame + 1} / {shots.length}</span>
            <button className="lfull" type="button" aria-haspopup="dialog"
                    aria-label={t("lp.fullscreenAria")} onClick={() => setBox(true)}>
              <Icon name="plus" size={16} />{t("lp.fullscreen")}
            </button>
            <button className="lzoom" type="button" aria-pressed={zoom}
                    onClick={() => { setZoom((v) => !v); setLens(null); }}>
              <Icon name="search" size={16} />{zoom ? t("lp.zoomOn") : t("lp.zoom")}
            </button>
            {zoom && lens && shots[frame] && (
              <span className="lens" aria-hidden="true"
                    style={{
                      left: lens.x, top: lens.y,
                      backgroundImage: `url(${photoWeb(shots[frame]!)})`,
                      backgroundSize: "300% 300%",
                      backgroundPosition: `${lens.bx}% ${lens.by}%`,
                    }} />
            )}
          </div>

          <div className="lthumbs">
            {shots.map((p, i) => (
              <button key={i} className={`lthumb${i === frame ? " on" : ""}`} type="button"
                      aria-label={`Foto ${i + 1} no ${shots.length}`}
                      aria-current={i === frame ? "true" : undefined}
                      onClick={() => goto(i)}>
                {p ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={photoThumb(p)} alt="" loading="lazy" />
                ) : <span className={`frame-${i + 1}`}><Icon name="art" /></span>}
              </button>
            ))}
          </div>

          <div className="facts">
            <div><span>Lots</span><b>{a.sku}</b></div>
            {rep.seller && <div><span>{t("lp.seller")}</span><b>{rep.seller}</b></div>}
            <div><span>Tirgus</span><b>{a.marketCode}</b></div>
          </div>

          <section className="report" aria-labelledby="rep-t">
            <div className="rep-head">
              <h2 id="rep-t">{t("lp.repTitle")}</h2>
              {rep.inspectedOn && <span className="note">{t("lp.inspectedOn", { date: rep.inspectedOn })}</span>}
            </div>

            <div className="rep-grade">
              {rep.gradeCode && <span className="g" aria-hidden="true">{rep.gradeCode}</span>}
              <div>
                <b>{conditionLabel(a.condition, t)}</b>
                <p>
                  {t(`cond.${a.condition}.d`)}
                  {rep.gradeCode && (
                    <button className="info-btn" type="button" aria-haspopup="dialog"
                            aria-label={t("lc.scaleAria", { g: rep.gradeCode ?? "" })}
                            onClick={() => openScale(rep.gradeCode!)}>i</button>
                  )}
                </p>
              </div>
            </div>

            {a.conditionNotes && (
              <div className="rep-strip">
                <span className="ic" aria-hidden="true"><Icon name="shield" /></span>
                <div><b>{t("cond.notes")}</b><p>{a.conditionNotes}</p></div>
              </div>
            )}

            {rep.tested && (
              <div className="rep-strip ok">
                <span className="ic" aria-hidden="true"><Icon name="check" /></span>
                <div><b>{rep.tested[0]}</b><p>{rep.tested[1]}</p></div>
              </div>
            )}

            {rep.packaging && (
              <div className="rep-strip">
                <span className="ic" aria-hidden="true"><Icon name="box" /></span>
                <div><b>{rep.packaging[0]}</b><p>{rep.packaging[1]}</p></div>
              </div>
            )}

            {(rep.included?.length || rep.missing?.length) && (
              <div className="rep-cols">
                <div>
                  <h3>{t("lp.included")}</h3>
                  <ul className="rep-list">
                    {(rep.included ?? []).map((x) => (
                      <li className="in" key={x}><Icon name="check" size={16} />{x}</li>
                    ))}
                  </ul>
                </div>
                <div>
                  <h3>{t("lp.notIncluded")}</h3>
                  <ul className="rep-list">
                    {(rep.missing ?? []).map((x) => (
                      <li className="out" key={x}><Icon name="x" size={16} />{x}</li>
                    ))}
                  </ul>
                </div>
              </div>
            )}

            {rep.flaws?.length ? (
              <div>
                <h3>{t("lp.inspectorNotes")}</h3>
                <ul className="rep-list">
                  {rep.flaws.map((x) => (<li className="note-i" key={x}><Icon name="dot" size={16} />{x}</li>))}
                </ul>
              </div>
            ) : null}

            {a.description && (
              <div><h3>Apraksts</h3><p className="note" style={{ fontSize: 15 }}>{a.description}</p></div>
            )}

            {rep.specs?.length ? (
              <div>
                <h3>{t("lp.specs")}</h3>
                <table className="specs"><tbody>
                  {rep.specs.map(([k, v]) => (<tr key={k}><th scope="row">{k}</th><td>{v}</td></tr>))}
                </tbody></table>
              </div>
            ) : null}

            {rep.authenticity && (
              <div className="rep-strip auth">
                <span className="ic" aria-hidden="true"><Icon name="shield" /></span>
                <div><p>{rep.authenticity}</p></div>
              </div>
            )}

            <p className="rep-terms">
              <span>{rep.seller ? t("lp.inspectedBy", { who: rep.seller }) : t("lp.inspectedBefore")}</span>
              <span>{rep.terms ?? t("lp.termsDefault")}</span>
            </p>
          </section>
        </div>

        {/* ═══ ПРАВАЯ КОЛОНКА ═══ */}
        <div className="lot-side">
          <div className="ltags">
            {live && <span className="tag tag-live"><Icon name="bolt" size={12} />{t("lp.active")}</span>}
            {a.hasReserve && (
              <span className="tag">{a.reserveMet ? t("a.reserveMet") : t("a.reserveNotMet")}</span>
            )}
            <span className="tag">{conditionLabel(a.condition, t)}</span>
          </div>

          <h1 data-hero>{a.title}</h1>

          <div className="lacts">
            <button type="button" aria-pressed={watched} aria-label={t("lp.saveAria")}
                    onClick={() => {
                      watchStore.toggle(a.id);
                      say(watchStore.has(a.id) ? t("lc.saved") : t("lc.unsaved"));
                    }}><Icon name="heart" /></button>
            <button type="button" aria-pressed={alerted} aria-label={t("lp.alertAria")}
                    onClick={() => { setAlerted((v) => !v); say(alerted ? t("lc.alertOff") : t("lp.alertOn")); }}
            ><Icon name="bell" /></button>
            <button type="button" aria-haspopup="dialog" aria-label={t("lp.shareAria")}
                    onClick={() => openShare({ id: a.id, sku: a.sku, title: a.title })}
            ><Icon name="share" /></button>
          </div>

          <div className="bidbox" data-bidbox ref={bidBox}>
            <div className={`bb-top${live && left > 0 && left < 60_000 ? " crit" : ""}`}>
              <span className="lab">{settled || over ? t("lp.over") : live ? t("lp.closesIn") : t("lp.starts")}</span>
              <b className="tnum" suppressHydrationWarning>
                {settled || over ? "—" : live ? formatLeft(left) : new Date(a.startsAt).toLocaleDateString(dateLocale(lang))}
              </b>
            </div>

            <div className="bb-price">
              <div>
                <p className="price-lab">
                  {a.currentPriceCents !== null ? t("card.currentBid") : t("card.startPrice")}
                  {live && !over && <span className="livepill"><i aria-hidden="true" />LIVE</span>}
                </p>
                <p className={`big tnum${iLead ? " is-win" : ""}`} suppressHydrationWarning>{formatEur(price)}</p>
                <p className="note">{t("lp.bidsN", { n: a.bidCount })}{a.leaderAlias ? ` · ${t("a.leader")}: ${a.leaderAlias}` : ""}</p>
              </div>
              {rep.retailCents ? (
                <div style={{ textAlign: "right" }}>
                  <p className="price-lab">
                    {t("lp.retailPrice")}
                    <button className="info-btn" type="button" aria-label={t("lc.retailAria")}
                            onClick={() => say(t("lc.retailNote"))}>i</button>
                  </p>
                  <p><s className="tnum">{formatEur(rep.retailCents)}</s></p>
                  {off !== null && <p className="save">{t("lp.offRetail", { n: off })}</p>}
                </div>
              ) : null}
            </div>

            {notice && <p className={`bb-status ${notice.tone}`}>{notice.text}</p>}
            {!notice && iLead && <p className="bb-status win">{t("a.youLead")}</p>}
            {!notice && !iLead && myTop && <p className="bb-status out">{t("a.outbid")}</p>}

            {live && !over && (
              signedIn ? (
                <div>
                  <p className="bb-lab">{t("lp.quickPick")}</p>
                  <div className="quick3" role="group" aria-label={t("lp.quickPickAria")}>
                    {quick.map((q) => (
                      <button key={q} className={`qb${amount === q ? " on" : ""}`} type="button"
                              onClick={() => setAmount(q)}>{formatEur(q)}</button>
                    ))}
                  </div>

                  <div className="amt">
                    <button type="button" aria-label={t("lp.stepDown")}
                            onClick={() => setAmount((v) => Math.max(minNext, v - inc))}>−</button>
                    <label className="sr" htmlFor="amt">{t("lp.amountLabel")}</label>
                    <span className="cur" aria-hidden="true">€</span>
                    <input id="amt" type="number" inputMode="numeric" step={inc / 100} min={minNext / 100}
                           value={amount % 100 === 0 ? String(amount / 100) : (amount / 100).toFixed(2)}
                           onChange={(e) => setAmount(Math.round(parseFloat(e.target.value || "0") * 100))} />
                    <button type="button" aria-label={t("lp.stepUp")}
                            onClick={() => setAmount((v) => v + inc)}>+</button>
                  </div>

                  <label className={`maxrow${proxy ? " on" : ""}`}>
                    <input type="checkbox" checked={proxy} onChange={(e) => setProxy(e.target.checked)} />
                    <span>
                      {t("lp.setMax")}
                      <button className="info-btn" type="button" aria-haspopup="dialog" aria-label={t("lp.whatIsMax")}
                              onClick={(e) => { e.preventDefault(); setProxyInfo(true); }}>i</button>
                    </span>
                  </label>

                  <button className="btn btn-primary btn-lg btn-block" type="button"
                          disabled={busy || amount < minNext}
                          onClick={() => setConfirm(true)}>
                    {t("lc.bid")}<span className="tnum">{formatEur(amount)}</span>
                  </button>
                  <p className="fine tnum">
                    {t("lp.minNext", { min: formatEur(minNext), inc: formatEur(inc),
                      prem: fees.buyerPremiumBp / 100, vat: fees.vatRateBp / 100 })}
                  </p>

                  {rep.buyNowCents ? (
                    <>
                      <p className="or"><span>{t("lp.orSkip")}</span></p>
                      <Link className="btn btn-outline btn-block" href={`/auction/${a.id}/pirkt`}>
                        <Icon name="bolt" size={18} />{t("lp.buyNowFor", { sum: formatEur(rep.buyNowCents) })}
                      </Link>
                      <p className="note" style={{ textAlign: "center", marginTop: 8 }}>
                        {t("lp.winInstantly")}
                      </p>
                    </>
                  ) : null}

                  <div style={{ marginTop: 12 }}>
                    <KlixPayLater amountCents={detail.estimatedTotalCents} view="product" />
                  </div>
                </div>
              ) : (
                <div>
                  <Link className="btn btn-primary btn-lg btn-block" href="/login">{t("a.signinToBid")}</Link>
                  <p className="fine tnum">
                    {t("lp.minNext", { min: formatEur(minNext), inc: formatEur(inc),
                      prem: fees.buyerPremiumBp / 100, vat: fees.vatRateBp / 100 })}
                  </p>
                </div>
              )
            )}

            {(settled || over) && (
              <div className="bb-ended">
                {iLead ? (
                  <>
                    <div className="won">
                      <span className="ic" aria-hidden="true"><Icon name="check" /></span>
                      <h3>{t("lp.youWon")}</h3>
                      <p className="note">
                        {t("lp.wonNote")}
                      </p>
                    </div>
                    <table className="fees"><tbody>
                      <tr><th scope="row">{t("lp.hammer")}</th><td className="tnum">{formatEur(won.hammerCents)}</td></tr>
                      <tr><th scope="row">{t("lp.premium", { n: fees.buyerPremiumBp / 100 })}</th>
                        <td className="tnum">{formatEur(won.premiumCents)}</td></tr>
                      <tr><th scope="row">{t("lp.vatN", { n: fees.vatRateBp / 100 })}</th>
                        <td className="tnum">{formatEur(won.vatCents)}</td></tr>
                      <tr className="tot"><th scope="row">{t("bn.total")}</th>
                        <td className="tnum">{formatEur(won.totalCents)}</td></tr>
                    </tbody></table>
                    <Link className="btn btn-primary btn-block" href="/account">
                      {t("lp.payNow", { sum: formatEur(won.totalCents) })}
                    </Link>
                  </>
                ) : (
                  <div className="won">
                    <h3>
                      {a.hasReserve && !a.reserveMet ? t("lc.unsoldReserve")
                        : myTop ? t("lp.outbidYou") : t("lp.auctionClosed")}
                    </h3>
                    <p className="note">{t("lp.finalPrice")}</p>
                    <p className="sum-amt tnum">{formatEur(price)}</p>
                    <Link className="btn btn-primary btn-block" href={`/katalogs?category=${a.category}`}>
                      {t("lp.findSimilar")}
                    </Link>
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="feedbox">
            <div className="fb-head">
              <h2>{t("a.bidHistory")}</h2>
              {live && <span className="tag"><i className="livedot" aria-hidden="true" />Live</span>}
            </div>
            <ul className="feed">
              {detail.bids.length === 0 && <li><span className="nm">{t("lp.noBidsYet")}</span></li>}
              {detail.bids.slice(0, 24).map((b) => (
                <li key={b.seq} className={b.isYou ? "you" : undefined}
                    style={b.outbid ? { opacity: 0.62 } : undefined}>
                  <span className="av" aria-hidden="true">{b.isYou ? "★" : b.alias.slice(0, 1)}</span>
                  <span className="nm">
                    {b.alias}{b.isYou && ` · ${t("a.you")}`}{b.auto && ` · ${t("a.proxy")}`}
                  </span>
                  <span className="am tnum">{formatEur(b.amountCents)}</span>
                  <span className="ago" suppressHydrationWarning>
                    {new Date(b.createdAt).toLocaleTimeString(lang === "en" ? "en-GB" : "lv-LV",
                      { hour: "2-digit", minute: "2-digit" })}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>

      {related.length > 0 && (
        <section className="section" style={{ paddingBottom: 0 }}>
          <div className="sec-head">
            <div><h2>{t("lp.moreInCat")}</h2><p className="sub">{t(`cat.${a.category}`)}</p></div>
            <Link className="link" href={`/katalogs?category=${a.category}`}>
              Visi loti <Icon name="arrow" size={16} />
            </Link>
          </div>
          <div className="results">
            {related.slice(0, 4).map((r) => <LotCard key={r.id} lot={r as CardLot} />)}
          </div>
        </section>
      )}

      {/* ═══ ЛИПКАЯ СТАВКА НА ТЕЛЕФОНЕ ═══ */}
      {live && !over && !bidVisible && (
        <div className="bidbar">
          <div className="t">
            <span className="lab" suppressHydrationWarning>
              {formatLeft(left)}{iLead ? t("lp.youLeadShort") : ""}
            </span>
            <b className="tnum">{formatEur(price)}</b>
          </div>
          {signedIn ? (
            <button className="btn btn-primary" type="button" aria-haspopup="dialog"
                    onClick={() => { setAmount((v) => (v < minNext ? minNext : v)); setConfirm(true); }}>
              {t("lc.bid")}<span className="tnum">{formatEur(minNext)}</span>
            </button>
          ) : (
            <Link className="btn btn-primary" href={`/login?next=/auction/${a.id}`}>{t("a.signinToBid")}</Link>
          )}
        </div>
      )}

      {/* ═══ ГАЛЕРЕЯ ВО ВЕСЬ ЭКРАН ═══ */}
      {box && (
        <div className="lightbox" role="dialog" aria-modal="true" aria-label={`Foto: ${a.title}`}
             onKeyDown={(e) => {
               if (e.key === "ArrowLeft") goto(frame - 1);
               if (e.key === "ArrowRight") goto(frame + 1);
               if (e.key === "Escape") setBox(false);
             }}
             tabIndex={-1}
             ref={(n) => n?.focus()}>
          <div className="lb-bd" onClick={() => setBox(false)} />
          <button className="lb-x" type="button" aria-label={t("nav.close")} onClick={() => setBox(false)}>
            <Icon name="x" />
          </button>
          <div className="lb-stage">
            {shots[frame] ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={photoWeb(shots[frame]!)} alt={a.title} />
            ) : <Icon name="art" className="pic" />}
          </div>
          <button className="lb-nav p" type="button" aria-label={t("lp.prevPhoto")}
                  onClick={() => goto(frame - 1)}><Icon name="arrow" /></button>
          <button className="lb-nav n" type="button" aria-label={t("lp.nextPhoto")}
                  onClick={() => goto(frame + 1)}><Icon name="arrow" /></button>
          <div className="lb-bar">
            <span className="lb-count tnum">{frame + 1} / {shots.length}</span>
            <div className="lb-thumbs">
              {shots.map((p, i) => (
                <button key={i} className={`lb-thumb${i === frame ? " on" : ""}`} type="button"
                        aria-label={`Foto ${i + 1}`} aria-current={i === frame ? "true" : undefined}
                        onClick={() => goto(i)}>
                  {p ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={photoThumb(p)} alt="" loading="lazy" />
                  ) : <Icon name="art" />}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ═══ МОДАЛКА: ПОДТВЕРЖДЕНИЕ СТАВКИ ═══ */}
      {confirm && (
        <div className="modal" role="dialog" aria-modal="true" aria-labelledby="m-bid-t">
          <div className="modal-bd" onClick={() => setConfirm(false)} />
          <div className="modal-card">
            <div className="modal-head">
              <div>
                <span className="kicker">{t("lp.confirmKicker")} · {a.sku}</span>
                <h3 id="m-bid-t">{a.title}</h3>
              </div>
              <button className="modal-x" type="button" aria-label={t("nav.close")}
                      onClick={() => setConfirm(false)}><Icon name="x" /></button>
            </div>
            <div className="sum">
              <p className="sum-lab">{proxy ? t("lp.yourMaxBid") : t("lp.yourBid")}</p>
              <p className="sum-amt tnum">{formatEur(amount)}</p>
              <p className="note">{t("lp.minNextShort", { sum: formatEur(minNext) })}</p>
            </div>
            <table className="fees"><tbody>
              <tr><th scope="row">{t("lp.ifYouWin")}</th><td className="tnum">{formatEur(inv.hammerCents)}</td></tr>
              <tr><th scope="row">{t("lp.premium", { n: fees.buyerPremiumBp / 100 })}</th><td className="tnum">{formatEur(inv.premiumCents)}</td></tr>
              <tr><th scope="row">PVN ({fees.vatRateBp / 100} %)</th><td className="tnum">{formatEur(inv.vatCents)}</td></tr>
              <tr className="tot"><th scope="row">{t("lp.totalIfWin")}</th><td className="tnum">{formatEur(inv.totalCents)}</td></tr>
            </tbody></table>
            <button className="btn btn-primary btn-block" type="button" disabled={busy}
                    onClick={() => void placeBid()}>
              {busy ? t("lp.sending") : t("lp.confirmBid")}
            </button>
            <button className="btn btn-outline btn-block" type="button" style={{ marginTop: 8 }}
                    onClick={() => setConfirm(false)}>Atcelt</button>
            <p className="note" style={{ textAlign: "center", marginTop: 12 }}>
              {t("lp.bindingNote")}
            </p>
          </div>
        </div>
      )}

      {/* ═══ МОДАЛКА: МАКСИМАЛЬНАЯ СТАВКА ═══ */}
      {proxyInfo && (
        <div className="modal" role="dialog" aria-modal="true" aria-labelledby="m-proxy-t">
          <div className="modal-bd" onClick={() => setProxyInfo(false)} />
          <div className="modal-card">
            <div className="modal-head">
              <div>
                <h3 id="m-proxy-t">{t("lp.proxyTitle")}</h3>
                <p>{t("lp.proxyIntro")}</p>
              </div>
              <button className="modal-x" type="button" aria-label={t("nav.close")}
                      onClick={() => setProxyInfo(false)}><Icon name="x" /></button>
            </div>
            <ul className="rep-list">
              <li className="in"><Icon name="check" size={16} />{t("lp.proxy1")}</li>
              <li className="in"><Icon name="check" size={16} />{t("lp.proxy2")}</li>
              <li className="in"><Icon name="check" size={16} />{t("lp.proxy3")}</li>
            </ul>
            <p className="ex">
              <b>{t("lp.example")}</b>{" "}
              {t("lp.exampleText", { max: formatEur(price + inc * 4), rival: formatEur(price + inc * 2),
                win: formatEur(price + inc * 3) })}
            </p>
          </div>
        </div>
      )}
    </section>
  );
}
