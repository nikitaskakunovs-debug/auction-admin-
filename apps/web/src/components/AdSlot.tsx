"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { PUBLIC_API_URL } from "@/lib/config";
import { useT } from "@/lib/i18n";
import type { AdCard } from "@/lib/types";
import { Icon } from "./Icon";

/**
 * Рекламная карточка в ленте лотов. Три вида одного места:
 * баннер, карусель кадров и видео.
 *
 * Ссылка сама говорит, куда ведёт: начинается с «/» — это раздел нашего
 * сайта, обычный переход; начинается с «https://» — сайт рекламодателя,
 * новая вкладка и rel="sponsored".
 *
 * Пометка «Реклама» выключаема, но для чужой оплаченной рекламы обязана
 * стоять — закон о рекламе требует, чтобы её было видно. Снимать её честно
 * только на собственных промо-карточках.
 *
 * Показ засчитывается один раз и только когда карточка действительно попала
 * на экран, — это то, что продаётся рекламодателю.
 */
export function AdSlot({ ad, label }: { ad: AdCard; label: string }) {
  const { t } = useT();
  const seen = useRef(false);
  const box = useRef<HTMLElement>(null);
  const vid = useRef<HTMLVideoElement>(null);
  const [frame, setFrame] = useState(0);
  const [still, setStill] = useState(false); // prefers-reduced-motion

  // Старый кэш API может отдать карточку без новых полей — не падаем на ней.
  const frames = ad.images ?? [];
  const shots = ad.kind === "carousel" ? frames : [];
  const poster = ad.imageUrl ?? frames[0] ?? null;
  const external = /^https?:/i.test(ad.href);

  /* Ролик — не обязательно видеофайл. Анимированный SVG, GIF или WebP весит
   * в разы меньше mp4 и играет в обычном <img>; видеотег ему не нужен и не
   * подходит. Чем показывать — решаем по расширению адреса; без расширения
   * считаем видеофайлом. Важно: чужой SVG рисуем только через <img> — там
   * браузер не исполняет вложенные скрипты. */
  const isVideoFile = !!ad.videoUrl && !/\.(svg|gif|webp|png|apng|avif|jpe?g)([?#]|$)/i.test(ad.videoUrl);

  // ── Показы ────────────────────────────────────────────────────────────────
  useEffect(() => {
    const el = box.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting || seen.current) continue;
          seen.current = true;
          io.disconnect();
          // Ошибку глотаем: несосчитанный показ не повод ломать страницу.
          void fetch(`${PUBLIC_API_URL}/api/public/ads/${ad.id}/seen`, { method: "POST" }).catch(() => undefined);
        }
      },
      { threshold: 0.5 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [ad.id]);

  // ── Видео: играет только на экране и только без звука ─────────────────────
  useEffect(() => {
    if (ad.kind !== "video") return;
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
      // Для анимированной картинки паузы нет — вместо неё покажем постер.
      // Человек просил поменьше движения — не автоплеим, даём кнопку.
      setStill(true);
      return;
    }
    const v = vid.current;
    if (!v || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) void v.play().catch(() => undefined);
          else v.pause();
        }
      },
      { threshold: 0.4 },
    );
    io.observe(v);
    return () => io.disconnect();
  }, [ad.kind]);

  // ── Карусель: свайп по всей карточке, клик после свайпа не переходит ─────
  const swipe = useRef(0);
  const moved = useRef(false);
  const set = (i: number) => setFrame((shots.length + i) % shots.length);
  const onDown = (e: React.PointerEvent) => { swipe.current = e.clientX; moved.current = false; };
  const onUp = (e: React.PointerEvent) => {
    const dx = e.clientX - swipe.current;
    if (Math.abs(dx) > 28 && shots.length > 1) { moved.current = true; set(frame + (dx < 0 ? 1 : -1)); }
  };
  const onClickCapture = (e: React.MouseEvent) => {
    if (moved.current) { e.preventDefault(); e.stopPropagation(); moved.current = false; }
  };
  const stop = (e: React.MouseEvent) => { e.preventDefault(); e.stopPropagation(); };

  const inner = (
    <>
      <b>{ad.title}</b>
      {ad.body ? <span className="ad-text">{ad.body}</span> : null}
      {ad.ctaLabel ? (
        <span className="ad-cta">{ad.ctaLabel}<Icon name="arrow" size={16} /></span>
      ) : null}
    </>
  );

  return (
    <article
      className={`lot lot-ad banner-${ad.theme}`} ref={box} data-ad
      onPointerDown={ad.kind === "carousel" ? onDown : undefined}
      onPointerUp={ad.kind === "carousel" ? onUp : undefined}
      onClickCapture={ad.kind === "carousel" ? onClickCapture : undefined}
    >
      {ad.showLabel !== false && <span className="ad-mark">{label}</span>}

      {ad.kind === "video" && ad.videoUrl && isVideoFile ? (
        <video
          ref={vid} className="ad-media" src={ad.videoUrl} poster={poster ?? undefined}
          muted loop playsInline preload="metadata" controls={still}
        />
      ) : ad.kind === "video" && ad.videoUrl ? (
        /* Анимация в картинке. Остановить её нельзя, поэтому при
           prefers-reduced-motion показываем постер, если он задан. */
        // eslint-disable-next-line @next/next/no-img-element
        <img className="ad-media" src={still && poster ? poster : ad.videoUrl} alt="" loading="lazy" />
      ) : ad.kind === "carousel" && shots.length > 0 ? (
        <>
          {shots.map((src, i) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img key={src + i} src={src} alt="" loading="lazy"
                 className={`ad-media ad-frame${i === frame ? " on" : ""}`} />
          ))}
          <button className="ad-nav p" type="button" aria-label={t("bn.prevOffer")}
                  onClick={(e) => { stop(e); set(frame - 1); }}><Icon name="arrow" /></button>
          <button className="ad-nav n" type="button" aria-label={t("bn.nextOffer")}
                  onClick={(e) => { stop(e); set(frame + 1); }}><Icon name="arrow" /></button>
          <div className="ad-dots">
            {shots.map((_, i) => (
              <button key={i} type="button" aria-current={i === frame ? "true" : undefined}
                      aria-label={t("card.photoN", { i: i + 1, n: shots.length })}
                      onClick={(e) => { stop(e); set(i); }} />
            ))}
          </div>
        </>
      ) : poster ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={poster} alt="" className="ad-media" loading="lazy" />
      ) : null}

      {/* Одна ссылка на карточку: заголовок, текст и кнопка внутри неё, а
          растянутая область делает кликабельной всю карточку. Кнопки карусели
          лежат выше по z-index и работают сами. */}
      {external ? (
        <a className="ad-go" href={ad.href} target="_blank" rel="sponsored noopener">{inner}</a>
      ) : (
        <Link className="ad-go" href={ad.href}>{inner}</Link>
      )}
    </article>
  );
}
