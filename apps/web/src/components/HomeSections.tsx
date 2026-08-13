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

/** Карточка лота с фиксированной ценой. Комиссии покупателя здесь нет —
 *  движок начисляет её только на аукционные лоты. */
function FixedCard({ listing }: { listing: FixedListing }) {
  const { t } = useT();
  return (
    <Link className="lot" href={`/listing/${listing.id}`}>
      <div className="lot-art">
        {listing.photos[0] ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={photoThumb(listing.photos[0])} alt="" loading="lazy" />
        ) : (
          <span className="ph" aria-hidden="true">
            <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="5" width="18" height="14" rx="2" />
              <circle cx="9" cy="10" r="1.6" />
              <path d="M21 16l-5-5-7 7" />
            </svg>
          </span>
        )}
        <div className="lot-tags">
          <span className="tag tag-accent">{t("home.buyNow")}</span>
        </div>
      </div>
      <div className="lot-body">
        <p className="lot-top"><span>{listing.sku}</span></p>
        <h3>{listing.title}</h3>
        <span className="cond">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 3l7 3v6c0 4.4-3 7.7-7 9-4-1.3-7-4.6-7-9V6z" />
          </svg>
          {conditionLabel(listing.condition, t)}
        </span>
        <div className="price-row">
          <div>
            <p className="price-lab">{t("buy.price")}</p>
            <p className="price tnum">{formatEur(listing.priceCents)}</p>
          </div>
        </div>
      </div>
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

  const moreBtn = (onClick: () => void) => (
    <div style={{ display: "flex", justifyContent: "center", marginTop: 24 }}>
      <button className="btn btn-outline btn-lg" onClick={onClick} disabled={busy}>
        {t("catalog.loadMore")}
      </button>
    </div>
  );

  return (
    <>
      {/* ГЕРОЙ: заголовок и поиск, ничего лишнего */}
      <section className="hero">
        <h1>
          Sāc ar €1.<br />
          <span className="hero-hl">Beidz ar to, ko meklē.</span>
        </h1>
        <form className="hero-search" role="search" onSubmit={(e) => e.preventDefault()}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               strokeWidth="1.9" strokeLinecap="round" aria-hidden="true">
            <circle cx="11" cy="11" r="7" /><path d="M20 20l-3.6-3.6" />
          </svg>
          <label className="sr" htmlFor="home-q">{t("catalog.search")}</label>
          <input
            id="home-q"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("catalog.search")}
          />
        </form>

        <div className="chips" role="group" aria-label={t("catalog.all")}>
          <button
            className={`chip${category === "" ? " on" : ""}`}
            aria-pressed={category === ""}
            onClick={() => setCategory("")}
          >{t("catalog.all")}</button>
          {CATEGORY_CODES.map((c) => (
            <button
              key={c}
              className={`chip${category === c ? " on" : ""}`}
              aria-pressed={category === c}
              onClick={() => setCategory(category === c ? "" : c)}
            >{t(`cat.${c}`)}</button>
          ))}
        </div>
      </section>

      {empty && filtering && (
        <div className="empty">
          <h3>{t("catalog.noResults")}</h3>
          <button className="btn btn-primary" onClick={() => { setQuery(""); setCategory(""); }}>
            {t("catalog.all")}
          </button>
        </div>
      )}

      <section className="section" style={{ paddingTop: 0 }} aria-live="polite">
        <div className="sec-head">
          <h2>{t("home.live")}</h2>
          {live.length > 0 && <span className="note">{live.length}</span>}
        </div>
        {live.length === 0 ? (
          <div className="empty">
            <p>{filtering ? t("catalog.noResults") : t("home.empty")}</p>
          </div>
        ) : (
          <div className="grid-lots">{live.map((a) => <AuctionCard key={a.id} auction={a} />)}</div>
        )}
      </section>

      {upcoming.length > 0 && (
        <section className="section" style={{ paddingTop: 0 }}>
          <div className="sec-head"><h2>{t("home.upcoming")}</h2></div>
          <div className="grid-lots">{upcoming.map((a) => <AuctionCard key={a.id} auction={a} />)}</div>
        </section>
      )}

      {hasMoreA && moreBtn(() => void refetch(true))}

      {listings.length > 0 && (
        <section className="section" style={{ paddingTop: 0 }}>
          <div className="sec-head"><h2>{t("home.buyNow")}</h2></div>
          <div className="grid-lots">{listings.map((l) => <FixedCard key={l.id} listing={l} />)}</div>
          {hasMoreL && moreBtn(() => void refetch(true))}
        </section>
      )}
    </>
  );
}
