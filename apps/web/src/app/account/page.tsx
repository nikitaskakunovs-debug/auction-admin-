"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { publicApi } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { formatEur, type MyOrder, type PublicAuction } from "@/lib/types";
import { Countdown } from "@/components/Countdown";
import { FeesNotice } from "@/components/FeesNotice";
import { PickupPass } from "@/components/PickupPass";

type MyBidAuction = PublicAuction & { youLead: boolean };

export default function AccountPage() {
  const { t } = useT();
  const [bids, setBids] = useState<MyBidAuction[]>([]);
  const [orders, setOrders] = useState<MyOrder[]>([]);
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [suspended, setSuspended] = useState(false);

  useEffect(() => {
    if (!publicApi.hasSession) {
      setSignedIn(false);
      return;
    }
    setSignedIn(true);
    void publicApi.get<{ bidder: { blocked: boolean } }>("/api/public/auth/me").then((r) => setSuspended(r.bidder.blocked)).catch(() => undefined);
    void publicApi.get<{ bids: MyBidAuction[] }>("/api/public/me/bids").then((r) => setBids(r.bids)).catch(() => undefined);
    void publicApi.get<{ orders: MyOrder[] }>("/api/public/me/orders").then((r) => setOrders(r.orders)).catch(() => undefined);
  }, []);

  if (signedIn === false) {
    return (
      <p style={{ fontSize: 14 }}>
        <Link href="/login" style={{ color: "#2D4BFF", fontWeight: 700 }}>{t("a.signinToBid")}</Link>
      </p>
    );
  }

  const card: React.CSSProperties = { background: "#fff", border: "1px solid rgba(10,10,10,0.10)", borderRadius: 14, overflow: "hidden" };
  const row: React.CSSProperties = { display: "flex", alignItems: "center", gap: 12, padding: "12px 16px", borderBottom: "1px solid rgba(10,10,10,0.05)", fontSize: 13.5, textDecoration: "none", color: "#0A0A0A" };

  return (
    <div style={{ display: "grid", gap: 26 }}>
      {suspended && (
        <div style={{ background: "#FBE3E3", border: "1px solid #E8B4B4", borderRadius: 14, padding: "14px 18px", fontSize: 14, fontWeight: 700, color: "#8F1D21" }}>
          {t("acc.suspended")}
        </div>
      )}
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
              <div key={o.ref} style={row}>
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
              </div>
            ))
          )}
        </div>
      </section>
    </div>
  );
}
