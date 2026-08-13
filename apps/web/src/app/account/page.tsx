"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { publicApi, PublicApiError } from "@/lib/api";
import { PUBLIC_API_URL } from "@/lib/config";
import { useT } from "@/lib/i18n";
import { formatEur, type MyOrder, type PublicAuction } from "@/lib/types";
import { Countdown } from "@/components/Countdown";
import { TrackingLine } from "@/components/DeliveryPicker";
import { FeesNotice } from "@/components/FeesNotice";
import { KlixPayLater } from "@/components/KlixPayLater";
import { PickupPass } from "@/components/PickupPass";
import { Icon } from "@/components/Icon";
import { LotCard, type CardLot } from "@/components/LotCard";
import { alertStore } from "@/lib/ui";
import { watchStore } from "@/lib/watch";

type MyBidAuction = PublicAuction & { youLead: boolean };

/** Экраны кабинета. Адрес хранится в ?tab=, чтобы на них можно было
 *  сослаться из шапки, дока и писем. */
const TABS: Array<[Tab, string, string]> = [
  ["overview", "Pārskats", "home"],
  ["bids", "Mani solījumi", "gavel"],
  ["orders", "Pasūtījumi", "box"],
  ["watch", "Vēlmes", "heart"],
  ["alerts", "Brīdinājumi", "bell"],
  ["pickup", "Izņemšana", "pin"],
  ["profile", "Profils", "shield"],
];
type Tab = "overview" | "bids" | "orders" | "watch" | "alerts" | "pickup" | "profile";

/** Banner state after coming back from a provider's checkout page. */
type PayBanner = "confirming" | "success" | "failed" | "cancelled" | "unavailable" | "processing" | null;

export default function AccountPage() {
  const { t, lang } = useT();
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
  const [me, setMe] = useState<{ email: string; alias: string } | null>(null);

  const loadOrders = useCallback(() => {
    void publicApi.get<{ orders: MyOrder[] }>("/api/public/me/orders").then((r) => setOrders(r.orders)).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!publicApi.hasSession) {
      setSignedIn(false);
      return;
    }
    setSignedIn(true);
    void publicApi.get<{ bidder: { blocked: boolean } }>("/api/public/auth/me").then((r) => setSuspended(r.bidder.blocked)).catch(() => undefined);
    void publicApi.get<{ bids: MyBidAuction[] }>("/api/public/me/bids").then((r) => setBids(r.bids)).catch(() => undefined);
    loadOrders();
    void publicApi.get<{ bidder: { email: string; alias: string } }>("/api/public/auth/me")
      .then((r) => setMe(r.bidder)).catch(() => undefined);
  }, [loadOrders]);

  // Вэлмес и брīdinājumi живут локально — подтягиваем каталог, чтобы показать
  // сохранённые лоты теми же карточками, что и везде.
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
    if (q && TABS.some(([id]) => id === q)) setTab(q);
  }, []);

  const goTab = (id: Tab) => {
    setTab(id);
    const url = id === "overview" ? "/account" : `/account?tab=${id}`;
    window.history.replaceState(null, "", url);
  };

  // Back from the Klix checkout: ?paid=1|0|cancel&order=<ref>. On success we
  // poll the payment endpoint — it re-checks the provider, so the order flips
  // to paid even if the server-to-server callback was lost.
  useEffect(() => {
    if (signedIn !== true || typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const paid = params.get("paid");
    const ref = params.get("order");
    if (!paid || !ref) return;
    window.history.replaceState(null, "", window.location.pathname);
    if (paid === "0") {
      setPayBanner("failed");
      return;
    }
    if (paid === "cancel") {
      setPayBanner("cancelled");
      return;
    }
    setPayBanner("confirming");
    let attempts = 0;
    let stillInFlight = false;
    const poll = async () => {
      attempts += 1;
      try {
        const r = await publicApi.get<{ orderStatus: string; paymentStatus: string | null; provider: string | null }>(
          `/api/public/orders/${encodeURIComponent(ref)}/payment`,
        );
        if (r.orderStatus === "paid") {
          setPayBanner("success");
          loadOrders();
          return;
        }
        if (r.paymentStatus === "failed" || r.paymentStatus === "expired") {
          setPayBanner("failed");
          return;
        }
        stillInFlight = r.paymentStatus === "created";
      } catch {
        // transient — keep polling
      }
      if (attempts < 10) pollTimer.current = setTimeout(poll, 2000);
      // BNPL approvals (Inbank, Klix Pay Later) can take minutes — a payment
      // still in flight is "processing", not failed; the email confirms it.
      else setPayBanner(stillInFlight ? "processing" : "failed");
    };
    void poll();
    return () => {
      if (pollTimer.current) clearTimeout(pollTimer.current);
    };
  }, [signedIn, loadOrders]);


  if (signedIn === false) {
    return (
      <section className="wrap" style={{ paddingTop: 40, paddingBottom: 80 }}>
        <div className="empty">
          <span className="ic" aria-hidden="true"><Icon name="shield" /></span>
          <h3>{t("a.signinToBid")}</h3>
          <p>Pieteikšanās vajadzīga, lai redzētu savus solījumus un pasūtījumus.</p>
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

  const unpaid = orders.filter((o) => o.status === "awaiting_payment");
  const leading = bids.filter((b) => b.status === "live" && b.youLead).length;
  const outbid = bids.filter((b) => b.status === "live" && !b.youLead).length;
  const watched = catalog.filter((a) => watchIds.includes(a.id));
  const alerted = catalog.filter((a) => alertIds.includes(a.id));

  const counts: Record<Tab, number> = {
    overview: 0, bids: bids.length, orders: orders.length,
    watch: watchIds.length, alerts: alertIds.length,
    pickup: 0, profile: 0,
  };

  const bidRows = (rows: MyBidAuction[]) => (
    <ul className="feed">
      {rows.map((b) => (
        <li key={b.id}>
          <span className="nm"><Link href={`/auction/${b.id}`}>{b.title}</Link></span>
          {b.status === "live" ? (
            <>
              <span className={`tag${b.youLead ? "" : " tag-live"}`}>
                {b.youLead ? t("acc.leading") : t("acc.outbid")}
              </span>
              <span className="ago"><Countdown endsAt={b.endsAt} /></span>
            </>
          ) : (
            <span className="ago">{t("card.ended")}</span>
          )}
          <span className="am tnum">{formatEur(b.currentPriceCents ?? b.startPriceCents ?? 0)}</span>
        </li>
      ))}
    </ul>
  );

  const orderRows = (rows: MyOrder[]) => (
    <ul className="orders">
      {rows.map((o) => (
        <li key={o.ref}>
          <div className="o-top">
            <span className="o-ref tnum">{o.ref}</span>
            <span className="o-title">{o.itemTitle}</span>
            <span className={`tag${o.status === "awaiting_payment" ? " tag-live" : ""}`}>
              {o.status === "awaiting_payment" ? t("acc.awaiting") : t("acc.paid")}
            </span>
            <span className="am tnum">{formatEur(o.totalCents)}</span>
          </div>
          {o.status === "awaiting_payment" && (
            <div className="o-act">
              <Link className="btn btn-primary btn-sm" href={`/apmaksa/${encodeURIComponent(o.ref)}`}>
                {t("acc.pay")}
              </Link>
              {o.paymentDeadlineAt && (
                <span className="note">
                  Termiņš {new Date(o.paymentDeadlineAt).toLocaleDateString("lv-LV")}
                </span>
              )}
              <KlixPayLater amountCents={o.totalCents} view="checkout" micro />
            </div>
          )}
          {o.status === "paid" && o.fulfilment !== "pickup" && <TrackingLine order={o} />}
        </li>
      ))}
    </ul>
  );

  const empty = (icon: string, title: string, text: string, href: string, cta: string) => (
    <div className="empty">
      <span className="ic" aria-hidden="true"><Icon name={icon} /></span>
      <h3>{title}</h3>
      <p>{text}</p>
      <Link className="btn btn-primary" href={href}>{cta}</Link>
    </div>
  );

  return (
    <section className="wrap" style={{ paddingTop: 24 }}>
      <nav className="crumbs" aria-label="Navigācijas ceļš">
        <ol><li><Link href="/">Sākums</Link></li><li aria-current="page">{t("nav.account")}</li></ol>
      </nav>

      <div className="page-head">
        <div>
          <h1 data-hero>{t("nav.account")}</h1>
          <p className="cnt">{me ? me.alias : "—"}{me ? ` · ${me.email}` : ""}</p>
        </div>
        <button className="btn btn-outline btn-sm" type="button" onClick={() => publicApi.logout()}>
          {t("nav.signout")}
        </button>
      </div>

      {suspended && <p className="bb-status out">{t("acc.suspended")}</p>}
      {payBanner && <p className={`bb-status ${bannerTone(payBanner)}`}>{bannerText[payBanner]}</p>}
      <FeesNotice />

      <nav className="acct-nav" aria-label="Konta sadaļas">
        {TABS.map(([id, label, icon]) => (
          <button key={id} type="button" className={`acct-tab${tab === id ? " on" : ""}`}
                  aria-current={tab === id ? "page" : undefined} onClick={() => goTab(id)}>
            <Icon name={icon} size={18} />{label}
            {counts[id] > 0 && <span className="n">{counts[id]}</span>}
          </button>
        ))}
      </nav>

      {tab === "overview" && (
        <div className="acct">
          <div className="stats">
            <div className="stat"><span className="k">Aktīvi solījumi</span><b className="tnum">{bids.filter((b) => b.status === "live").length}</b></div>
            <div className="stat"><span className="k">Vadi</span><b className="tnum">{leading}</b></div>
            <div className="stat"><span className="k">Pārsolīts</span><b className="tnum">{outbid}</b></div>
            <div className="stat"><span className="k">Neapmaksāti</span><b className="tnum">{unpaid.length}</b></div>
          </div>

          {unpaid.length > 0 && (
            <section className="card-b">
              <h2>Gaida apmaksu</h2>
              {orderRows(unpaid)}
            </section>
          )}

          <section className="card-b">
            <h2>{t("acc.myBids")}</h2>
            {bids.length === 0
              ? empty("gavel", "Vēl neesi solījis", "Kad būsi solījis, šeit redzēsi aktīvos solījumus.", "/katalogs", "Atrast pirmo lotu")
              : bidRows(bids.slice(0, 5))}
            {bids.length > 5 && (
              <button className="link" type="button" onClick={() => goTab("bids")}>
                Visi solījumi <Icon name="arrow" size={16} />
              </button>
            )}
          </section>

          <PickupPass />
        </div>
      )}

      {tab === "bids" && (
        <div className="acct">
          <section className="card-b">
            <h2>{t("acc.myBids")}</h2>
            {bids.length === 0
              ? empty("gavel", "Vēl neesi solījis", "Solījumi parādīsies šeit uzreiz pēc pirmās likmes.", "/katalogs", "Atrast lotu")
              : bidRows(bids)}
          </section>
        </div>
      )}

      {tab === "orders" && (
        <div className="acct">
          <section className="card-b">
            <h2>{t("acc.myOrders")}</h2>
            {orders.length === 0
              ? empty("box", "Pasūtījumu vēl nav", "Uzvarētie loti un pirkumi parādīsies šeit.", "/katalogs", "Atvērt katalogu")
              : orderRows(orders)}
          </section>
        </div>
      )}

      {tab === "watch" && (
        <div className="acct">
          {watched.length === 0
            ? empty("heart", "Saraksts ir tukšs", "Nospied sirsniņu uz jebkura lota — tas parādīsies šeit.", "/katalogs", "Atrast lotus")
            : <div className="results">{watched.map((a) => <LotCard key={a.id} lot={a as CardLot} />)}</div>}
        </div>
      )}

      {tab === "alerts" && (
        <div className="acct">
          {alerted.length === 0
            ? empty("bell", "Brīdinājumu vēl nav", "Nospied zvaniņu uz lota — brīdināsim par līdzīgiem.", "/katalogs", "Atrast lotus")
            : <div className="results">{alerted.map((a) => <LotCard key={a.id} lot={a as CardLot} />)}</div>}
        </div>
      )}

      {tab === "pickup" && (
        <div className="acct">
          <PickupPass />
          <section className="card-b">
            <h2>Izņemšana Rīgā</h2>
            <p className="note">
              Apmaksātos lotus var izņemt klātienē darbdienās. Paņem līdzi izņemšanas kodu vai QR —
              tos rādām šeit, tiklīdz pasūtījums ir apmaksāts.
            </p>
            <Link className="btn btn-outline" href="/kontakti">Kontakti un darba laiks</Link>
          </section>
        </div>
      )}

      {tab === "profile" && (
        <div className="acct">
          <section className="card-b">
            <h2>Profils</h2>
            <div className="facts">
              <div><span>Segvārds</span><b>{me?.alias ?? "—"}</b></div>
              <div><span>E-pasts</span><b>{me?.email ?? "—"}</b></div>
              <div><span>Statuss</span><b>{suspended ? "Ierobežots" : "Aktīvs"}</b></div>
            </div>
            <p className="note" style={{ marginTop: 16 }}>
              Publiskajā solījumu plūsmā redzams tikai segvārds. Vārds, e-pasts un tālrunis citiem nav redzami.
            </p>
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 16 }}>
              <Link className="btn btn-outline" href="/forgot-password">Mainīt paroli</Link>
              <Link className="btn btn-outline" href="/kontakti">Dzēst kontu</Link>
            </div>
          </section>
        </div>
      )}
    </section>
  );
}
