"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { publicApi } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { Icon } from "./Icon";

/** Нижний док макета: прячется при скролле вниз, возвращается при скролле вверх. */
export function Dock() {
  const { t } = useT();
  const path = usePathname();
  const [hidden, setHidden] = useState(false);
  const [initial, setInitial] = useState("N");

  /* Док прячется при движении вниз и возвращается при движении вверх.
   *
   * Отправная точка берётся из текущего положения страницы, а не из нуля.
   * Раньше она была нулём: если страница открывалась уже прокрученной —
   * при возврате назад или по ссылке с якорем, — первое же событие скролла
   * читалось как «ушли далеко вниз», и док прятался сразу. Отсюда и брались
   * экраны, где его просто нет. */
  useEffect(() => {
    let last = window.scrollY, raf = 0;
    const read = () => {
      raf = 0;
      const y = window.scrollY;
      const next = y > 320 && y > last + 6 ? true : (y < last - 6 || y <= 320) ? false : null;
      last = y;
      if (next !== null) setHidden((cur) => (cur === next ? cur : next));
    };
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(read); };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  /* Переход на другую страницу всегда возвращает док.
   *
   * Без этого он оставался спрятанным: короткая страница не порождает ни
   * одного события скролла, значит и вернуть его было нечему. Это вторая
   * половина «где-то появляется, где-то нет». */
  useEffect(() => { setHidden(false); }, [path]);

  useEffect(() => {
    const sync = () => setInitial(publicApi.hasSession ? "•" : "N");
    sync();
    publicApi.listeners.add(sync);
    return () => { publicApi.listeners.delete(sync); };
  }, []);

  const cur = (href: string) => (path === href ? "page" : undefined);

  return (
    <nav className={`dock${hidden ? " is-hidden" : ""}`} aria-label={t("nav.mainNav")}>
      <Link href="/" aria-current={cur("/")}><Icon name="home" /><span className="lbl">{t("nav.home")}</span></Link>
      <Link href="/tiesraide">
        <Icon name="bolt" /><span className="lbl">{t("rail.live")}</span>
        <i className="badge-dot" aria-hidden="true" />
      </Link>
      <Link href="/meklet"><Icon name="search" /><span className="lbl">{t("nav.search")}</span></Link>
      <Link href="/velmes"><Icon name="heart" /><span className="lbl">{t("nav.watchlist")}</span></Link>
      <Link href="/account">
        <span className="ava" aria-hidden="true">{initial}</span><span className="lbl">{t("nav.profile")}</span>
      </Link>
    </nav>
  );
}
