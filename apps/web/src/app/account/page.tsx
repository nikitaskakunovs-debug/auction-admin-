"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { publicApi, PublicApiError } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { formatEur, type MyOrder, type PublicAuction } from "@/lib/types";
import { Countdown } from "@/components/Countdown";
import { TrackingLine } from "@/components/DeliveryPicker";
import { FeesNotice } from "@/components/FeesNotice";
import { KlixPayLater } from "@/components/KlixPayLater";
import { PickupPass } from "@/components/PickupPass";

type MyBidAuction = PublicAuction & { youLead: boolean };

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
  }, [loadOrders]);

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
      <p style={{ fontSize: 14 }}>
        <Link href="/login" style={{ color: "#2D4BFF", fontWeight: 700 }}>{t("a.signinToBid")}</Link>
      </p>
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
    kind === "success" ? "ok" : kind === "confirming" || kind === "processing" ? "info" : "warn";

  return (
    <section className="wrap" style={{ paddingTop: 24 }}>
      <nav className="crumbs" aria-label="Navigācijas ceļš">
        <ol><li><Link href="/">Sākums</Link></li><li aria-current="page">{t("nav.account")}</li></ol>
      </nav>

      <div className="page-head">
        <div>
          <h1 data-hero>{t("nav.account")}</h1>
          <p className="cnt">{t("acc.myBids")} · {t("acc.myOrders")}</p>
        </div>
        <button className="btn btn-outline btn-sm" type="button" onClick={() => publicApi.logout()}>
          {t("nav.signout")}
        </button>
      </div>

      {suspended && <p className="bb-status err">{t("acc.suspended")}</p>}
      {payBanner && <p className={`bb-status ${bannerTone(payBanner)}`}>{bannerText[payBanner]}</p>}
      <FeesNotice />
      <PickupPass />

      <div className="acct">
        <section className="card-b">
          <h2>{t("acc.myBids")}</h2>
          {bids.length === 0 ? (
            <p className="note">{t("acc.empty")}</p>
          ) : (
            <ul className="feed">
              {bids.map((b) => (
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
          )}
        </section>

        <section className="card-b">
          <h2>{t("acc.myOrders")}</h2>
          {orders.length === 0 ? (
            <p className="note">{t("acc.empty")}</p>
          ) : (
            <ul className="orders">
              {orders.map((o) => (
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
                      <KlixPayLater amountCents={o.totalCents} view="checkout" micro />
                    </div>
                  )}
                  {o.status === "paid" && o.fulfilment !== "pickup" && <TrackingLine order={o} />}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </section>
  );
}
