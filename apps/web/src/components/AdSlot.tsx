"use client";

import { useEffect, useRef } from "react";
import { PUBLIC_API_URL } from "@/lib/config";
import type { AdCard } from "@/lib/types";
import { Icon } from "./Icon";

/**
 * Рекламная карточка в ленте лотов.
 *
 * Стоит в общем потоке карточек: человек листает каталог и встречает её среди
 * лотов. Отмечена словом «Реклама» — выдавать её за лот нельзя ни по закону о
 * рекламе, ни по совести: человек должен понимать, за что заплатили.
 *
 * Показ засчитывается один раз и только когда карточка действительно попала на
 * экран, — это то, что продаётся рекламодателю.
 */
export function AdSlot({ ad, label }: { ad: AdCard; label: string }) {
  const seen = useRef(false);
  const box = useRef<HTMLElement>(null);

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

  return (
    <article className={`lot lot-ad banner-${ad.theme}`} ref={box} data-ad>
      <a href={ad.href} rel="sponsored noopener" target="_blank" className="ad-face">
        <span className="ad-mark">{label}</span>
        {ad.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={ad.imageUrl} alt="" className="ad-img" loading="lazy" />
        ) : null}
        <span className="ad-body">
          <b>{ad.title}</b>
          {ad.body ? <span className="ad-text">{ad.body}</span> : null}
          {ad.ctaLabel ? (
            <span className="ad-cta">{ad.ctaLabel}<Icon name="arrow" size={16} /></span>
          ) : null}
        </span>
      </a>
    </article>
  );
}
