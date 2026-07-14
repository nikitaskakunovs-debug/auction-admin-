"use client";

import Link from "next/link";
import { conditionLabel } from "@/lib/conditions";
import { useT } from "@/lib/i18n";
import { photoThumb } from "@/lib/photos";
import { formatEur, type FixedListing, type PublicAuction } from "@/lib/types";
import { AuctionCard } from "./AuctionCard";

const grid: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill, minmax(250px, 1fr))",
  gap: 14,
};

function FixedCard({ listing }: { listing: FixedListing }) {
  const { t } = useT();
  return (
    <Link
      href={`/listing/${listing.id}`}
      style={{
        display: "block", textDecoration: "none", color: "#0A0A0A", background: "#fff",
        border: "1px solid rgba(10,10,10,0.10)", borderRadius: 14, padding: 18,
      }}
    >
      {listing.photos[0] && (
        <div style={{ margin: "-18px -18px 12px", background: "#F2F1EE", borderRadius: "13px 13px 0 0", overflow: "hidden" }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={photoThumb(listing.photos[0])} alt="" style={{ width: "100%", height: 150, objectFit: "cover", display: "block" }} />
        </div>
      )}
      <span style={{ fontSize: 11, fontWeight: 700, color: "#2D4BFF", textTransform: "uppercase" }}>{t("home.buyNow")}</span>
      <h3 style={{ margin: "8px 0 0", fontSize: 15.5, fontWeight: 700, lineHeight: 1.35, minHeight: 42 }}>{listing.title}</h3>
      <div style={{ fontSize: 11.5, color: "#6B6B68", margin: "4px 0 12px" }}>{listing.sku} · {conditionLabel(listing.condition, t)}</div>
      <div style={{ fontSize: 10.5, fontWeight: 700, color: "#6B6B68", textTransform: "uppercase", letterSpacing: "0.05em" }}>{t("buy.price")}</div>
      <div style={{ fontSize: 21, fontWeight: 700, letterSpacing: "-0.02em" }}>{formatEur(listing.priceCents)}</div>
    </Link>
  );
}

export function HomeSections({ auctions, listings }: { auctions: PublicAuction[]; listings: FixedListing[] }) {
  const { t } = useT();
  const live = auctions.filter((a) => a.status === "live");
  const upcoming = auctions.filter((a) => a.status === "scheduled");

  return (
    <div style={{ display: "grid", gap: 30 }}>
      <section>
        <h1 style={{ fontSize: 22, fontWeight: 700, margin: "0 0 14px", letterSpacing: "-0.02em" }}>{t("home.live")}</h1>
        {live.length === 0 ? (
          <p style={{ color: "#6B6B68", fontSize: 14 }}>{t("home.empty")}</p>
        ) : (
          <div style={grid}>{live.map((a) => <AuctionCard key={a.id} auction={a} />)}</div>
        )}
      </section>
      {upcoming.length > 0 && (
        <section>
          <h2 style={{ fontSize: 18, fontWeight: 700, margin: "0 0 14px", letterSpacing: "-0.02em" }}>{t("home.upcoming")}</h2>
          <div style={grid}>{upcoming.map((a) => <AuctionCard key={a.id} auction={a} />)}</div>
        </section>
      )}
      {listings.length > 0 && (
        <section>
          <h2 style={{ fontSize: 18, fontWeight: 700, margin: "0 0 14px", letterSpacing: "-0.02em" }}>{t("home.buyNow")}</h2>
          <div style={grid}>{listings.map((l) => <FixedCard key={l.id} listing={l} />)}</div>
        </section>
      )}
    </div>
  );
}
