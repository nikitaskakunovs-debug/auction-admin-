"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { publicApi, PublicApiError } from "@/lib/api";
import { loadPaymentsConfig, type PaymentsConfig } from "@/components/KlixPayLater";
import { useT } from "@/lib/i18n";
import { formatEur, type MyOrder, type PublicAuction } from "@/lib/types";
import { Countdown } from "@/components/Countdown";
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
  const [payingRef, setPayingRef] = useState<string | null>(null);
  const [payConfig, setPayConfig] = useState<PaymentsConfig | null>(null);
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
    void loadPaymentsConfig().then(setPayConfig);
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

  async function payOrder(ref: string, provider?: "klix" | "inbank") {
    setPayingRef(ref);
    try {
      const r = await publicApi.post<{ checkoutUrl: string }>(`/api/public/orders/${encodeURIComponent(ref)}/pay`, {
        language: lang,
        ...(provider ? { provider } : {}),
      });
      window.location.assign(r.checkoutUrl);
    } catch (err) {
      setPayingRef(null);
      setPayBanner(err instanceof PublicApiError && err.status === 503 ? "unavailable" : "failed");
    }
  }

  if (signedIn === false) {
    return (
      <p style={{ fontSize: 14 }}>
        <Link href="/login" style={{ color: "#2D4BFF", fontWeight: 700 }}>{t("a.signinToBid")}</Link>
      </p>
    );
  }

  const card: React.CSSProperties = { background: "#fff", border: "1px solid rgba(10,10,10,0.10)", borderRadius: 14, overflow: "hidden" };
  const row: React.CSSProperties = { display: "flex", alignItems: "center", gap: 12, padding: "12px 16px", borderBottom: "1px solid rgba(10,10,10,0.05)", fontSize: 13.5, textDecoration: "none", color: "#0A0A0A" };

  const bannerStyle = (kind: PayBanner): React.CSSProperties => {
    const blue = kind === "confirming" || kind === "processing";
    return {
      borderRadius: 14,
      padding: "14px 18px",
      fontSize: 14,
      fontWeight: 700,
      background: kind === "success" ? "#E4F4EA" : blue ? "#EAF0FE" : "#FCEFD9",
      border: `1px solid ${kind === "success" ? "#B5DFC4" : blue ? "#C4D3F9" : "#EBD5AB"}`,
      color: kind === "success" ? "#1F8A4C" : blue ? "#2D4BFF" : "#9A5B00",
    };
  };
  const bannerText: Record<Exclude<PayBanner, null>, string> = {
    confirming: t("acc.payConfirming"),
    success: t("acc.paySuccess"),
    failed: t("acc.payFailed"),
    cancelled: t("acc.payCancelled"),
    unavailable: t("acc.payUnavailable"),
    processing: t("acc.payProcessing"),
  };

  return (
    <div style={{ display: "grid", gap: 26 }}>
      {suspended && (
        <div style={{ background: "#FBE3E3", border: "1px solid #E8B4B4", borderRadius: 14, padding: "14px 18px", fontSize: 14, fontWeight: 700, color: "#8F1D21" }}>
          {t("acc.suspended")}
        </div>
      )}
      {payBanner && <div style={bannerStyle(payBanner)}>{bannerText[payBanner]}</div>}
      <FeesNotice />
      <PickupPass />
      <section>
        <h1 style={{ fontSize: 20, fontWeight: 700, margin: "0 0 12px", letterSpacing: "-0.02em" }}>{t("acc.myBids")}</h1>
        <div style={card}>
          {bids.length === 0 ? (
            <div style={{ padding: 22, color: "#6B6B68", fontSize: 13 }}>{t("acc.empty")}</div>
          ) : (
            bids.map((b) => (
              <Link key={b.id} href={`/auction/${b.id}`} style={row}>
                <span style={{ fontWeight: 600, flex: 1 }}>{b.title}</span>
                {b.status === "live" ? (
                  <>
                    <span style={{
                      fontSize: 11, fontWeight: 700, borderRadius: 99, padding: "2px 9px",
                      background: b.youLead ? "#E4F4EA" : "#FBE3E3", color: b.youLead ? "#1F8A4C" : "#B0282C",
                    }}>{b.youLead ? t("acc.leading") : t("acc.outbid")}</span>
                    <Countdown endsAt={b.endsAt} />
                  </>
                ) : (
                  <span style={{ fontSize: 11.5, color: "#6B6B68" }}>{t("card.ended")}</span>
                )}
                <span style={{ fontFamily: '"Geist Mono", ui-monospace, monospace', fontWeight: 700 }}>
                  {formatEur(b.currentPriceCents ?? b.startPriceCents ?? 0)}
                </span>
              </Link>
            ))
          )}
        </div>
      </section>

      <section>
        <h2 style={{ fontSize: 17, fontWeight: 700, margin: "0 0 12px", letterSpacing: "-0.02em" }}>{t("acc.myOrders")}</h2>
        <div style={card}>
          {orders.length === 0 ? (
            <div style={{ padding: 22, color: "#6B6B68", fontSize: 13 }}>{t("acc.empty")}</div>
          ) : (
            orders.map((o) => (
              <div key={o.ref} style={{ borderBottom: "1px solid rgba(10,10,10,0.05)" }}>
                <div style={{ ...row, borderBottom: "none" }}>
                  <span style={{ fontFamily: '"Geist Mono", ui-monospace, monospace', fontSize: 12 }}>{o.ref}</span>
                  <span style={{ fontWeight: 600, flex: 1 }}>{o.itemTitle}</span>
                  <span style={{
                    fontSize: 11, fontWeight: 700, borderRadius: 99, padding: "2px 9px",
                    background: o.status === "awaiting_payment" ? "#FCEFD9" : "#E4F4EA",
                    color: o.status === "awaiting_payment" ? "#9A5B00" : "#1F8A4C",
                  }}>
                    {o.status === "awaiting_payment" ? t("acc.awaiting") : t("acc.paid")}
                  </span>
                  <span style={{ fontFamily: '"Geist Mono", ui-monospace, monospace', fontWeight: 700 }}>{formatEur(o.totalCents)}</span>
                  {o.status === "awaiting_payment" && (
                    <span style={{ display: "flex", gap: 6 }}>
                      {payConfig?.providers?.klix !== false && (
                        <button
                          onClick={() => void payOrder(o.ref, payConfig?.providers?.klix ? "klix" : undefined)}
                          disabled={payingRef !== null}
                          style={{
                            border: "none", borderRadius: 99, padding: "6px 14px", fontSize: 12, fontWeight: 700,
                            background: "#2D4BFF", color: "#fff", cursor: payingRef ? "wait" : "pointer",
                            opacity: payingRef && payingRef !== o.ref ? 0.5 : 1,
                          }}
                        >
                          {payingRef === o.ref ? t("acc.payRedirecting") : t("acc.pay")}
                        </button>
                      )}
                      {payConfig?.providers?.inbank && (
                        <button
                          onClick={() => void payOrder(o.ref, "inbank")}
                          disabled={payingRef !== null}
                          style={{
                            borderRadius: 99, padding: "6px 14px", fontSize: 12, fontWeight: 700,
                            background: "#fff", color: "#2D4BFF", border: "1.5px solid #2D4BFF",
                            cursor: payingRef ? "wait" : "pointer",
                            opacity: payingRef && payingRef !== o.ref ? 0.5 : 1,
                          }}
                        >
                          {t("acc.payInbank")}
                        </button>
                      )}
                    </span>
                  )}
                </div>
                {o.status === "awaiting_payment" && (
                  <div style={{ padding: "0 16px 10px" }}>
                    {/* Pay Later monthly-payment preview on the exact amount due. */}
                    <KlixPayLater amountCents={o.totalCents} view="checkout" micro />
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      </section>
    </div>
  );
}
