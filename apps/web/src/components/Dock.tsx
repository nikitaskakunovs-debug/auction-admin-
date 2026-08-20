"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { publicApi } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { Icon } from "./Icon";

/** Нижний док макета.
 *
 *  Док НЕ прячется при скролле. Раньше он уезжал вниз при скролле вниз и
 *  возвращался при скролле вверх, с порогом в 6 px. На iOS инерционная
 *  прокрутка постоянно даёт колебания в несколько пикселей, поэтому на записи
 *  реального айфона док менял состояние 31 раз за 125 секунд — это читается
 *  как мигание, а не как поведение. Единственное место, где док скрывается, —
 *  открытая модалка (`body.no-scroll .dock`).
 */
export function Dock() {
  const { t } = useT();
  const path = usePathname();
  const [initial, setInitial] = useState("N");

  useEffect(() => {
    const sync = () => setInitial(publicApi.hasSession ? "•" : "N");
    sync();
    publicApi.listeners.add(sync);
    return () => { publicApi.listeners.delete(sync); };
  }, []);

  const cur = (href: string) => (path === href ? "page" : undefined);

  return (
    <nav className="dock" aria-label={t("nav.mainNav")}>
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
