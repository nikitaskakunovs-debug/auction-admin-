"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { publicApi } from "@/lib/api";
import { PUBLIC_API_URL } from "@/lib/config";
import { dateLocale, useT } from "@/lib/i18n";
import { formatEur, type MyOrder, type PublicAuction } from "@/lib/types";
import { increment } from "@/lib/fees";
import { useNow, formatLeft } from "@/components/Countdown";
import { TrackingLine } from "@/components/DeliveryPicker";
import { FeesNotice } from "@/components/FeesNotice";
import { KlixPayLater } from "@/components/KlixPayLater";
import { PickupPass } from "@/components/PickupPass";
import { VerifyNotice } from "@/components/VerifyNotice";
import { Icon } from "@/components/Icon";
import { LotCard, type CardLot } from "@/components/LotCard";
import { alertStore } from "@/lib/ui";
import { watchStore } from "@/lib/watch";

type MyBidAuction = PublicAuction & { youLead: boolean; myMaxCents?: number | null };

/** Разделы кабинета. Адрес хранится в ?tab=, чтобы на них можно было
 *  сослаться из шапки, дока и писем. Профиль ушёл за шестерёнку. */
const TABS: Array<[Tab, string, string]> = [
  ["overview", "ac.overview", "home"],
  ["bids", "acc.myBids", "gavel"],
  ["orders", "ac.orders", "box"],
  ["watch", "nav.watchlist", "heart"],
  ["alerts", "nav.alerts", "bell"],
  ["pickup", "ac.pickup", "pin"],
  ["settings", "ac.settings", "gear"],
];
type Tab = "overview" | "bids" | "orders" | "watch" | "alerts" | "pickup" | "settings";

/** Banner state after coming back from a provider's checkout page. */
type PayBanner = "confirming" | "success" | "failed" | "cancelled" | "unavailable" | "processing" | null;

export default function AccountPage() {
  const { t, lang } = useT();
  const now = useNow();
  const [bids, setBids] = useState<MyBidAuction[]>([]);
  const [orders, setOrders] = useState<MyOrder[]>([]);
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [suspended, setSuspended] = useState(false);
  const [payBanner, setPayBanner] = useState<PayBanner>(null);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [tab, setTab] = useState<Tab>("overview");
  const [watchIds, setWatchIds] = useState<string[]>([]);
  const [alertIds, setAlertIds] = useState<string[]>([]);
  const [catalog, setCatalog] = useState<PublicAuction[]>([]);
  const [me, setMe] = useState<{ email: string; alias: string; emailVerified?: boolean } | null>(null);
  const [fees, setFees] = useState<{ outstandingCents: number } | null>(null);
  const [pickupReady, setPickupReady] = useState<Array<{ ref: string; pickupCode: string | null }>>([]);

  const [openBuy, setOpenBuy] = useState<string | null>(null);
  const [aliasDraft, setAliasDraft] = useState<string | null>(null);
  const [marketing, setMarketing] = useState(false);
  const [saveErr, setSaveErr] = useState(false);

  const loadOrders = useCallback(() => {
    void publicApi.get<{ orders: MyOrder[] }>("/api/public/me/orders").then((r) => setOrders(r.orders)).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!publicApi.hasSession) {
      setSignedIn(false);
      return;
    }
    setSignedIn(true);
    void publicApi.get<{ bids: MyBidAuction[] }>("/api/public/me/bids").then((r) => setBids(r.bids)).catch(() => undefined);
    loadOrders();
    void publicApi.get<{ outstandingCents: number }>("/api/public/me/fees").then(setFees).catch(() => undefined);
    void publicApi.get<{ pickup: Array<{ ref: string; pickupCode: string | null }> }>("/api/public/me/pickup")
      .then((r) => setPickupReady(r.pickup)).catch(() => undefined);
    void publicApi
      .get<{ bidder: { email: string; alias: string; blocked: boolean; emailVerified?: boolean; marketingOptIn?: boolean } }>("/api/public/auth/me")
      .then((r) => { setMe(r.bidder); setSuspended(r.bidder.blocked); setMarketing(Boolean(r.bidder.marketingOptIn)); })
      .catch(() => undefined);
  }, [loadOrders]);

  useEffect(() => {
    const sync = () => { setWatchIds(watchStore.list()); setAlertIds(alertStore.list()); };
    sync();
    const un1 = watchStore.subscribe(sync);
    const un2 = alertStore.subscribe(sync);
    return () => { un1(); un2(); };
  }, []);

  useEffect(() => {
    void fetch(`${PUBLIC_API_URL}/api/public/auctions?limit=100`)
      .then((r) => r.json() as Promise<{ auctions: PublicAuction[] }>)
      .then((r) => setCatalog(r.auctions))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    const q = new URLSearchParams(window.location.search).get("tab") as Tab | null;
    if (q && (TABS.some(([id]) => id === q) || q === "settings")) setTab(q);
  }, []);

  const navRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = navRef.current?.querySelector<HTMLElement>(".acct-tab.on");
    el?.scrollIntoView({ block: "nearest", inline: "center" });
  }, [tab]);

  const goTab = (id: Tab) => {
    setTab(id);
    const url = id === "overview" ? "/account" : `/account?tab=${id}`;
    window.history.replaceState(null, "", url);
  };

  useEffect(() => {
    if (signedIn !== true || typeof window === "undefined") return;
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
        const r = await publicApi.get<{ orderStatus: string; paymentStatus: string | null; provider: string | null }>(
          `/api/public/orders/${encodeURIComponent(ref)}/payment`,
        );
        if (r.orderStatus === "paid") { setPayBanner("success"); loadOrders(); return; }
        if (r.paymentStatus === "failed" || r.paymentStatus === "expired") { setPayBanner("failed"); return; }
        stillInFlight = r.paymentStatus === "created";
      } catch { /* transient — keep polling */ }
      if (attempts < 10) pollTimer.current = setTimeout(poll, 2000);
      else setPayBanner(stillInFlight ? "processing" : "failed");
    };
    void poll();
    return () => { if (pollTimer.current) clearTimeout(pollTimer.current); };
  }, [signedIn, loadOrders]);

  if (signedIn === false) {
    return (
      <section className="wrap acct-page" style={{ paddingTop: 40 }}>
        <div className="empty">
          <span className="ic" aria-hidden="true"><Icon name="shield" /></span>
          <h3>{t("a.signinToBid")}</h3>
          <p>{t("ac.signinNeeded")}</p>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", justifyContent: "center" }}>
            <Link className="btn btn-primary" href="/login">{t("nav.signin")}</Link>
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
    unavailable: t("acc.payUnavailable"),
    processing: t("acc.payProcessing"),
  };
  const bannerTone = (kind: PayBanner) =>
    kind === "success" ? "win" : kind === "confirming" || kind === "processing" ? "info" : "out";

  const liveBids = bids.filter((b) => b.status === "live");
  const outbid = liveBids.filter((b) => !b.youLead);
  const wonBids = bids.filter((b) => b.status !== "live" && b.youLead);
  const unpaid = orders.filter((o) => o.status === "awaiting_payment");
  const unpaidCents = unpaid.reduce((s, o) => s + o.totalCents, 0);
  const watched = catalog.filter((a) => watchIds.includes(a.id));
  const alerted = catalog.filter((a) => alertIds.includes(a.id));

  const counts: Record<Tab, number> = {
    overview: 0, bids: liveBids.length, orders: orders.length,
    watch: watchIds.length, alerts: alertIds.length,
    pickup: pickupReady.length, settings: 0,
  };

  const short = (d: string) => new Date(d).toLocaleDateString(dateLocale(lang));

  /* ── Активная ставка: главный блок кабинета ───────────────────── */
  const mybid = (b: MyBidAuction) => {
    const left = new Date(b.endsAt).getTime() - now;
    const settled = b.status !== "live";
    const state = settled ? (b.youLead ? "won" : "out") : b.youLead ? "win" : "out";
    const label = settled
      ? (b.youLead ? t("ac.youWon") : t("card.ended"))
      : b.youLead ? t("ac.youLead2") : t("acc.outbid");
    const price = b.currentPriceCents ?? b.startPriceCents ?? 0;
    return (
      <article className="mybid" key={b.id}>
        <span className={`pic frame-${(b.title.length % 4) + 1}`} aria-hidden="true" />
        <div className="t">
          <div className="row1">
            <span className={`lead ${state}`}><i aria-hidden="true" />{label}</span>
          </div>
          <h3><Link href={`/auction/${b.id}`}>{b.title}</Link></h3>
          <p className="now">
            <b className="tnum">{formatEur(price)}</b>
            {settled && b.youLead && <small>{t("ac.withFees")}</small>}
            {!settled && typeof b.myMaxCents === "number" && (
              <small>{t("ac.yourMax", { sum: formatEur(b.myMaxCents) })}</small>
            )}
          </p>
          <div className="foot">
            {settled ? (
              <span className="tl">{short(b.endsAt)}</span>
            ) : (
              <>
                <span className={`tl${left < 600_000 ? " crit" : ""}`}>
                  <Icon name="timer" size={14} />{formatLeft(left)}
                </span>
                <span className="who">{t("ac.biddersN", { n: b.bidCount })}</span>
              </>
            )}
            {settled && b.youLead ? (
              <button className="btn btn-primary" type="button" onClick={() => goTab("orders")}>{t("acc.pay")}</button>
            ) : b.youLead ? (
              <Link className="btn btn-outline" href={`/auction/${b.id}`}>{t("ac.view")}</Link>
            ) : (
              <Link className="btn btn-primary" href={`/auction/${b.id}`}>
                {t("ac.bidSum", { sum: formatEur(price + increment(price)) })}
              </Link>
            )}
          </div>
        </div>
      </article>
    );
  };

  /* ── Покупка: карточка, которая раскрывается ──────────────────── */
  const buy = (o: MyOrder) => {
    const open = openBuy === o.ref;
    const awaiting = o.status === "awaiting_payment";
    const cancelled = o.status === "cancelled";
    return (
      <div className={`buy${open ? " open" : ""}`} key={o.ref}>
        <button className="buy-h" type="button" aria-expanded={open}
                onClick={() => setOpenBuy(open ? null : o.ref)}>
          <span className="t">
            <span className="ref tnum">{o.ref} · {short(o.createdAt)}</span>
            <b>{o.itemTitle}</b>
            <span className={`stpill ${awaiting ? "wait" : cancelled ? "canc" : "paid"}`}>
              <i aria-hidden="true" />{awaiting ? t("acc.awaiting") : cancelled ? t("ac.cancelled") : t("acc.paid")}
            </span>
          </span>
          <span className="r">
            <span className="money">{formatEur(o.totalCents)}</span>
            <svg className="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
          </span>
        </button>

        {open && (
          <div className="buy-b">
            <table>
              <tbody>
                <tr><th>{t("ac.hammer")}</th><td>{formatEur(o.hammerCents)}</td></tr>
                <tr><th>{t("ac.premium")} 10 %</th><td>{formatEur(o.premiumCents)}</td></tr>
                {o.shippingCents > 0 && <tr><th>{t("co.delivery")}</th><td>{formatEur(o.shippingCents)}</td></tr>}
                {o.handlingCents > 0 && <tr><th>{t("co.handling")}</th><td>{formatEur(o.handlingCents)}</td></tr>}
                <tr><th>{t("ac.vat")} 21 %</th><td>{formatEur(o.vatCents)}</td></tr>
                <tr className="tot"><th>{t("ac.total")}</th><td>{formatEur(o.totalCents)}</td></tr>
              </tbody>
            </table>

            <div className="meta">
              <span>
                {t("ac.fulfilment")}:{" "}
                <b>
                  {o.fulfilment === "pickup"
                    ? t("ac.pickupRiga")
                    : o.shippingTo
                      ? `${o.shippingTo.provider === "dpd" ? "DPD" : "Omniva"} · ${o.shippingTo.name}`
                      : "—"}
                </b>
              </span>
              {o.shipment && <span>{t("ac.parcel")}: <b className="tnum">{o.shipment.barcode}</b></span>}
            </div>

            {o.status === "paid" && o.fulfilment !== "pickup" && <TrackingLine order={o} />}

            <div className="acts">
              {awaiting && (
                <Link className="btn btn-primary" href={`/apmaksa/${encodeURIComponent(o.ref)}`}>{t("acc.pay")}</Link>
              )}
              {awaiting && o.paymentDeadlineAt && (
                <span className="note">{t("ac.deadline", { date: short(o.paymentDeadlineAt) })}</span>
              )}
              <Link className="btn btn-outline" href={`/apmaksa/${encodeURIComponent(o.ref)}`}>{t("ac.invoicePdf")}</Link>
            </div>
            {awaiting && <KlixPayLater amountCents={o.totalCents} view="checkout" micro />}
          </div>
        )}
      </div>
    );
  };

  const empty = (icon: string, title: string, text: string, href: string, cta: string) => (
    <div className="empty">
      <span className="ic" aria-hidden="true"><Icon name={icon} /></span>
      <h3>{title}</h3>
      <p>{text}</p>
      <Link className="btn btn-primary" href={href}>{cta}</Link>
    </div>
  );

  const saveAlias = () => {
    const next = (aliasDraft ?? "").trim();
    if (next && next !== me?.alias) {
      void publicApi.request("PATCH", "/api/public/me", { alias: next })
        .then(() => setMe((m) => (m ? { ...m, alias: next } : m)))
        .catch(() => setSaveErr(true));
    }
    setAliasDraft(null);
  };

  return (
    <section className="wrap acct-page" style={{ paddingTop: 16 }}>
      <nav className="crumbs" aria-label={t("nav.breadcrumb")}>
        <ol><li><Link href="/">{t("nav.home")}</Link></li><li aria-current="page">{t("nav.account")}</li></ol>
      </nav>

      {/* Шапка кабинета: аватар, кто вошёл, шестерёнка.
          Статус показываем, только когда аккаунт ограничен — иначе он и так
          виден по тому, что ставки работают. */}
      <header className="acct-head">
        <span className="ava" aria-hidden="true">{(me?.alias ?? "?").slice(0, 1).toUpperCase()}</span>
        <span className="t">
          <b>{me?.alias ?? "—"}</b>
          <small>{me?.email ?? ""}</small>
        </span>
        <span className="st">{suspended ? t("ac.inactive") : t("ac.active")}</span>
      </header>

      {payBanner && <p className={`bb-status ${bannerTone(payBanner)}`}>{bannerText[payBanner]}</p>}

      {(
        <nav className="acct-nav" aria-label={t("ac.sections")} ref={navRef}>
          {TABS.map(([id, label, icon]) => (
            <button key={id} type="button" className={`acct-tab${tab === id ? " on" : ""}`}
                    aria-current={tab === id ? "page" : undefined} onClick={() => goTab(id)}>
              <Icon name={icon} size={18} />{t(label)}
              {counts[id] > 0 && <span className="n">{counts[id]}</span>}
            </button>
          ))}
        </nav>
      )}

      {tab === "overview" && (
        <div className="acct acct-cols">
          {/* ── JĀDARA: только то, что требует действия ── */}
          {((fees !== null && fees.outstandingCents > 0) || unpaid.length > 0 || pickupReady.length > 0) && (
            <aside className="acct-side">
              <h2 className="ttl-sm">{t("ac.todo")}</h2>
              <div className="todo">
                {fees && fees.outstandingCents > 0 && (
                  <Link className="hot" href="/account?tab=orders" onClick={() => goTab("orders")}>
                    <span className="ic"><Icon name="shield" size={19} /></span>
                    <span className="t">
                      <b>{t("fees.banner")} {formatEur(fees.outstandingCents)}</b>
                      <small>{t("ac.feesShort")}</small>
                    </span>
                    <svg className="go" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6" /></svg>
                  </Link>
                )}
                {unpaid.length > 0 && (
                  <Link className="hot" href="/account?tab=orders" onClick={() => goTab("orders")}>
                    <span className="ic"><Icon name="box" size={19} /></span>
                    <span className="t">
                      <b>{unpaid.length === 1 ? t("ac.toPayN1") : t("ac.toPayN", { n: unpaid.length })} · {formatEur(unpaidCents)}</b>
                      {unpaid[0]?.paymentDeadlineAt && (
                        <small>{t("ac.deadline", { date: short(unpaid[0].paymentDeadlineAt) })}</small>
                      )}
                    </span>
                    <svg className="go" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6" /></svg>
                  </Link>
                )}
                {pickupReady.length > 0 && (
                  <Link className="ok" href="/account?tab=pickup" onClick={() => goTab("pickup")}>
                    <span className="ic"><Icon name="box" size={19} /></span>
                    <span className="t">
                      <b>{pickupReady.length === 1 ? t("ac.readyN1") : t("ac.readyN", { n: pickupReady.length })}</b>
                      <small>
                        {pickupReady[0]?.pickupCode ? `${t("ac.pickupCode")} ${pickupReady[0].pickupCode} · ` : ""}
                        {t("ac.pickupAddr")}
                      </small>
                    </span>
                    <svg className="go" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6" /></svg>
                  </Link>
                )}
              </div>
            </aside>
          )}

          {/* ── Активные лоты — то, ради чего заходят ── */}
          <div className="acct-main">
          <section>
            <h2 className="ttl-sm">{t("ac.myActive")} · {liveBids.length}</h2>
            {liveBids.length === 0
              ? empty("gavel", t("ac.nowhereBidding"), t("ac.nowhereBiddingD"), "/katalogs", t("ac.toCatalogue"))
              : [...liveBids.filter((b) => b.youLead), ...outbid].map(mybid)}
          </section>

          {wonBids.length > 0 && (
            <section>
              <h2 className="ttl-sm">{t("ac.wonLots")}</h2>
              {wonBids.map(mybid)}
            </section>
          )}

          <p className="note">{t("ac.belowNote")}</p>
          </div>
        </div>
      )}

      {tab === "bids" && (
        <div className="acct">
          <section>
            {bids.length === 0
              ? empty("gavel", t("sec.noBidsYet"), t("ac.noBidsD2"), "/katalogs", t("ac.findLot"))
              : bids.map(mybid)}
          </section>
        </div>
      )}

      {tab === "orders" && (
        <div className="acct">
          <FeesNotice />
          <section className="card-b">
            <h2>{t("ac.myPurchases")}</h2>
            {orders.length === 0
              ? empty("box", t("ac.noOrders"), t("ac.noOrdersD"), "/katalogs", t("lr.openCatalogue"))
              : orders.map(buy)}
          </section>
        </div>
      )}

      {tab === "watch" && (
        <div className="acct">
          {watched.length === 0
            ? empty("heart", t("ac.listEmpty"), t("ac.listEmptyD"), "/katalogs", t("ac.findLots"))
            : <div className="results">{watched.map((a) => <LotCard key={a.id} lot={a as CardLot} />)}</div>}
        </div>
      )}

      {tab === "alerts" && (
        <div className="acct">
          {alerted.length === 0
            ? empty("bell", t("ac.noAlerts"), t("ac.noAlertsD"), "/katalogs", t("ac.findLots"))
            : <div className="results">{alerted.map((a) => <LotCard key={a.id} lot={a as CardLot} />)}</div>}
        </div>
      )}

      {tab === "pickup" && (
        <div className="acct">
          <PickupPass />
          <section className="card-b">
            <h2>{t("ac.pickupRiga")}</h2>
            <p className="note">{t("ac.pickupNote")}</p>
            <p style={{ marginTop: 12 }}>
              <Link className="btn btn-outline" href="/kontakti">{t("ac.contactsHours")}</Link>
            </p>
          </section>
        </div>
      )}

      {/* ═══ НАСТРОЙКИ ЗА ШЕСТЕРЁНКОЙ ═══ */}
      {tab === "settings" && (
        <div className="acct">
          <div className="page-head" style={{ alignItems: "flex-start" }}>
            <div>
              <p className="cnt" style={{ marginTop: 0 }}>{me?.alias ?? ""}</p>
              <h1 data-hero>{t("ac.settings")}</h1>
            </div>
          </div>

          <section className="card-b">
            <div className="setgroup">
              <h3>{t("ac.profile")}</h3>

              <div className={`prow${aliasDraft !== null ? " editing" : ""}`}>
                <span className="t">
                  <span className="k">{t("ac.alias")}</span>
                  {aliasDraft === null && <span className="v">{me?.alias ?? "—"}</span>}
                </span>
                {aliasDraft === null ? (
                  <button className="btn btn-outline btn-sm" type="button"
                          onClick={() => setAliasDraft(me?.alias ?? "")}>{t("ac.change")}</button>
                ) : (
                  <span className="edit">
                    <input value={aliasDraft} maxLength={24} aria-label={t("ac.alias")}
                           onChange={(e) => setAliasDraft(e.target.value)} />
                    <button className="btn btn-primary" type="button" onClick={saveAlias}>{t("ac.save")}</button>
                  </span>
                )}
              </div>
              {aliasDraft !== null && <p className="note">{t("ac.aliasHint")}</p>}

              <div className="prow">
                <span className="t">
                  <span className="k">{t("auth.email")}</span>
                  <span className="v">{me?.email ?? "—"}</span>
                </span>
                {me?.emailVerified === false && (
                  <span className="stpill wait"><i aria-hidden="true" />{t("ac.notConfirmed")}</span>
                )}
              </div>

              <div className="prow">
                <span className="t">
                  <span className="k">{t("ac.password")}</span>
                  <span className="v">••••••••</span>
                </span>
                <Link className="btn btn-outline btn-sm" href="/forgot-password">{t("ac.change")}</Link>
              </div>
            </div>

            {me?.emailVerified === false && (
              <div style={{ marginTop: 16 }}><VerifyNotice email={me.email} compact /></div>
            )}

            {/* Уведомления и согласия — тем же переключателем, что в cookie-плашке. */}
            <div className="setgroup">
              <h3>{t("ac.notifications")}</h3>

              <div className="setrow q">
                <span className="t">
                  <b>{t("ac.outbidAlerts")}</b>
                  <small>{t("ac.outbidAlertsD")}</small>
                </span>
                <span className="sw" role="switch" aria-checked="true" aria-disabled="true" aria-label={t("ac.outbidAlerts")} />
              </div>

              <div className="setrow q">
                <span className="t">
                  <b>{t("ac.marketing")}</b>
                  <small>{t("ac.marketingD")}</small>
                </span>
                <button className="sw" type="button" role="switch"
                        aria-checked={marketing} aria-label={t("ac.marketing")}
                        onClick={() => {
                          const next = !marketing;
                          setMarketing(next);
                          void publicApi.request("PATCH", "/api/public/me", { marketingOptIn: next })
                            .catch(() => { setMarketing(!next); setSaveErr(true); });
                        }} />
              </div>
            </div>

            {saveErr && <p className="bb-status out" style={{ marginTop: 12 }}>{t("err.generic")}</p>}

            <p className="note" style={{ marginTop: 16 }}>{t("ac.privacyNote")}</p>

            {/* Выход — отдельным блоком, не в ленте табов. */}
            <div className="acct-exit">
              <button className="btn-out" type="button" onClick={() => publicApi.logout()}>
                <Icon name="x" size={19} />{t("ac.signOutFull")}
              </button>
            </div>

            {/* Удаление спрятано внутри свёрнутого блока. */}
            <details className="acct-more">
              <summary>
                {t("ac.accountSettings")}
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
              </summary>
              <div className="inner">
                <p className="note">{t("ac.dangerNote")}</p>
                <Link className="quiet" href="/kontakti">{t("ac.deleteAccount")}</Link>
              </div>
            </details>
          </section>
        </div>
      )}
    </section>
  );
}
