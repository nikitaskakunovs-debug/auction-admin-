"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { publicApi, PublicApiError } from "@/lib/api";
import { PUBLIC_API_URL } from "@/lib/config";
import { conditionLabel } from "@/lib/conditions";
import { computeInvoice, increment, marketFees } from "@/lib/fees";
import { useT } from "@/lib/i18n";
import { photoWeb, photoThumb } from "@/lib/photos";
import { formatEur, type AuctionDetail, type PublicAuction } from "@/lib/types";
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
  const [notice, setNotice] = useState<{ text: string; tone: "ok" | "warn" | "err" } | null>(null);

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
  const [lens, setLens] = useState<{ x: number; y: number } | null>(null);
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

  useEffect(() => {
    setWatched(watchStore.has(a.id));
    return watchStore.subscribe(() => setWatched(watchStore.has(a.id)));
  }, [a.id]);

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
          if (msg.type === "extended") say("Izsole pagarināta");
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
        ? { text: t("a.youLead"), tone: "ok" }
        : { text: `${t("a.outbid")} — ${formatEur(r.currentPriceCents)}`, tone: "warn" });
      say(r.youLead ? t("a.youLead") : t("a.outbid"));
      if (r.extended) say(t("a.extended"));
      await reload();
    } catch (err) {
      if (err instanceof PublicApiError && typeof err.body.minAcceptableCents === "number") {
        setNotice({ text: `${t("a.minBid")}: ${formatEur(err.body.minAcceptableCents)}`, tone: "err" });
      } else if (err instanceof PublicApiError && err.body.code === "FEES_OUTSTANDING") {
        setNotice({ text: t("fees.blockedShort"), tone: "err" });
      } else {
        setNotice({ text: err instanceof Error ? err.message : "error", tone: "err" });
      }
    } finally { setBusy(false); }
  };

  const inv = computeInvoice(amount, a.marketCode);
  const left = new Date(a.endsAt).getTime() - now;
  const off = rep.retailCents ? Math.max(0, Math.round((1 - price / rep.retailCents) * 100)) : null;
  const myTop = detail.bids.find((b) => b.isYou);
  const iLead = detail.bids[0]?.isYou === true && !detail.bids[0]?.outbid;

  const quick = [minNext, price + inc * 2, price + inc * 5];

  return (
    <section className="wrap" style={{ paddingTop: 24 }}>
      <nav className="crumbs" aria-label="Navigācijas ceļš">
        <ol>
          <li><Link href="/">Sākums</Link></li>
          <li><Link href="/katalogs">Katalogs</Link></li>
          <li aria-current="page">{a.title}</li>
        </ol>
      </nav>

      <div className="lot-page">
        {/* ═══ ЛЕВАЯ КОЛОНКА ═══ */}
        <div>
          <div
            className="lgal" ref={gal}
            onPointerMove={(e) => {
              if (!zoom) return;
              const r = e.currentTarget.getBoundingClientRect();
              setLens({ x: ((e.clientX - r.left) / r.width) * 100, y: ((e.clientY - r.top) / r.height) * 100 });
            }}
            onPointerLeave={() => setLens(null)}
          >
            {shots.map((p, i) => (
              <span key={i} className={`lframe frame-${i + 1}${i === frame ? " on" : ""}`}>
                {p ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={photoWeb(p)} alt={i === 0 ? a.title : ""} loading={i === 0 ? "eager" : "lazy"} />
                ) : <Icon name="art" className="pic" />}
              </span>
            ))}
            <button className="lnav p" type="button" aria-label="Iepriekšējais foto"
                    onClick={() => goto(frame - 1)}><Icon name="arrow" /></button>
            <button className="lnav n" type="button" aria-label="Nākamais foto"
                    onClick={() => goto(frame + 1)}><Icon name="arrow" /></button>
            <span className="lcount">{frame + 1} / {shots.length}</span>
            <button className="lzoom" type="button" aria-pressed={zoom}
                    onClick={() => { setZoom((v) => !v); setLens(null); }}>
              <Icon name="search" size={16} />Tuvinājums
            </button>
            {zoom && lens && shots[frame] && (
              <span className="lens" aria-hidden="true"
                    style={{
                      left: `${lens.x}%`, top: `${lens.y}%`,
                      backgroundImage: `url(${photoWeb(shots[frame]!)})`,
                      backgroundSize: "300% 300%",
                      backgroundPosition: `${lens.x}% ${lens.y}%`,
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
            {rep.seller && <div><span>Pārdevējs</span><b>{rep.seller}</b></div>}
            <div><span>Tirgus</span><b>{a.marketCode}</b></div>
          </div>

          <section className="report" aria-labelledby="rep-t">
            <div className="rep-head">
              <h2 id="rep-t">Stāvokļa novērtējums</h2>
              {rep.inspectedOn && <span className="note">Pārbaudīts {rep.inspectedOn}</span>}
            </div>

            <div className="rep-grade">
              {rep.gradeCode && <span className="g" aria-hidden="true">{rep.gradeCode}</span>}
              <div>
                <b>{conditionLabel(a.condition, t)}</b>
                <p>
                  {t(`cond.${a.condition}.d`)}
                  {rep.gradeCode && (
                    <button className="info-btn" type="button"
                            aria-label={`Stāvokļa skala — šis lots ${rep.gradeCode}`}
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
                  <h3>Komplektā ir</h3>
                  <ul className="rep-list">
                    {(rep.included ?? []).map((x) => (
                      <li className="in" key={x}><Icon name="check" size={16} />{x}</li>
                    ))}
                  </ul>
                </div>
                <div>
                  <h3>Nav komplektā</h3>
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
                <h3>Inspektora piezīmes</h3>
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
                <h3>Specifikācija</h3>
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
              <span>{rep.seller ? `Pārbaudīja: ${rep.seller}` : "Pārbaudīts pirms publicēšanas"}</span>
              <span>{rep.terms ?? "Pārdots kā aprakstīts. Patērētājam — 14 dienu atteikuma tiesības."}</span>
            </p>
          </section>
        </div>

        {/* ═══ ПРАВАЯ КОЛОНКА ═══ */}
        <div className="lot-side">
          <div className="ltags">
            {live && <span className="tag tag-live"><Icon name="bolt" size={12} />Aktīvs</span>}
            {a.hasReserve && (
              <span className="tag">{a.reserveMet ? t("a.reserveMet") : t("a.reserveNotMet")}</span>
            )}
            <span className="tag">{conditionLabel(a.condition, t)}</span>
          </div>

          <h1 data-hero>{a.title}</h1>

          <div className="lacts">
            <button type="button" aria-pressed={watched} aria-label="Saglabāt vēlmju sarakstā"
                    onClick={() => {
                      watchStore.toggle(a.id);
                      say(watchStore.has(a.id) ? "Pievienots vēlmju sarakstam" : "Noņemts no vēlmju saraksta");
                    }}><Icon name="heart" /></button>
            <button type="button" aria-pressed={alerted} aria-label="Brīdināt par līdzīgiem lotiem"
                    onClick={() => { setAlerted((v) => !v); say(alerted ? "Brīdinājums atcelts" : "Brīdināsim par līdzīgiem lotiem"); }}
            ><Icon name="bell" /></button>
            <button type="button" aria-label="Dalīties ar lotu"
                    onClick={() => openShare({ id: a.id, sku: a.sku, title: a.title })}
            ><Icon name="share" /></button>
          </div>

          <div className="bidbox" data-bidbox>
            <div className="bb-top">
              <span className="lab">{settled ? "Izsole noslēgusies" : live ? "Noslēdzas pēc" : "Sākas"}</span>
              <b className="tnum" suppressHydrationWarning>
                {settled ? "—" : live ? formatLeft(left) : new Date(a.startsAt).toLocaleDateString("lv-LV")}
              </b>
            </div>

            <div className="bb-price">
              <div>
                <p className="price-lab">
                  {a.currentPriceCents !== null ? t("card.currentBid") : t("card.startPrice")}
                  {live && <span className="livepill"><i aria-hidden="true" />LIVE</span>}
                </p>
                <p className="big tnum" suppressHydrationWarning>{formatEur(price)}</p>
                <p className="note">{a.bidCount} solījumi{a.leaderAlias ? ` · ${t("a.leader")}: ${a.leaderAlias}` : ""}</p>
              </div>
              {rep.retailCents ? (
                <div style={{ textAlign: "right" }}>
                  <p className="price-lab">
                    Ieteiktā cena
                    <button className="info-btn" type="button" aria-label="Kas ir ieteiktā cena"
                            onClick={() => say("Ieteiktā cena — ražotāja cena, nevis mūsu iepriekšējā")}>i</button>
                  </p>
                  <p><s className="tnum">{formatEur(rep.retailCents)}</s></p>
                  {off !== null && <p className="save">−{off} % no veikala cenas</p>}
                </div>
              ) : null}
            </div>

            {notice && <p className={`bb-status ${notice.tone}`}>{notice.text}</p>}
            {!notice && iLead && <p className="bb-status ok">{t("a.youLead")}</p>}
            {!notice && !iLead && myTop && <p className="bb-status warn">{t("a.outbid")}</p>}

            {live && (
              signedIn ? (
                <div>
                  <p className="bb-lab">Ātrā izvēle</p>
                  <div className="quick3" role="group" aria-label="Ātrā solījuma summa">
                    {quick.map((q) => (
                      <button key={q} className={`qb${amount === q ? " on" : ""}`} type="button"
                              onClick={() => setAmount(q)}>{formatEur(q)}</button>
                    ))}
                  </div>

                  <div className="amt">
                    <button type="button" aria-label="Samazināt par soli"
                            onClick={() => setAmount((v) => Math.max(minNext, v - inc))}>−</button>
                    <label className="sr" htmlFor="amt">Solījuma summa eiro</label>
                    <span className="cur" aria-hidden="true">€</span>
                    <input id="amt" type="number" inputMode="numeric" step={inc / 100} min={minNext / 100}
                           value={amount % 100 === 0 ? String(amount / 100) : (amount / 100).toFixed(2)}
                           onChange={(e) => setAmount(Math.round(parseFloat(e.target.value || "0") * 100))} />
                    <button type="button" aria-label="Palielināt par soli"
                            onClick={() => setAmount((v) => v + inc)}>+</button>
                  </div>

                  <label className="maxrow">
                    <input type="checkbox" checked={proxy} onChange={(e) => setProxy(e.target.checked)} />
                    <span>
                      Iestatīt kā maksimālo solījumu — solīsim tavā vietā līdz šai summai
                      <button className="info-btn" type="button" aria-label="Kas ir maksimālais solījums"
                              onClick={(e) => { e.preventDefault(); setProxyInfo(true); }}>i</button>
                    </span>
                  </label>

                  <button className="btn btn-primary btn-lg btn-block" type="button"
                          disabled={busy || amount < minNext}
                          onClick={() => setConfirm(true)}>
                    Solīt · <span className="tnum">{formatEur(amount)}</span>
                  </button>
                  <p className="fine tnum">
                    Nākamais minimums {formatEur(minNext)} · solis {formatEur(inc)} ·
                    {" "}+{fees.buyerPremiumBp / 100} % komisija · +{fees.vatRateBp / 100} % PVN
                  </p>

                  {rep.buyNowCents ? (
                    <>
                      <p className="or"><span>vai izlaid solīšanu</span></p>
                      <Link className="btn btn-outline btn-block" href={`/auction/${a.id}/pirkt`}>
                        <Icon name="bolt" size={18} />Pirkt tagad · {formatEur(rep.buyNowCents)}
                      </Link>
                      <p className="note" style={{ textAlign: "center", marginTop: 8 }}>
                        Uzvari uzreiz — izsole noslēdzas tavā labā
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
                    Nākamais minimums {formatEur(minNext)} · solis {formatEur(inc)} ·
                    {" "}+{fees.buyerPremiumBp / 100} % komisija · +{fees.vatRateBp / 100} % PVN
                  </p>
                </div>
              )
            )}

            {settled && (
              <div>
                <p className="bb-lab">
                  {a.hasReserve && !a.reserveMet ? "Nepārdots — rezerve nav sasniegta" : "Pārdots"}
                </p>
                <Link className="btn btn-outline btn-block" href="/katalogs">Skatīt līdzīgus lotus</Link>
              </div>
            )}
          </div>

          <div className="feedbox">
            <div className="fb-head">
              <h2>{t("a.bidHistory")}</h2>
              {live && <span className="tag"><i className="livedot" aria-hidden="true" />Live</span>}
            </div>
            <ul className="feed">
              {detail.bids.length === 0 && <li><span className="nm">Vēl nav solījumu</span></li>}
              {detail.bids.map((b) => (
                <li key={b.seq} style={b.outbid ? { opacity: 0.62 } : undefined}>
                  <span className="av" aria-hidden="true">{b.alias.slice(0, 1)}</span>
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
            <div><h2>Vēl šajā kategorijā</h2><p className="sub">{t(`cat.${a.category}`)}</p></div>
            <Link className="link" href={`/katalogs?category=${a.category}`}>
              Visi loti <Icon name="arrow" size={16} />
            </Link>
          </div>
          <div className="results">
            {related.slice(0, 4).map((r) => <LotCard key={r.id} lot={r as CardLot} />)}
          </div>
        </section>
      )}

      {/* ═══ МОДАЛКА: ПОДТВЕРЖДЕНИЕ СТАВКИ ═══ */}
      {confirm && (
        <div className="modal" role="dialog" aria-modal="true" aria-labelledby="m-bid-t">
          <div className="modal-bd" onClick={() => setConfirm(false)} />
          <div className="modal-card">
            <div className="modal-head">
              <div>
                <span className="kicker">Apstiprini solījumu · {a.sku}</span>
                <h3 id="m-bid-t">{a.title}</h3>
              </div>
              <button className="modal-x" type="button" aria-label="Aizvērt"
                      onClick={() => setConfirm(false)}><Icon name="x" /></button>
            </div>
            <div className="sum">
              <p className="sum-lab">{proxy ? "Tavs maksimālais solījums" : "Tavs solījums"}</p>
              <p className="sum-amt tnum">{formatEur(amount)}</p>
              <p className="note">Minimālais nākamais solījums {formatEur(minNext)}.</p>
            </div>
            <table className="fees"><tbody>
              <tr><th scope="row">Ja uzvari, āmura cena</th><td className="tnum">{formatEur(inv.hammerCents)}</td></tr>
              <tr><th scope="row">Pircēja komisija ({fees.buyerPremiumBp / 100} %)</th><td className="tnum">{formatEur(inv.premiumCents)}</td></tr>
              <tr><th scope="row">PVN ({fees.vatRateBp / 100} %)</th><td className="tnum">{formatEur(inv.vatCents)}</td></tr>
              <tr className="tot"><th scope="row">Kopā, ja uzvari</th><td className="tnum">{formatEur(inv.totalCents)}</td></tr>
            </tbody></table>
            <button className="btn btn-primary btn-block" type="button" disabled={busy}
                    onClick={() => void placeBid()}>
              {busy ? "Sūtām…" : "Apstiprināt solījumu"}
            </button>
            <button className="btn btn-outline btn-block" type="button" style={{ marginTop: 8 }}
                    onClick={() => setConfirm(false)}>Atcelt</button>
            <p className="note" style={{ textAlign: "center", marginTop: 12 }}>
              Solījums ir juridiski saistošs · maksā tikai tad, ja uzvari
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
                <h3 id="m-proxy-t">Maksimālais solījums</h3>
                <p>Norādi augstāko summu, ko esi gatavs maksāt — pārējo darām mēs.</p>
              </div>
              <button className="modal-x" type="button" aria-label="Aizvērt"
                      onClick={() => setProxyInfo(false)}><Icon name="x" /></button>
            </div>
            <ul className="rep-list">
              <li className="in"><Icon name="check" size={16} />Solām pa vienam solim tavā vietā, līdz sasniedz tavu maksimumu.</li>
              <li className="in"><Icon name="check" size={16} />Citi solītāji nekad neredz tavu maksimālo summu.</li>
              <li className="in"><Icon name="check" size={16} />Uzvari par zemāko cenu, kas pārsniedz pārējos — bieži krietni zem maksimuma.</li>
            </ul>
            <p className="ex">
              <b>Piemērs.</b> Ja iestati {formatEur(price + inc * 4)}, bet konkurents apstājas pie{" "}
              {formatEur(price + inc * 2)}, tu uzvari par {formatEur(price + inc * 3)}.
            </p>
          </div>
        </div>
      )}
    </section>
  );
}
