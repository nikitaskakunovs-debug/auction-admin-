"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { BidHistory } from "@/components/account/BidHistory";
import { Console } from "@/components/account/Console";
import { relTime, useAccountData, type MyBidAuction } from "@/components/account/data";
import { CreditBoard, InvoicePdfButton, Receipt } from "@/components/account/Money";
import { Pickup } from "@/components/account/Pickup";
import { SettingsHub } from "@/components/account/SettingsHub";
import { Countdown } from "@/components/Countdown";
import { LotCard } from "@/components/LotCard";
import { Ph } from "@/components/Ph";
import { SavedSearches } from "@/components/account/SavedSearches";
import { say } from "@/components/Toast";
import { VerifyNotice } from "@/components/VerifyNotice";
import { publicApi } from "@/lib/api";
import { setCartCount } from "@/lib/cart";
import { dateLocale, useT, type Lang } from "@/lib/i18n";
import { loginHref } from "@/lib/nav";
import { addToCartOnce, adsUserData, orderEcom, purchaseOnce, track } from "@/lib/track";
import { photoThumb } from "@/lib/photos";
import { formatEur, type MyOrder } from "@/lib/types";

/**
 * Кабинет по утверждённому финальному макету (izsoli-visi-ekrani.pdf):
 * на компьютере — боковое меню с карточкой профиля, на телефоне — строка
 * профиля и лента чипов. Разделы: Pārskats, Manas izsoles (с живой консолью
 * и историей ставок), Pirkumi, Vēlmes, Brīdinājumi, Izņemšana, Iestatījumi.
 *
 * Значения движка авторитетнее макета: цены, шаги, комиссия и НДС приходят
 * из API и нигде не пересчитываются на клиенте.
 */
type Tab = "parskats" | "izsoles" | "pirkumi" | "velmes" | "bridinajumi" | "iznemsana" | "verifikacija" | "iestatijumi";

const TABS: Array<[Tab, string, string]> = [
  ["parskats", "ac.overview", "house"],
  ["izsoles", "acc.myBids", "gavel"],
  ["pirkumi", "kb.purchases", "package"],
  ["velmes", "nav.watchlist", "heart"],
  ["bridinajumi", "nav.alerts", "bell"],
  ["iznemsana", "ac.pickup", "map-pin"],
  ["iestatijumi", "ac.settings", "gear"],
];

type PayBanner = "confirming" | "success" | "failed" | "cancelled" | "processing" | null;

export default function AccountPage() {
  const { t, lang } = useT();
  const data = useAccountData();
  const { signedIn, me, bids, orders, fees, pickup, shipments, notifications, watchIds, alertIds, catalog } = data;

  const [tab, setTab] = useState<Tab>("parskats");
  const [historyLot, setHistoryLot] = useState<string | null>(null);
  const [izsFilter, setIzsFilter] = useState<"active" | "won" | "outbid" | "watch" | "console">("active");
  const [payBanner, setPayBanner] = useState<PayBanner>(null);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Глубокие ссылки: /account?tab=pirkumi, ?tab=izsoles&lot=<id> — история.
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    const q = p.get("tab") as Tab | null;
    if (q && (TABS.some(([id]) => id === q) || q === "verifikacija")) setTab(q);
    const lot = p.get("lot");
    if (lot) { setTab("izsoles"); setHistoryLot(lot); }
    if (p.get("f") === "console") { setTab("izsoles"); setIzsFilter("console"); }
  }, []);

  const goTab = (id: Tab) => {
    setTab(id);
    setHistoryLot(null);
    window.history.replaceState(null, "", id === "parskats" ? "/account" : `/account?tab=${id}`);
  };

  // Возврат с оплаты (?paid=1&order=REF): подтверждаем платёж опросом движка.
  useEffect(() => {
    if (signedIn !== true) return;
    const params = new URLSearchParams(window.location.search);
    const paid = params.get("paid");
    const ref = params.get("order");
    if (!paid || !ref) return;
    window.history.replaceState(null, "", window.location.pathname);
    if (paid === "0") { setPayBanner("failed"); return; }
    if (paid === "cancel") { setPayBanner("cancelled"); return; }
    setPayBanner("confirming");
    let attempts = 0;
    let stillInFlight = false;
    const poll = async () => {
      attempts += 1;
      try {
        const r = await publicApi.get<{ orderStatus: string; paymentStatus: string | null }>(
          `/api/public/orders/${encodeURIComponent(ref)}/payment`,
        );
        if (r.orderStatus === "paid") {
          setPayBanner("success");
          data.refresh();
          // Аналитика (GTM): покупка подтверждена движком. event_id = номер
          // заказа — та же метка пойдёт в серверный Meta CAPI, дубль не
          // засчитается. Сумму берём из свежего списка заказов.
          void publicApi.get<{ orders: MyOrder[] }>("/api/public/me/orders")
            .then((res) => {
              const paid = res.orders.find((o) => o.ref === ref);
              const ec = paid ? orderEcom(paid) : null;
              purchaseOnce(ref, {
                ...adsUserData({
                  email: me?.email, phone: paid?.recipientPhone,
                  country: paid?.shippingTo?.country, zip: paid?.shippingTo?.zip,
                }),
                // transaction_id продублирован наверх: GA4 читает его из
                // ecommerce, тегу Google Ads удобнее с верхнего уровня.
                transaction_id: ref, event_id: `purchase-${ref}`, currency: "EUR", payment_status: "paid",
                ...(ec
                  ? {
                      // value — лот+комиссия без НДС; gross_total — к оплате.
                      // Доход площадки (commission_value) отдельно от кассы.
                      value: ec.netCents / 100,
                      gross_total: ec.grossCents / 100,
                      commission_value: ec.commissionCents / 100,
                      vat_scheme: ec.vatScheme,
                      ecommerce: {
                        transaction_id: ref, currency: "EUR",
                        value: ec.netCents / 100,
                        tax: ec.taxCents / 100,
                        shipping: ec.shippingCents / 100,
                        items: [ec.item],
                      },
                    }
                  : {}),
              });
            })
            .catch(() => purchaseOnce(ref, {
              ...adsUserData({ email: me?.email }),
              transaction_id: ref, event_id: `purchase-${ref}`, currency: "EUR", payment_status: "paid",
              ecommerce: { transaction_id: ref, currency: "EUR" },
            }));
          return;
        }
        if (r.paymentStatus === "failed" || r.paymentStatus === "expired") { setPayBanner("failed"); return; }
        stillInFlight = r.paymentStatus === "created";
      } catch { /* сеть мигнула — следующий заход */ }
      if (attempts < 10) pollTimer.current = setTimeout(poll, 2000);
      else setPayBanner(stillInFlight ? "processing" : "failed");
    };
    void poll();
    return () => { if (pollTimer.current) clearTimeout(pollTimer.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signedIn]);

  const marketing = me?.marketingOptIn === true;
  const setMarketing = (next: boolean) => {
    void publicApi
      .request("PATCH", "/api/public/me", { marketingOptIn: next })
      .then(() => { say(next ? t("ac.marketingOn") : t("ac.marketingOff")); data.refresh(); })
      .catch(() => say(t("err.generic")));
  };
  const saveAlias = async (alias: string): Promise<boolean> => {
    if (!alias || alias === me?.alias) return true;
    try {
      await publicApi.request("PATCH", "/api/public/me", { alias });
      say(t("kb.saved"));
      data.refresh();
      return true;
    } catch { say(t("err.generic")); return false; }
  };
  const signOut = () => { publicApi.logout(); window.location.href = "/"; };

  const liveBids = bids.filter((b) => b.status === "live");
  const wonBids = bids.filter((b) => b.status !== "live" && b.youLead);
  const outbidLive = liveBids.filter((b) => !b.youLead);
  const unpaid = orders.filter((o) => o.status === "awaiting_payment");
  const watched = catalog.filter((a) => watchIds.includes(a.id));
  const watchedNotMine = watched.filter((w) => w.status === "live" && !bids.some((b) => b.id === w.id));

  const counts: Record<Tab, number> = {
    parskats: 0,
    izsoles: liveBids.length,
    pirkumi: orders.length,
    velmes: watchIds.length,
    bridinajumi: 0,
    iznemsana: pickup.pickup.length,
    verifikacija: 0,
    iestatijumi: 0,
  };

  if (signedIn === false) {
    return (
      <section className="wrap acct-page" style={{ paddingTop: 40 }}>
        <div className="empty">
          <span className="ic" aria-hidden="true"><Ph name="shield-check" size={22} /></span>
          <h3>{t("a.signinToBid")}</h3>
          <p>{t("ac.signinNeeded")}</p>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", justifyContent: "center" }}>
            <Link className="btn btn-primary" href={loginHref("/account")}>{t("nav.signin")}</Link>
            <Link className="btn btn-outline" href="/register">{t("nav.register")}</Link>
          </div>
        </div>
      </section>
    );
  }

  const bannerText: Record<Exclude<PayBanner, null>, string> = {
    confirming: t("acc.payConfirming"),
    success: t("acc.paySuccess"),
    failed: t("acc.payFailed"),
    cancelled: t("acc.payCancelled"),
    processing: t("acc.payProcessing"),
  };
  const bannerTone = (kind: PayBanner) =>
    kind === "success" ? "win" : kind === "confirming" || kind === "processing" ? "info" : "out";

  // Пункт «Verifikācija» появляется, только когда движок отдаёт состояние
  // почты — до этапа аккаунтов его просто нет, врать статусом нельзя.
  const showVerif = me?.emailVerified !== undefined;
  const navItems: Array<[Tab, string, string]> = [
    ...TABS.slice(0, 6),
    ...(showVerif ? ([["verifikacija", "kb.verification", "shield-check"]] as Array<[Tab, string, string]>) : []),
    TABS[6]!,
  ];

  const userCard = (
    <div className="acu">
      <span className="ava" aria-hidden="true">{(me?.alias ?? "?").slice(0, 1).toUpperCase()}</span>
      <span className="t">
        <b>{me?.alias ?? "—"}</b>
        <small className={me?.blocked ? "st off" : "st"}>
          <i aria-hidden="true" />
          {/* «Apstiprināts» — только когда движок реально проверил почту. */}
          {me?.blocked ? t("ac.inactive")
            : !showVerif ? t("ac.active")
            : me?.emailVerified === false ? t("kb.notConfirmed") : t("kb.confirmed")}
        </small>
      </span>
    </div>
  );

  return (
    <section className="wrap acct-page" style={{ paddingTop: 16 }}>
      <nav className="crumbs" aria-label={t("nav.breadcrumb")}>
        <ol><li><Link href="/">{t("nav.home")}</Link></li><li aria-current="page">{t("nav.account")}</li></ol>
      </nav>

      {payBanner && <p className={`bb-status ${bannerTone(payBanner)}`}>{bannerText[payBanner]}</p>}

      {/* № 50 «Pabeidz profilu»: после входа через Telegram адреса ещё нет —
          без него не работают письма, а значит и ставки. */}
      {me?.emailPending && (
        <p className="bb-status info">
          {t("kb.pabeidzBanner")}{" "}
          <a href="/account?tab=iestatijumi&s=profils">{t("kb.pabeidzGo")}</a>
        </p>
      )}

      <div className="acwrap">
        <aside className="acnav" aria-label={t("ac.sections")}>
          {userCard}
          <nav className="acnav-list">
            {navItems.map(([id, label, icon]) => (
              <button key={id} type="button" className={`acnav-i${tab === id ? " on" : ""}`}
                      aria-current={tab === id ? "page" : undefined} onClick={() => goTab(id)}>
                <Ph name={icon} size={18} />
                <span>{t(label)}</span>
                {counts[id] > 0 && <span className="n">{counts[id]}</span>}
              </button>
            ))}
          </nav>
          <button className="acnav-exit" type="button" onClick={signOut}>
            <Ph name="sign-out" size={18} /> {t("ac.signOutFull")}
          </button>
        </aside>

        <div className="acmob">
          {userCard}
          <nav className="acchips" aria-label={t("ac.sections")}>
            {navItems.map(([id, label, icon]) => (
              <button key={id} type="button" className={`acchip${tab === id ? " on" : ""}`}
                      aria-current={tab === id ? "page" : undefined} onClick={() => goTab(id)}>
                <Ph name={icon} size={16} />{t(label)}
                {counts[id] > 0 && <span className="n">{counts[id]}</span>}
              </button>
            ))}
          </nav>
        </div>

        <main className="acpanel">
          {tab === "parskats" && (
            <Overview
              bids={bids} unpaid={unpaid} feesCents={fees?.outstandingCents ?? 0}
              pickupCount={pickup.pickup.length} goTab={goTab} lang={lang}
              onHistory={(id) => {
                setTab("izsoles"); setHistoryLot(id);
                window.history.replaceState(null, "", `/account?tab=izsoles&lot=${id}`);
              }}
              verifyBlock={showVerif && me?.emailVerified === false && !me?.emailPending ? <VerifyNotice email={me?.email ?? ""} compact /> : null}
            />
          )}

          {tab === "izsoles" && historyLot && (
            <BidHistory
              auctionId={historyLot}
              onBack={() => { setHistoryLot(null); window.history.replaceState(null, "", "/account?tab=izsoles"); }}
            />
          )}
          {tab === "izsoles" && !historyLot && (
            <div className="acct">
              <div className="page-head" style={{ alignItems: "flex-start" }}>
                <div>
                  <h1 data-hero>{t("acc.myBids")}</h1>
                  <p className="cnt">{izsFilter === "console" ? t("kb.fConsole") : t("kb.myAuctionsSub")}</p>
                </div>
              </div>
              <div className="subpills" role="tablist">
                {([
                  ["active", t("kb.fActive"), liveBids.length],
                  ["won", t("kb.fWon"), wonBids.length],
                  ["outbid", t("kb.fOutbid"), outbidLive.length],
                  ["watch", t("kb.fWatch"), watchedNotMine.length],
                  ["console", t("kb.fConsole"), 0],
                ] as const).map(([id, label, n]) => (
                  <button key={id} type="button" role="tab" aria-selected={izsFilter === id}
                          className={`subpill${izsFilter === id ? " on" : ""}${id === "console" ? " dark" : ""}`}
                          onClick={() => setIzsFilter(id)}>
                    {label}{n > 0 && <span className="n">{n}</span>}
                  </button>
                ))}
              </div>

              {izsFilter === "console" ? (
                <Console bids={bids} watched={watched} />
              ) : (
                <BidList
                  lang={lang}
                  rows={
                    izsFilter === "active" ? liveBids
                    : izsFilter === "won" ? wonBids
                    : izsFilter === "outbid" ? outbidLive
                    : watchedNotMine.map((w) => ({ ...w, youLead: false }))
                  }
                  watchMode={izsFilter === "watch"}
                  onHistory={(id) => {
                    setHistoryLot(id);
                    window.history.replaceState(null, "", `/account?tab=izsoles&lot=${id}`);
                  }}
                  empty={
                    <div className="empty">
                      <span className="ic" aria-hidden="true"><Ph name="gavel" size={22} /></span>
                      <h3>{t("kb.emptyBidsT")}</h3>
                      <p>{t("kb.emptyBidsD")}</p>
                      <Link className="btn btn-primary" href="/katalogs">{t("ac.findLot")}</Link>
                    </div>
                  }
                />
              )}
            </div>
          )}

          {tab === "pirkumi" && <Purchases orders={orders} lang={lang} />}

          {tab === "velmes" && (
            <div className="acct">
              <div className="page-head" style={{ alignItems: "flex-start" }}>
                <div>
                  <h1 data-hero>{t("nav.watchlist")}</h1>
                  <p className="cnt">{t("kb.wishesSub", { n: watchIds.length })}</p>
                </div>
              </div>
              {watched.length === 0 ? (
                <div className="empty">
                  <span className="ic" aria-hidden="true"><Ph name="heart" size={22} /></span>
                  <h3>{t("kb.emptyWishT")}</h3>
                  <p>{t("kb.emptyWishD")}</p>
                  <Link className="btn btn-primary" href="/katalogs">{t("kb.findLots")}</Link>
                </div>
              ) : (
                <div className="grid wish-grid">
                  {watched.map((a) => <LotCard key={a.id} lot={a} />)}
                </div>
              )}
              <SavedSearches />
            </div>
          )}

          {tab === "bridinajumi" && (
            <div className="acct">
              <div className="page-head" style={{ alignItems: "flex-start" }}>
                <div>
                  <h1 data-hero>{t("nav.alerts")}</h1>
                  <p className="cnt">{t("kb.alertsSub")}</p>
                </div>
              </div>
              {notifications.length === 0 ? (
                <div className="empty">
                  <span className="ic" aria-hidden="true"><Ph name="bell" size={22} /></span>
                  <h3>{t("kb.emptyAlertsT")}</h3>
                  <p>{t("kb.emptyAlertsD")}</p>
                  <Link className="btn btn-primary" href="/katalogs">{t("kb.findLots")}</Link>
                </div>
              ) : (
                <div className="feedcard">
                  {notifications.map((n) => (
                    <div className="feedrow" key={n.id}>
                      <span className={`ic t-${n.type}`} aria-hidden="true">
                        <Ph name={n.type === "outbid" ? "gavel" : n.type === "won" ? "check" : "bell"} size={16} />
                      </span>
                      <span className="t">
                        <b>{n.subject}</b>
                        <small>{n.body}</small>
                      </span>
                      <small className="when">{relTime(n.createdAt, t)}</small>
                    </div>
                  ))}
                </div>
              )}
              {alertIds.length > 0 && <p className="note">{t("nav.alerts")}: {alertIds.length}</p>}
            </div>
          )}

          {tab === "iznemsana" && (
            <div className="acct">
              <div className="page-head" style={{ alignItems: "flex-start" }}>
                <div>
                  <h1 data-hero>{t("ac.pickup")}</h1>
                  <p className="cnt">{t("kb.pickupSub")}</p>
                </div>
              </div>
              <Pickup info={pickup} shipments={shipments} />
            </div>
          )}

          {tab === "verifikacija" && showVerif && (
            <div className="acct">
              <div className="page-head" style={{ alignItems: "flex-start" }}>
                <div>
                  <h1 data-hero>{t("kb.verification")}</h1>
                  <p className="cnt">{me?.emailVerified ? t("kb.verifOkSub") : t("kb.verifNoSub")}</p>
                </div>
              </div>
              {me?.emailVerified ? (
                <div className="empty">
                  <span className="ic on" aria-hidden="true"><Ph name="check" size={22} /></span>
                  <h3>{t("kb.verifOk")}</h3>
                  <p>{me?.email}</p>
                </div>
              ) : me?.emailPending ? (
                /* № 50: адреса ещё нет — письмо слать некуда, зовём вписать его. */
                <div className="empty">
                  <span className="ic" aria-hidden="true"><Ph name="envelope-simple" size={22} /></span>
                  <h3>{t("kb.pabeidzBanner")}</h3>
                  <p><a className="btn btn-primary" href="/account?tab=iestatijumi&s=profils">{t("kb.pabeidzGo")}</a></p>
                </div>
              ) : (
                <VerifyNotice email={me?.email ?? ""} />
              )}
            </div>
          )}

          {tab === "iestatijumi" && (
            <SettingsHub
              me={me} bids={bids} orders={orders} pickupCount={pickup.pickup.length}
              marketing={marketing} onMarketing={setMarketing} onAlias={saveAlias} onSignOut={signOut}
            />
          )}
        </main>
      </div>
    </section>
  );
}

/* ── Pārskats: что требует действия + активные ставки ──────────────────────
 * Непустого макета для Pārskats в комплекте нет — экран собран из
 * утверждённых частей: рядов «Manas izsoles» и горячих ссылок. */
function Overview({
  bids, unpaid, feesCents, pickupCount, goTab, onHistory, lang, verifyBlock,
}: {
  bids: MyBidAuction[];
  unpaid: MyOrder[];
  feesCents: number;
  pickupCount: number;
  goTab: (t: Tab) => void;
  onHistory: (id: string) => void;
  lang: Lang;
  verifyBlock: React.ReactNode;
}) {
  const { t } = useT();
  const liveBids = bids.filter((b) => b.status === "live");
  const unpaidCents = unpaid.reduce((s, o) => s + o.totalCents, 0);
  const hasTodo = feesCents > 0 || unpaid.length > 0 || pickupCount > 0;

  return (
    <div className="acct">
      <div className="page-head" style={{ alignItems: "flex-start" }}>
        <div>
          <h1 data-hero>{t("ac.overview")}</h1>
          <p className="cnt">{hasTodo || liveBids.length > 0 ? t("kb.myAuctionsSub") : t("kb.nothingWaits")}</p>
        </div>
      </div>

      {verifyBlock}

      {hasTodo && (
        <div className="todo">
          {feesCents > 0 && (
            <button className="hot" type="button" onClick={() => goTab("pirkumi")}>
              <span className="ic"><Ph name="shield-check" size={18} /></span>
              <span className="t"><b>{t("fees.banner")} {formatEur(feesCents)}</b></span>
              <Ph name="caret-right" size={14} className="go" />
            </button>
          )}
          {unpaid.length > 0 && (
            <button className="hot" type="button" onClick={() => goTab("pirkumi")}>
              <span className="ic"><Ph name="package" size={18} /></span>
              <span className="t">
                <b>{t("kb.fToPay")}: {unpaid.length} · {formatEur(unpaidCents)}</b>
                {unpaid[0]?.paymentDeadlineAt && (
                  <small>{t("kb.until")} {new Date(unpaid[0].paymentDeadlineAt).toLocaleDateString(dateLocale(lang))}</small>
                )}
              </span>
              <Ph name="caret-right" size={14} className="go" />
            </button>
          )}
          {pickupCount > 0 && (
            <button className="hot ok" type="button" onClick={() => goTab("iznemsana")}>
              <span className="ic"><Ph name="map-pin" size={18} /></span>
              <span className="t"><b>{t("pickup.title")}: {pickupCount}</b></span>
              <Ph name="caret-right" size={14} className="go" />
            </button>
          )}
        </div>
      )}

      <h2 className="ttl-sm">{t("kb.fActive")} · {liveBids.length}</h2>
      <BidList
        lang={lang}
        rows={liveBids}
        onHistory={onHistory}
        empty={
          <div className="empty">
            <span className="ic" aria-hidden="true"><Ph name="gavel" size={22} /></span>
            <h3>{t("kb.emptyOverT")}</h3>
            <p>{t("kb.emptyOverD")}</p>
            <Link className="btn btn-primary" href="/katalogs">{t("ac.toCatalogue")}</Link>
          </div>
        }
      />
    </div>
  );
}

/* Ряды «Manas izsoles» (макет № 01): картинка, лот, твоя ставка, отсчёт. */
function BidList({
  rows, empty, onHistory, watchMode, lang,
}: {
  rows: MyBidAuction[];
  empty: React.ReactNode;
  onHistory: (id: string) => void;
  watchMode?: boolean;
  lang: Lang;
}) {
  const { t } = useT();
  if (rows.length === 0) return <>{empty}</>;
  return (
    <div className="bidlist">
      {rows.map((b) => {
        const live = b.status === "live";
        const price = b.currentPriceCents ?? b.startPriceCents ?? 0;
        const state = !live ? (b.youLead ? "won" : "ended") : b.youLead && !watchMode ? "lead" : watchMode ? "watch" : "out";
        return (
          <div className={`bidrow ${state}`} key={b.id}>
            <Link className="pic" href={`/auction/${b.id}`} aria-hidden="true" tabIndex={-1}>
              {b.photos[0] ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={photoThumb(b.photos[0])} alt="" loading="lazy" />
              ) : <Ph name="gavel" size={18} />}
            </Link>
            <span className="t">
              <b><Link href={`/auction/${b.id}`}>{b.title}</Link></b>
              <small className="tnum">{b.sku} · {t("kb.bidsN", { n: b.bidCount })}</small>
            </span>
            <span className="r">
              {!watchMode && <small className="lbl">{t("kb.yourBid")}</small>}
              <b className="tnum">{formatEur(price)}</b>
              <span className={`pill ${state}`}>
                <i aria-hidden="true" />
                {!live ? (b.youLead ? t("kb.fWon") : t("card.ended"))
                  : watchMode ? t("kb.fWatch")
                  : b.youLead ? t("kb.youLead") : t("kb.fOutbid")}
              </span>
            </span>
            <span className="cd tnum">{live ? <Countdown endsAt={b.endsAt} lang={lang} /> : null}</span>
            <button className="hist" type="button" onClick={() => onHistory(b.id)} aria-label={t("kb.historyTitle")}>
              <Ph name="caret-right" size={15} />
            </button>
          </div>
        );
      })}
    </div>
  );
}

/* Pirkumi (макет № 33): фильтры + раскрывающиеся карточки с хронологией. */
function Purchases({ orders, lang }: { orders: MyOrder[]; lang: Lang }) {
  const { t } = useT();
  const [filter, setFilter] = useState<"all" | "topay" | "paid">("all");
  const [open, setOpen] = useState<string | null>(null);
  const [receiptRef, setReceiptRef] = useState<string | null>(null);

  useEffect(() => {
    const cek = new URLSearchParams(window.location.search).get("cek");
    if (cek) setReceiptRef(cek);
  }, []);

  const unpaid = orders.filter((o) => o.status === "awaiting_payment");
  const paidRows = orders.filter((o) => o.status === "paid");

  /* Аналитика (GTM): «к оплате» — это и есть корзина.
   *
   * Экран общей оплаты показывают только при двух и более лотах, поэтому у
   * покупателя ОДНОГО лота воронка обрывалась: просмотр → сразу оплата, без
   * ступеней AddToCart и ViewCart, под которые настраивают кампании Meta и
   * Google. Здесь эти ступени есть при любом числе лотов.
   *
   * add_to_cart — по одному разу на заказ: выигранные торги попадают в список
   * без нажатия, и без отметки событие уходило бы при каждом заходе. */
  const unpaidKey = unpaid.map((o) => o.ref).join(",");
  useEffect(() => {
    // Значок в шапке и в нижней панели берёт число отсюда: список уже
    // загружен, отдельный запрос ради счётчика был бы лишним.
    setCartCount(unpaid.length);
    if (unpaid.length === 0) return;
    const ecs = unpaid.map(orderEcom);
    const net = ecs.reduce((s, e) => s + e.netCents, 0);
    const gross = ecs.reduce((s, e) => s + e.grossCents, 0) / 100;
    unpaid.forEach((o, i) => {
      const e = ecs[i]!;
      addToCartOnce(o.ref, {
        item_id: o.itemSku, item_name: o.itemTitle,
        value: e.netCents / 100, currency: "EUR",
        gross_total: e.grossCents / 100,
        commission_value: e.commissionCents / 100,
        vat_scheme: e.vatScheme,
        cart_size: unpaid.length, cart_gross_total: gross,
        ecommerce: { currency: "EUR", value: e.netCents / 100, items: [e.item] },
      });
    });
    track("view_cart", {
      value: net / 100, currency: "EUR",
      gross_total: gross, cart_gross_total: gross, cart_size: unpaid.length,
      ecommerce: { currency: "EUR", value: net / 100, items: ecs.map((e) => e.item) },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unpaidKey]);

  if (receiptRef) {
    return (
      <Receipt
        orderRef={receiptRef}
        onBack={() => { setReceiptRef(null); window.history.replaceState(null, "", "/account?tab=pirkumi"); }}
      />
    );
  }

  const rows = filter === "topay" ? unpaid : filter === "paid" ? paidRows : orders;

  const short = (d: string | null | undefined) => (d ? new Date(d).toLocaleDateString(dateLocale(lang)) : "—");
  const when = (d: string | null | undefined) =>
    d ? new Date(d).toLocaleString(dateLocale(lang), { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—";

  // Проценты выводим из сумм заказа, а не из констант: движок — источник правды.
  const vatPct = (o: MyOrder) => {
    const base = o.hammerCents + o.premiumCents + o.shippingCents + o.handlingCents;
    return base > 0 ? Math.round((o.vatCents / base) * 100) : 21;
  };
  const premPct = (o: MyOrder) => (o.hammerCents > 0 ? Math.round((o.premiumCents / o.hammerCents) * 100) : 10);

  return (
    <div className="acct">
      <div className="page-head" style={{ alignItems: "flex-start" }}>
        <div>
          <h1 data-hero>{t("kb.purchases")}</h1>
          <p className="cnt">{t("kb.purchSub")}</p>
        </div>
      </div>
      <CreditBoard />
      {/* Вход в корзину — при ЛЮБОМ числе неоплаченных лотов. Раньше он
          появлялся только от двух, и покупатель одного лота корзины не
          видел вовсе: страница /grozs существовала, а попасть на неё было
          неоткуда. Текст и кнопка разные: «оплатить вместе» про один лот
          звучало бы нелепо. */}
      {unpaid.length > 0 && (
        <div className="cart-cta">
          <span className="t">
            <b>{t("cart.ctaT", { n: unpaid.length })}</b>
            <small>{unpaid.length > 1 ? t("cart.ctaD") : t("cart.ctaD1")}</small>
          </span>
          <Link className="btn btn-primary" href="/grozs">
            <Ph name="package" size={18} /> {unpaid.length > 1 ? t("cart.ctaBtn") : t("cart.ctaBtn1")}
          </Link>
        </div>
      )}
      <div className="subpills" role="tablist">
        {([["all", t("kb.fAll"), orders.length], ["topay", t("kb.fToPay"), unpaid.length], ["paid", t("kb.fPaid"), paidRows.length]] as const).map(([id, label, n]) => (
          <button key={id} type="button" role="tab" aria-selected={filter === id}
                  className={`subpill${filter === id ? " on" : ""}`} onClick={() => setFilter(id)}>
            {label}{n > 0 && <span className="n">{n}</span>}
          </button>
        ))}
      </div>

      {rows.length === 0 ? (
        <div className="empty">
          <span className="ic" aria-hidden="true"><Ph name="package" size={22} /></span>
          <h3>{t("kb.emptyPurchT")}</h3>
          <p>{t("kb.emptyPurchD")}</p>
          <Link className="btn btn-primary" href="/katalogs">{t("ac.toCatalogue")}</Link>
        </div>
      ) : rows.map((o) => {
        const isOpen = open === o.ref;
        const awaiting = o.status === "awaiting_payment";
        const cancelled = o.status === "cancelled";
        return (
          <div className={`buy${isOpen ? " open" : ""}`} key={o.ref}>
            <button className="buy-h" type="button" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : o.ref)}>
              <span className="t">
                <span className="ref tnum">{o.ref} · {short(o.createdAt)}</span>
                <b>{o.itemTitle}</b>
                <span className={`stpill ${awaiting ? "wait" : cancelled ? "canc" : "paid"}`}>
                  <i aria-hidden="true" />{awaiting ? t("acc.awaiting") : cancelled ? t("ac.cancelled") : t("acc.paid")}
                </span>
              </span>
              <span className="r">
                <span className="money tnum">{formatEur(o.totalCents)}</span>
                <Ph name="caret-down" size={16} className="chev" />
              </span>
            </button>
            {isOpen && (
              <div className="buy-b">
                <table>
                  <tbody>
                    <tr><th>{t("ac.hammer")}</th><td className="tnum">{formatEur(o.hammerCents)}</td></tr>
                    <tr><th>{t("ac.premium")} {premPct(o)} %</th><td className="tnum">{formatEur(o.premiumCents)}</td></tr>
                    {o.shippingCents > 0
                      ? <tr><th>{t("co.delivery")}</th><td className="tnum">{formatEur(o.shippingCents)}</td></tr>
                      : <tr><th>{t("kb.pickupWh")}</th><td className="tnum">{formatEur(0)}</td></tr>}
                    {o.handlingCents > 0 && <tr><th>{t("co.handling")}</th><td className="tnum">{formatEur(o.handlingCents)}</td></tr>}
                    <tr><th>{t("ac.vat")} {vatPct(o)} %</th><td className="tnum">{formatEur(o.vatCents)}</td></tr>
                    <tr className="tot"><th>{t("ac.total")}</th><td className="tnum">{formatEur(o.totalCents)}</td></tr>
                  </tbody>
                </table>

                <div className="tl">
                  <div className="tl-r">
                    <span className="k">{t("kb.lot")}</span>
                    <b className="tnum">{o.itemSku}{o.itemCondition ? ` · ${o.itemCondition}` : ""}</b>
                  </div>
                  <div className="tl-r done">
                    <span className="k">{t("kb.wonAt")}</span>
                    <b>{when(o.createdAt)}</b>
                  </div>
                  {o.paidAt && (
                    <div className="tl-r done">
                      <span className="k">{t("kb.paidAt")}</span>
                      <b>{when(o.paidAt)}</b>
                    </div>
                  )}
                  <div className="tl-r">
                    <span className="k">{t("kb.warranty")}</span>
                    <b>{t("kb.warrantyText")}</b>
                  </div>
                </div>

                <div className="acts">
                  {awaiting && (
                    <Link className="btn btn-primary" href={`/apmaksa/${encodeURIComponent(o.ref)}`}>{t("acc.pay")}</Link>
                  )}
                  {awaiting && o.paymentDeadlineAt && (
                    <span className="note">{t("kb.until")} {short(o.paymentDeadlineAt)}</span>
                  )}
                  {!awaiting && !cancelled && <InvoicePdfButton orderRef={o.ref} />}
                  {o.status === "paid" && (
                    <button className="btn btn-outline" type="button"
                            onClick={() => { setReceiptRef(o.ref); window.history.replaceState(null, "", `/account?tab=pirkumi&cek=${o.ref}`); }}>
                      <Ph name="check" size={16} /> {t("kb.receipt")}
                    </button>
                  )}
                  {o.itemCategory && (
                    <Link className="btn btn-outline" href={`/katalogs?cat=${encodeURIComponent(o.itemCategory)}`}>
                      {t("kb.findSimilar")}
                    </Link>
                  )}
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
