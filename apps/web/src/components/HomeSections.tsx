"use client";

import { useT } from "@/lib/i18n";
import type { PublicAuction } from "@/lib/types";
import { AuctionCard } from "./AuctionCard";

export function HomeSections({ auctions }: { auctions: PublicAuction[] }) {
  const { t } = useT();
  const live = auctions.filter((a) => a.status === "live");
  const upcoming = auctions.filter((a) => a.status === "scheduled");

  const grid: React.CSSProperties = {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(250px, 1fr))",
    gap: 14,
  };

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
    </div>
  );
}
