"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { publicApi } from "@/lib/api";
import { CATEGORY_CODES } from "@/lib/categories";
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

const PAGE = 48; // must match the API's default page size

export function HomeSections({ auctions: initialAuctions, listings: initialListings }: { auctions: PublicAuction[]; listings: FixedListing[] }) {
  const { t } = useT();
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("");
  const [auctions, setAuctions] = useState(initialAuctions);
  const [listings, setListings] = useState(initialListings);
  const [hasMoreA, setHasMoreA] = useState(initialAuctions.length >= PAGE);
  const [hasMoreL, setHasMoreL] = useState(initialListings.length >= PAGE);
  const [busy, setBusy] = useState(false);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const first = useRef(true);

  const params = (offset: number) => {
    const p = new URLSearchParams();
    if (query.trim().length >= 2) p.set("q", query.trim());
    if (category) p.set("category", category);
    if (offset > 0) p.set("offset", String(offset));
    const s = p.toString();
    return s ? `?${s}` : "";
  };

  const refetch = async (append: boolean) => {
    setBusy(true);
    try {
      const [a, l] = await Promise.all([
        publicApi.get<{ auctions: PublicAuction[]; hasMore: boolean }>(`/api/public/auctions${params(append ? auctions.length : 0)}`),
        publicApi.get<{ listings: FixedListing[]; hasMore: boolean }>(`/api/public/listings${params(append ? listings.length : 0)}`),
      ]);
      setAuctions(append ? [...auctions, ...a.auctions] : a.auctions);
      setListings(append ? [...listings, ...l.listings] : l.listings);
      setHasMoreA(a.hasMore);
      setHasMoreL(l.hasMore);
    } catch {
      // keep what we have — the SSR payload is always a valid fallback
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (first.current) {
      first.current = false; // the SSR payload IS the unfiltered first page
      return;
    }
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => void refetch(false), 300);
    return () => { if (debounce.current) clearTimeout(debounce.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, category]);

  const live = auctions.filter((a) => a.status === "live");
  const upcoming = auctions.filter((a) => a.status === "scheduled");
  const filtering = query.trim().length >= 2 || category !== "";
  const empty = auctions.length === 0 && listings.length === 0;

  const chip = (active: boolean): React.CSSProperties => ({
    all: "unset", cursor: "pointer", padding: "7px 13px", borderRadius: 99, fontSize: 12.5, fontWeight: 700,
    whiteSpace: "nowrap",
    background: active ? "#0A0A0A" : "#fff", color: active ? "#fff" : "#454542",
    border: active ? "1px solid #0A0A0A" : "1px solid rgba(10,10,10,0.14)",
  });

  const moreBtn = (onClick: () => void) => (
    <div style={{ display: "flex", justifyContent: "center", marginTop: 14 }}>
      <button onClick={onClick} disabled={busy} style={{
        all: "unset", cursor: busy ? "wait" : "pointer", padding: "11px 26px", borderRadius: 10,
        border: "1.5px solid rgba(10,10,10,0.18)", fontSize: 13.5, fontWeight: 700, background: "#fff", opacity: busy ? 0.6 : 1,
      }}>{t("catalog.loadMore")}</button>
    </div>
  );

  return (
    <div style={{ display: "grid", gap: 26 }}>
      <div style={{ display: "grid", gap: 10 }}>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("catalog.search")}
          style={{
            boxSizing: "border-box", width: "100%", maxWidth: 480, height: 44, borderRadius: 12,
            border: "1.5px solid rgba(10,10,10,0.14)", padding: "0 16px", fontSize: 14.5, outline: "none", background: "#fff",
          }}
        />
        <div style={{ display: "flex", gap: 7, flexWrap: "wrap" }}>
          <button style={chip(category === "")} onClick={() => setCategory("")}>{t("catalog.all")}</button>
          {CATEGORY_CODES.map((c) => (
            <button key={c} style={chip(category === c)} onClick={() => setCategory(category === c ? "" : c)}>{t(`cat.${c}`)}</button>
          ))}
        </div>
      </div>

      {empty && filtering && <p style={{ color: "#6B6B68", fontSize: 14 }}>{t("catalog.noResults")}</p>}

      <section>
        <h1 style={{ fontSize: 22, fontWeight: 700, margin: "0 0 14px", letterSpacing: "-0.02em" }}>{t("home.live")}</h1>
        {live.length === 0 ? (
          <p style={{ color: "#6B6B68", fontSize: 14 }}>{filtering ? t("catalog.noResults") : t("home.empty")}</p>
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
      {hasMoreA && moreBtn(() => void refetch(true))}
      {listings.length > 0 && (
        <section>
          <h2 style={{ fontSize: 18, fontWeight: 700, margin: "0 0 14px", letterSpacing: "-0.02em" }}>{t("home.buyNow")}</h2>
          <div style={grid}>{listings.map((l) => <FixedCard key={l.id} listing={l} />)}</div>
          {hasMoreL && moreBtn(() => void refetch(true))}
        </section>
      )}
    </div>
  );
}
