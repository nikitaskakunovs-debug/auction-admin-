"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { publicApi, PublicApiError } from "@/lib/api";
import { conditionLabel } from "@/lib/conditions";
import { increment } from "@/lib/fees";
import { dateLocale, useT } from "@/lib/i18n";
import { photoThumb } from "@/lib/photos";
import { formatEur, type PublicAuction } from "@/lib/types";
import { alertStore } from "@/lib/ui";
import { watchStore } from "@/lib/watch";
import { Icon } from "./Icon";
import { useNow, formatLeft } from "./Countdown";
import { openScale, openShare } from "./Modals";
import { say } from "./Toast";

/** Карточка лота утверждённого макета.
 *
 *  Поля, которых сегодня нет в движке, размечены как опциональные: как только
 *  они появятся в ответе API, блоки покажутся сами, без правки разметки.
 *    retailCents — зачёркнутая цена магазина и процент скидки
 *    gradeCode   — грейд A+/A/A−/B/D рядом с артикулом
 *    packaging   — второй чип состояния (упаковка)
 *    hot / noReserve — теги «Karsts» и «Bez rezerves»
 */
export type CardLot = PublicAuction & {
  retailCents?: number | null;
  gradeCode?: string | null;
  packaging?: string | null;
  categoryIcon?: string | null;
  hot?: boolean | null;
};

const CAT_ICON: Record<string, string> = {
  electronics: "tv", appliances: "coffee", furniture: "chair", tools: "tools",
  home_garden: "home", jewellery_watches: "watch", art_antiques: "art",
  sports_outdoors: "bike", kids_toys: "card", fashion: "box",
  food_household: "box", other: "art",
};

const FRAMES = 4;

export function LotCard({ lot }: { lot: CardLot }) {
  const { t, lang } = useT();
  const router = useRouter();
  const now = useNow();
  const [frame, setFrame] = useState(0);
  const [touched, setTouched] = useState(false);
  const [watched, setWatched] = useState(false);
  const [alerted, setAlerted] = useState(false);
  const [live, setLive] = useState<{ price: number; bids: number; youLead: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const art = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setWatched(watchStore.has(lot.id));
    return watchStore.subscribe(() => setWatched(watchStore.has(lot.id)));
  }, [lot.id]);

  useEffect(() => {
    setAlerted(alertStore.has(lot.id));
    return alertStore.subscribe(() => setAlerted(alertStore.has(lot.id)));
  }, [lot.id]);

  const isLive = lot.status === "live";
  const settled = lot.status.startsWith("ended");
  const shots = lot.photos.length ? lot.photos : new Array<string | null>(FRAMES).fill(null);
  const price = live?.price ?? lot.currentPriceCents ?? lot.startPriceCents ?? 0;
  const bidCount = live?.bids ?? lot.bidCount;
  const ask = price + increment(price);
  const left = new Date(lot.endsAt).getTime() - now;
  const over = left <= 0;
  const icon = lot.categoryIcon || CAT_ICON[lot.category] || "art";
  const off = lot.retailCents ? Math.max(0, Math.round((1 - price / lot.retailCents) * 100)) : null;

  const stop = (e: React.MouseEvent) => { e.preventDefault(); e.stopPropagation(); };
  const set = (i: number) => setFrame(Math.max(0, Math.min(shots.length - 1, i)));

  const scrub = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType !== "mouse" || shots.length < 2) return;
    const box = art.current?.querySelector<HTMLElement>("[data-gal]");
    if (!box) return;
    const r = box.getBoundingClientRect();
    set(Math.floor(((e.clientX - r.left) / r.width) * shots.length));
  };

  const swipe = useRef(0);

  /** Ставка прямо из карточки — как `[data-bid]` в макете.
   *  Без сессии уводим на вход, сохранив адрес лота. */
  const bid = async (e: React.MouseEvent) => {
    stop(e);
    if (settled || over) { say(t("lc.ended")); return; }
    if (!publicApi.hasSession) { router.push(`/login?next=/auction/${lot.id}`); return; }
    setBusy(true);
    try {
      const r = await publicApi.post<{ youLead: boolean; currentPriceCents: number; extended: boolean }>(
        `/api/public/auctions/${lot.id}/bids`, { maxCents: ask },
      );
      setLive({ price: r.currentPriceCents, bids: bidCount + 1, youLead: r.youLead });
      say(r.youLead ? t("lc.accepted", { sum: formatEur(r.currentPriceCents) }) : t("a.outbid"));
      if (r.extended) say(t("a.extended"));
    } catch (err) {
      if (err instanceof PublicApiError && err.body.code === "EMAIL_NOT_VERIFIED") {
        say(t("lc.verifyFirst"));
      } else if (err instanceof PublicApiError && typeof err.body.minAcceptableCents === "number") {
        say(`${t("a.minBid")}: ${formatEur(err.body.minAcceptableCents)}`);
      } else {
        say(err instanceof Error ? err.message : "error");
      }
    } finally { setBusy(false); }
  };

  // Строка аукционных состояний под ценой — `.chant` макета.
  const chant: [string, string] | null =
    settled
      ? (lot.hasReserve && !lot.reserveMet ? ["chant-pass", t("lc.unsoldReserve")]
        : ["chant-sold", t("lc.soldFor", { sum: formatEur(price) })])
      : live?.youLead ? ["chant-win", t("lc.youTop")]
      : live ? ["chant-out", t("lc.outbidAgain")]
      : isLive && left > 0 && left < 30_000 ? ["chant-go2", t("lc.second")]
      : isLive && left > 0 && left < 90_000 ? ["chant-go1", t("lc.first")]
      : null;

  const timeLabel = settled || over
    ? (settled ? (lot.hasReserve && !lot.reserveMet ? t("lc.unsold") : t("lc.sold")) : t("lc.over"))
    : isLive ? t("lc.endsIn", { left: formatLeft(left, lang) })
    : t("lc.startsOn", { date: new Date(lot.startsAt).toLocaleDateString(dateLocale(lang)) });

  return (
    <article
      className={`lot${settled ? " is-settled" : ""}`}
      data-lot data-id={lot.sku}
      onKeyDown={(e) => {
        if (e.key === "ArrowLeft") set(frame - 1);
        if (e.key === "ArrowRight") set(frame + 1);
      }}
    >
      <div className="lot-art" ref={art} onPointerMove={scrub} onPointerLeave={() => setFrame(0)}>
        <div
          className={`gal${touched ? " is-touched" : ""}`} data-gal
          onPointerDown={(e) => {
            if (e.pointerType === "mouse") return;
            swipe.current = e.clientX; setTouched(true);
          }}
          onPointerUp={(e) => {
            if (e.pointerType === "mouse") return;
            const dx = e.clientX - swipe.current;
            if (Math.abs(dx) > 28) set(frame + (dx < 0 ? 1 : -1));
          }}
        >
          {shots.map((p, i) => (
            <span key={i} className={`frame frame-${i + 1}${i === frame ? " on" : ""}`} data-frame>
              {p ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={photoThumb(p)} alt={i === 0 ? lot.title : ""} loading="lazy" />
              ) : (
                <Icon name={icon} className="pic" />
              )}
            </span>
          ))}
          <button className="gal-nav p" type="button" aria-label={t("lc.prevPhoto", { title: lot.title })}
                  onClick={(e) => { stop(e); set(frame - 1); }}><Icon name="arrow" /></button>
          <button className="gal-nav n" type="button" aria-label={t("lc.nextPhoto", { title: lot.title })}
                  onClick={(e) => { stop(e); set(frame + 1); }}><Icon name="arrow" /></button>
          <div className="gal-dots" role="group" aria-label={t("card.photoOf", { title: lot.title })}>
            {shots.map((_, i) => (
              <button key={i} className="gal-dot" type="button"
                      aria-current={i === frame ? "true" : undefined}
                      aria-label={t("card.photoNOf", { i: i + 1, n: shots.length, title: lot.title })}
                      onClick={(e) => { stop(e); set(i); }} />
            ))}
          </div>
        </div>

        <div className="lot-tags">
          {lot.hot && <span className="tag tag-live">{t("lc.hot")}</span>}
          {!lot.hasReserve && isLive && <span className="tag">{t("lr.noReserve")}</span>}
          {lot.hasReserve && !lot.reserveMet && <span className="tag">{t("a.reserveNotMet")}</span>}
        </div>

        {off !== null && <span className="tag tag-off">−{off} %</span>}

        <div className="lot-acts">
          <button type="button" aria-pressed={watched}
                  aria-label={t("lc.saveAria", { title: lot.title })}
                  onClick={(e) => {
                    stop(e); watchStore.toggle(lot.id);
                    say(watchStore.has(lot.id) ? t("lc.saved") : t("lc.unsaved"));
                  }}><Icon name="heart" /></button>
          <button type="button" aria-pressed={alerted}
                  aria-label={t("lc.alertAria", { title: lot.title })}
                  onClick={(e) => {
                    stop(e); alertStore.toggle(lot.id);
                    say(alertStore.has(lot.id) ? t("lc.alertOn") : t("lc.alertOff"));
                  }}><Icon name="bell" /></button>
          <button type="button" aria-haspopup="dialog" aria-label={t("lc.shareAria", { title: lot.title })}
                  onClick={(e) => { stop(e); openShare({ id: lot.id, sku: lot.sku, title: lot.title, icon }); }}
          ><Icon name="share" /></button>
        </div>

        <span className="lot-cat"><Icon name={icon} /></span>

        {settled && (
          <div className={`sold-ov${lot.hasReserve && !lot.reserveMet ? " passed" : ""}`}>
            <b>{lot.hasReserve && !lot.reserveMet ? t("lc.unsold") : t("lc.sold")}</b>
          </div>
        )}
      </div>

      <div className="lot-body">
        <p className="lot-top">
          <span className="id">
            {lot.sku}{lot.gradeCode ? ` · ${lot.gradeCode}` : ""}
            {lot.gradeCode && (
              <button className="info-btn" type="button" aria-haspopup="dialog"
                      aria-label={t("lc.scaleAria", { g: lot.gradeCode ?? "" })}
                      onClick={(e) => { stop(e); openScale(lot.gradeCode!); }}>i</button>
            )}
          </span>
          <time dateTime={lot.endsAt} suppressHydrationWarning
                className={[
                  isLive && left > 0 && left < 600_000 ? "soon" : "",
                  isLive && left > 0 && left < 60_000 ? "blink" : "",
                  settled || over ? "ended" : "",
                ].filter(Boolean).join(" ") || undefined}>{timeLabel}</time>
        </p>

        <h3><Link href={`/auction/${lot.id}`}>{lot.title}</Link></h3>

        <div className="grades">
          <span className="grade"><Icon name="shield" />{conditionLabel(lot.condition, t)}</span>
          {lot.packaging && <span className="grade"><Icon name="box" />{lot.packaging}</span>}
        </div>

        <div className="price-row">
          <div>
            <p className="price-lab">{t("lc.currentN", { n: bidCount })}<span className="sr">{t("lc.bidsSr")}</span></p>
            <p className={`price tnum${live?.youLead ? " is-win" : ""}`}>{formatEur(price)}</p>
          </div>
          {lot.retailCents ? (
            <div className="rrp">
              <p className="price-lab">
                {t("lc.retail")}
                <button className="info-btn" type="button" aria-label={t("lc.retailAria")}
                        onClick={(e) => { stop(e); say(t("lc.retailNote")); }}
                >i</button>
              </p>
              <s className="tnum">{formatEur(lot.retailCents)}</s>
            </div>
          ) : null}
        </div>

        {chant && (
          <p className={`chant ${chant[0]}`}><i aria-hidden="true" />{chant[1]}</p>
        )}

        {settled || over || !isLive ? (
          <Link className="btn btn-outline btn-block bid-btn" href={`/auction/${lot.id}`}>
            {settled && !(lot.hasReserve && !lot.reserveMet)
              ? t("lc.soldFor", { sum: formatEur(price) })
              : t("lc.viewLot")}
          </Link>
        ) : (
          <button className="btn btn-primary btn-block bid-btn" type="button" disabled={busy} onClick={bid}>
            {live && !live.youLead ? t("lc.bidAgain") : t("lc.bid")}
            <span className="ask">{formatEur(ask)}</span>
          </button>
        )}
      </div>
    </article>
  );
}

/** Скелетон карточки — пока грузится очередная порция ленты. */
export function LotSkeleton() {
  return (
    <article className="skel" aria-hidden="true">
      <div className="sk sk-art" />
      <div className="sk-body">
        <div className="sk sk-l" style={{ width: "45%" }} />
        <div className="sk sk-l" style={{ width: "88%", height: 16 }} />
        <div className="sk sk-l" style={{ width: "52%" }} />
        <div className="sk sk-l" style={{ width: "100%", height: 48, borderRadius: 999, marginTop: 4 }} />
      </div>
    </article>
  );
}
