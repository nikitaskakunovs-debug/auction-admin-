"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { publicApi } from "@/lib/api";
import { useT } from "@/lib/i18n";
import type { Country } from "@/lib/country";
import { alertStore, useRail, useReveal } from "@/lib/ui";
import { watchStore } from "@/lib/watch";
import { CatalogMenu } from "./CatalogMenu";
import { COUNTRY_LABEL, LANG_NAME, RegionMenu } from "./RegionMenu";
import { SearchOverlay } from "./SearchOverlay";
import { Icon } from "./Icon";

/** Категории макета. Коды — из движка (CATEGORY_CODES), первые три пункта
 *  это срезы каталога, а не категории: так было в утверждённом макете. */
const RAIL: Array<{ key: string; icon: string; href: string; live?: boolean }> = [
  { key: "rail.live", icon: "bolt", href: "/tiesraide", live: true },
  { key: "rail.closing", icon: "timer", href: "/katalogs?closing=1h" },
  { key: "rail.noReserve", icon: "tag", href: "/katalogs?reserve=no" },
  { key: "cat.watches", icon: "watch", href: "/katalogs?category=jewellery_watches" },
  { key: "cat.electronics", icon: "tv", href: "/katalogs?category=electronics" },
  { key: "cat.cameras", icon: "camera", href: "/katalogs?category=electronics" },
  { key: "cat.audio", icon: "audio", href: "/katalogs?category=electronics" },
  { key: "cat.art", icon: "art", href: "/katalogs?category=art_antiques" },
  { key: "cat.home", icon: "home", href: "/katalogs?category=home_garden" },
  { key: "cat.tools", icon: "tools", href: "/katalogs?category=tools" },
];

/** Верхняя панель макета: утилити-полоса, шапка и лента категорий.
 *  Панель зафиксирована; при скролле вниз утилити и категории сворачиваются. */
export function Chrome({ country = "LV" }: { country?: Country }) {
  const { lang, t } = useT();
  const [signedIn, setSignedIn] = useState(false);
  const [watched, setWatched] = useState(0);
  const [compact, setCompact] = useState(false);
  const [region, setRegion] = useState(false);
  const [search, setSearch] = useState(false);
  const [alerts, setAlerts] = useState(0);
  const [menu, setMenu] = useState(false);
  const rail = useRail<HTMLDivElement>();

  useReveal();

  useEffect(() => {
    setSignedIn(publicApi.hasSession);
    const fn = () => setSignedIn(publicApi.hasSession);
    publicApi.listeners.add(fn);
    return () => { publicApi.listeners.delete(fn); };
  }, []);

  useEffect(() => {
    const sync = () => setWatched(watchStore.list().length);
    sync();
    return watchStore.subscribe(sync);
  }, []);

  useEffect(() => {
    const sync = () => setAlerts(alertStore.list().length);
    sync();
    return alertStore.subscribe(sync);
  }, []);


  /* Высота панели. Её меряет ResizeObserver — он срабатывает ровно тогда,
   * когда высота действительно изменилась.
   *
   * Раньше здесь на каждом кадре скролла стоял `setTimeout(measure, 360)`.
   * Каждый такой вызов читал offsetHeight (браузер вынужден пересчитать
   * раскладку немедленно) и записывал переменную в :root, обесценивая стили
   * всей страницы. За пять секунд прокрутки набегало три сотни таких пар —
   * это и был главный источник рывков. */
  useEffect(() => {
    const el = document.querySelector<HTMLElement>("[data-chrome]");
    const head = document.querySelector<HTMLElement>(".head");
    if (!el || !head) return;
    let lastH = -1, lastC = -1;
    const measure = () => {
      const h = el.offsetHeight, c = head.offsetHeight;
      if (h !== lastH) { lastH = h; document.documentElement.style.setProperty("--chrome-h", `${h}px`); }
      if (c !== lastC) { lastC = c; document.documentElement.style.setProperty("--chrome-c", `${c}px`); }
    };
    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    ro.observe(head);
    return () => ro.disconnect();
  }, []);

  /* Сворачивание панели — по направлению прокрутки, как в Instagram:
   * листаешь вниз — панель ужимается и освобождает экран, ведёшь вверх —
   * возвращается сразу, не дожидаясь, пока доскроллишь до самого верха.
   *
   * Порог в 8 пикселей гасит дрожание пальца, иначе панель будет моргать. */
  useEffect(() => {
    let last = window.scrollY, raf = 0;
    const read = () => {
      raf = 0;
      const y = window.scrollY;
      if (y <= 56) setCompact(false);
      else if (y > last + 8) setCompact(true);
      else if (y < last - 8) setCompact(false);
      last = y;
    };
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(read); };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  return (
    <div className={`topchrome${compact ? " is-compact" : ""}`} data-chrome>
      <div className="util">
        <div className="wrap">
          <span className="util-l">
            <button type="button" aria-haspopup="dialog" aria-expanded={region}
                    onClick={() => setRegion(true)}>
              <Icon name="pin" size={16} />{COUNTRY_LABEL[country].city}, {country}
            </button>
          </span>
          <nav className="util-c" aria-label={t("nav.quickLinks")}>
            <Link href="/tiesraide"><i className="pulse" aria-hidden="true" />{t("rail.live")}</Link>
            <Link href="/katalogs">{t("nav.allCategories")}</Link>
            <Link href="/rezultati">{t("nav.results")}</Link>
          </nav>
          <div className="util-r">
            <button type="button" aria-haspopup="dialog" aria-expanded={region}
                    onClick={() => setRegion(true)}>
              <Icon name="globe" size={16} />{LANG_NAME[lang] ?? lang.toUpperCase()}
            </button>
            <button type="button" aria-haspopup="dialog" onClick={() => setRegion(true)}>EUR €</button>
          </div>
        </div>
      </div>

      <header className="head">
        <div className="wrap">
          <Link className="logo" href="/">
            <span className="logo-mark" aria-hidden="true">I</span>Izsoli.lv
          </Link>

          <button className="cat-btn" type="button" aria-expanded={menu} aria-haspopup="dialog"
                  onClick={() => setMenu((v) => !v)}>
            <Icon name={menu ? "x" : "menu"} size={18} /><span>{t("nav.catalogue")}</span>
          </button>

          <button className="search" type="button" aria-haspopup="dialog" aria-expanded={search}
                  onClick={() => setSearch(true)}>
            <Icon name="search" size={20} />
            <span className="ph">{t("nav.searchPh")}</span>
          </button>

          <div className="head-act">
            <Link className="icon-link" href="/account?tab=alerts">
              <Icon name="bell" size={22} />{t("nav.alerts")}
              {alerts > 0 && (
                <>
                  <span className="n" aria-hidden="true">{alerts}</span>
                  <span className="sr">{t("nav.alertsN", { n: alerts })}</span>
                </>
              )}
            </Link>
            <Link className="icon-link" href="/velmes">
              <Icon name="heart" size={22} />{t("nav.watchlist")}
              {watched > 0 && (
                <>
                  <span className="n" aria-hidden="true">{watched}</span>
                  <span className="sr">{t("nav.watchlistN", { n: watched })}</span>
                </>
              )}
            </Link>
            {/* На телефоне видна только primary-кнопка, поэтому главным
                действием стоит вход и кабинет, а не выход. */}
            {signedIn ? (
              <>
                <button className="btn btn-outline btn-sm" onClick={() => publicApi.logout()}>{t("nav.signout")}</button>
                <Link className="btn btn-primary btn-sm" href="/account">{t("nav.account")}</Link>
              </>
            ) : (
              <>
                <Link className="btn btn-outline btn-sm keep" href="/login">{t("nav.signin")}</Link>
                <Link className="btn btn-primary btn-sm" href="/register">{t("nav.register")}</Link>
              </>
            )}
          </div>
        </div>
      </header>

      <nav className="cats" aria-label={t("nav.categories")}>
        <div className="wrap">
          <div className="scroller" ref={rail}>
            {RAIL.map((c, i) => (
              <Link key={c.key} className="cat" href={c.href} aria-current={i === 0 ? "page" : undefined}>
                {c.live && <i className="dot" aria-hidden="true" />}
                <span className="ic"><Icon name={c.icon} /></span>
                <span>{t(c.key)}</span>
              </Link>
            ))}
            {/* «Visas» открывает разворот каталога — на телефоне это
                единственный вход в него, кнопка «Katalogs» там скрыта. */}
            <button className="cat" type="button" aria-haspopup="dialog" aria-expanded={menu}
                    onClick={() => setMenu((v) => !v)}>
              <span className="ic"><Icon name="plus" /></span>
              <span>{t("rail.all")}</span>
            </button>
          </div>
        </div>
      </nav>

      <CatalogMenu open={menu} onClose={() => setMenu(false)} />
      <RegionMenu open={region} onClose={() => setRegion(false)} country={country} />
      <SearchOverlay open={search} onClose={() => setSearch(false)} />
    </div>
  );
}
