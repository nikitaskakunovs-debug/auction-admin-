"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { conditionLabel } from "@/lib/conditions";
import { useT } from "@/lib/i18n";
import { photoThumb } from "@/lib/photos";
import { formatEur, type PublicAuction } from "@/lib/types";
import { Countdown } from "./Countdown";
import { watchStore } from "@/lib/watch";

/** Карточка лота. Фото листаются прямо здесь — мышью по наведению,
 *  пальцем свайпом, точками и стрелками клавиатуры. Карточка при этом
 *  не открывается: у кнопок stopPropagation. */
export function AuctionCard({ auction }: { auction: PublicAuction }) {
  const { t } = useT();
  const [frame, setFrame] = useState(0);
  const [watched, setWatched] = useState(false);
  const [shared, setShared] = useState(false);

  useEffect(() => {
    setWatched(watchStore.has(auction.id));
    return watchStore.subscribe(() => setWatched(watchStore.has(auction.id)));
  }, [auction.id]);

  const live = auction.status === "live";
  const ended = auction.status.startsWith("ended");
  const photos = auction.photos.length ? auction.photos : [null];
  const price = auction.currentPriceCents ?? auction.startPriceCents ?? 0;

  const stop = (e: React.MouseEvent) => { e.preventDefault(); e.stopPropagation(); };

  const scrub = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType !== "mouse" || photos.length < 2) return;
    const r = e.currentTarget.getBoundingClientRect();
    const i = Math.floor(((e.clientX - r.left) / r.width) * photos.length);
    setFrame(Math.max(0, Math.min(photos.length - 1, i)));
  };

  const share = async (e: React.MouseEvent) => {
    stop(e);
    const url = `${location.origin}/auction/${auction.id}`;
    try {
      if (navigator.share) await navigator.share({ title: auction.title, url });
      else { await navigator.clipboard.writeText(url); setShared(true); setTimeout(() => setShared(false), 1800); }
    } catch { /* пользователь закрыл системный диалог — это не ошибка */ }
  };

  return (
    <article className="lot">
      <div
        className="lot-art"
        onPointerMove={scrub}
        onPointerLeave={() => setFrame(0)}
      >
        {photos.map((p, i) => (
          <span key={i} className={`lot-frame${i === frame ? " on" : ""}`} aria-hidden={i !== frame}>
            {p ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={photoThumb(p)} alt={i === 0 ? auction.title : ""} loading="lazy" />
            ) : (
              <span className="ph">
                <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                     strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <rect x="3" y="5" width="18" height="14" rx="2" />
                  <circle cx="9" cy="10" r="1.6" /><path d="M21 16l-5-5-7 7" />
                </svg>
              </span>
            )}
          </span>
        ))}

        <div className="lot-tags">
          {live && <span className="tag tag-live"><i aria-hidden="true" />LIVE</span>}
          {!live && !ended && (
            <span className="tag">{t("card.startsAt")} {new Date(auction.startsAt).toLocaleDateString("lv-LV")}</span>
          )}
          {auction.hasReserve && !auction.reserveMet && <span className="tag">{t("a.reserveNotMet")}</span>}
        </div>

        <div className="lot-acts">
          <button
            type="button"
            aria-pressed={watched}
            aria-label={watched ? t("card.unwatch") : t("card.watch")}
            onClick={(e) => { stop(e); watchStore.toggle(auction.id); }}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 20s-7-4.5-7-9.5A3.9 3.9 0 0 1 12 8a3.9 3.9 0 0 1 7 2.5c0 5-7 9.5-7 9.5z" />
            </svg>
          </button>
          <button type="button" aria-label={t("card.share")} onClick={share}>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 16V4M8.5 7.5L12 4l3.5 3.5M5 14v4.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V14" />
            </svg>
          </button>
        </div>

        {photos.length > 1 && (
          <div className="lot-dots" role="group" aria-label={auction.title}>
            {photos.map((_, i) => (
              <button
                key={i}
                type="button"
                className="lot-dot"
                aria-current={i === frame}
                aria-label={`${t("card.photo")} ${i + 1}/${photos.length}`}
                onClick={(e) => { stop(e); setFrame(i); }}
              />
            ))}
          </div>
        )}
        {shared && <span className="lot-toast">{t("card.copied")}</span>}
      </div>

      <div className="lot-body">
        <p className="lot-top">
          <span>{auction.sku}</span>
          {live && <Countdown endsAt={auction.endsAt} />}
        </p>

        <h3>
          <Link href={`/auction/${auction.id}`}>{auction.title}</Link>
        </h3>

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

        <Link className={`btn ${live ? "btn-primary" : "btn-outline"} btn-block`} href={`/auction/${auction.id}`}>
          {live ? t("a.placeBid") : t("card.view")}
        </Link>
      </div>
    </article>
  );
}
