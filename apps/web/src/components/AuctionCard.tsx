"use client";

import Link from "next/link";
import { conditionLabel } from "@/lib/conditions";
import { useT } from "@/lib/i18n";
import { photoThumb } from "@/lib/photos";
import { formatEur, type PublicAuction } from "@/lib/types";
import { Countdown } from "./Countdown";

export function AuctionCard({ auction }: { auction: PublicAuction }) {
  const { t } = useT();
  const live = auction.status === "live";
  return (
    <Link
      href={`/auction/${auction.id}`}
      style={{
        display: "block", textDecoration: "none", color: "#0A0A0A",
        background: "#fff", border: "1px solid rgba(10,10,10,0.10)", borderRadius: 14,
        padding: 18, transition: "box-shadow 120ms",
      }}
    >
      {auction.photos[0] && (
        <div style={{ margin: "-18px -18px 12px", background: "#F2F1EE", borderRadius: "13px 13px 0 0", overflow: "hidden" }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={photoThumb(auction.photos[0])} alt="" style={{ width: "100%", height: 150, objectFit: "cover", display: "block" }} />
        </div>
      )}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        {live ? (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11, fontWeight: 700, color: "#1F8A4C" }}>
            <span style={{ width: 7, height: 7, borderRadius: 99, background: "#1F8A4C" }} /> LIVE
          </span>
        ) : (
          <span style={{ fontSize: 11, fontWeight: 700, color: "#6B6B68", textTransform: "uppercase" }}>{t("card.startsAt")} {new Date(auction.startsAt).toLocaleDateString("lv-LV")}</span>
        )}
        {auction.hasReserve && !auction.reserveMet && (
          <span style={{ marginLeft: "auto", fontSize: 10.5, fontWeight: 700, color: "#C2410C", background: "#FCEFD9", borderRadius: 99, padding: "2px 8px" }}>
            {t("a.reserveNotMet")}
          </span>
        )}
      </div>
      <h3 style={{ margin: 0, fontSize: 15.5, fontWeight: 700, lineHeight: 1.35, minHeight: 42 }}>{auction.title}</h3>
      <div style={{ fontSize: 11.5, color: "#6B6B68", margin: "4px 0 12px" }}>{auction.sku} · {conditionLabel(auction.condition, t)}</div>
      <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between" }}>
        <div>
          <div style={{ fontSize: 10.5, fontWeight: 700, color: "#6B6B68", textTransform: "uppercase", letterSpacing: "0.05em" }}>
            {auction.currentPriceCents !== null ? t("card.currentBid") : t("card.startPrice")}
          </div>
          <div style={{ fontSize: 21, fontWeight: 700, letterSpacing: "-0.02em" }}>
            {formatEur(auction.currentPriceCents ?? auction.startPriceCents ?? 0)}
          </div>
          <div style={{ fontSize: 11.5, color: "#6B6B68" }}>{auction.bidCount} {t("card.bids")}</div>
        </div>
        {live && (
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: 10.5, fontWeight: 700, color: "#6B6B68", textTransform: "uppercase", letterSpacing: "0.05em" }}>{t("card.endsIn")}</div>
            <div style={{ fontSize: 15 }}><Countdown endsAt={auction.endsAt} /></div>
          </div>
        )}
      </div>
    </Link>
  );
}
