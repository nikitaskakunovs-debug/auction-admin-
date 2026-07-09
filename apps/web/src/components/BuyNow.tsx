"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { publicApi, PublicApiError } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { formatEur, type FixedListing } from "@/lib/types";

export function BuyNow({ listing }: { listing: FixedListing }) {
  const { t } = useT();
  const router = useRouter();
  const [signedIn, setSignedIn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [soldOut, setSoldOut] = useState(!!listing.soldOut);

  useEffect(() => {
    setSignedIn(publicApi.hasSession);
    const fn = () => setSignedIn(publicApi.hasSession);
    publicApi.listeners.add(fn);
    return () => {
      publicApi.listeners.delete(fn);
    };
  }, []);

  const buy = async () => {
    setBusy(true);
    setError(null);
    try {
      await publicApi.post(`/api/public/listings/${listing.id}/buy`);
      router.push("/account");
    } catch (err) {
      if (err instanceof PublicApiError && err.body.code === "NOT_AVAILABLE") {
        setSoldOut(true);
        setError(t("buy.soldOut"));
      } else if (err instanceof PublicApiError && err.body.code === "BIDDER_BLOCKED") {
        setError(t("buy.blocked"));
      } else {
        setError(err instanceof Error ? err.message : "error");
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: "grid", gap: 20 }}>
      <div>
        <span style={{ fontSize: 12, fontWeight: 700, color: "#2D4BFF", textTransform: "uppercase", letterSpacing: "0.05em" }}>{t("buy.badge")}</span>
        <h1 style={{ margin: "6px 0 0", fontSize: 26, fontWeight: 700, letterSpacing: "-0.02em" }}>{listing.title}</h1>
        <div style={{ fontSize: 12, color: "#6B6B68", marginTop: 4 }}>{listing.sku} · {listing.condition} · {listing.marketCode}</div>
        {listing.description && <p style={{ color: "#454542", fontSize: 14, lineHeight: 1.6, maxWidth: 720 }}>{listing.description}</p>}
      </div>

      <div style={{ maxWidth: 420, background: "#fff", border: "1px solid rgba(10,10,10,0.10)", borderRadius: 16, padding: 22 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: "#6B6B68", textTransform: "uppercase", letterSpacing: "0.06em" }}>{t("buy.price")}</div>
        <div style={{ fontSize: 34, fontWeight: 700, letterSpacing: "-0.02em" }}>{formatEur(listing.priceCents)}</div>
        <div style={{ fontSize: 11.5, color: "#6B6B68", marginBottom: 16 }}>{t("buy.vatNote")}</div>

        {soldOut ? (
          <div style={{ fontWeight: 700, color: "#B0282C", background: "#FBE3E3", borderRadius: 10, padding: "12px 14px", textAlign: "center" }}>{t("buy.soldOut")}</div>
        ) : signedIn ? (
          <button
            onClick={() => void buy()}
            disabled={busy}
            style={{ all: "unset", cursor: busy ? "wait" : "pointer", display: "block", textAlign: "center", background: "#2D4BFF", color: "#fff", fontWeight: 700, fontSize: 15, borderRadius: 10, padding: "14px 0", opacity: busy ? 0.6 : 1 }}
          >{t("buy.now")}</button>
        ) : (
          <a href="/login" style={{ display: "block", textAlign: "center", background: "#0A0A0A", color: "#fff", fontWeight: 700, fontSize: 14, borderRadius: 10, padding: "13px 0", textDecoration: "none" }}>{t("buy.signin")}</a>
        )}
        {error && <div style={{ marginTop: 10, fontSize: 12.5, fontWeight: 700, color: "#B0282C", background: "#FBE3E3", borderRadius: 8, padding: "8px 10px" }}>{error}</div>}
      </div>
    </div>
  );
}
