"use client";

import Link from "next/link";
import { conditionLabel } from "@/lib/conditions";
import { useT } from "@/lib/i18n";
import { photoThumb } from "@/lib/photos";
import { formatEur, type PublicAuction } from "@/lib/types";
import { Countdown } from "./Countdown";

/** Карточка лота витрины. Данные — как отдаёт /api/public/auctions:
 *  currentPriceCents может быть null до первой ставки, тогда показываем
 *  стартовую цену. Резерв виден только как факт (hasReserve/reserveMet),
 *  суммы резерва API не отдаёт и отдавать не должен. */
export function AuctionCard({ auction }: { auction: PublicAuction }) {
  const { t } = useT();
  const live = auction.status === "live";
  const ended = auction.status.startsWith("ended");
  const cover = auction.photos[0];
  const price = auction.currentPriceCents ?? auction.startPriceCents ?? 0;

  return (
    <Link className="lot" href={`/auction/${auction.id}`}>
      <div className="lot-art">
        {cover ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={photoThumb(cover)} alt="" loading="lazy" />
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
          {live && <span className="tag tag-live"><i aria-hidden="true" />LIVE</span>}
          {!live && !ended && (
            <span className="tag">
              {t("card.startsAt")} {new Date(auction.startsAt).toLocaleDateString("lv-LV")}
            </span>
          )}
          {auction.hasReserve && !auction.reserveMet && (
            <span className="tag">{t("a.reserveNotMet")}</span>
          )}
        </div>
      </div>

      <div className="lot-body">
        <p className="lot-top">
          <span>{auction.sku}</span>
          {live && <Countdown endsAt={auction.endsAt} />}
        </p>
        <h3>{auction.title}</h3>
        <span className="cond">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 3l7 3v6c0 4.4-3 7.7-7 9-4-1.3-7-4.6-7-9V6z" />
          </svg>
          {conditionLabel(auction.condition, t)}
        </span>

        <div className="price-row">
          <div>
            <p className="price-lab">
              {auction.currentPriceCents !== null ? t("card.currentBid") : t("card.startPrice")}
              {auction.bidCount > 0 && <> · {auction.bidCount} {t("card.bids")}</>}
            </p>
            <p className="price tnum">{formatEur(price)}</p>
          </div>
        </div>
      </div>
    </Link>
  );
}
