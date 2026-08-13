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
const RAIL: Array<{ label: string; icon: string; href: string; live?: boolean }> = [
  { label: "Tiešraidē", icon: "bolt", href: "/tiesraide", live: true },
  { label: "Drīz beidzas", icon: "timer", href: "/katalogs?closing=1h" },
  { label: "Bez rezerves", icon: "tag", href: "/katalogs?reserve=no" },
  { label: "Pulksteņi", icon: "watch", href: "/katalogs?category=jewellery_watches" },
  { label: "Elektronika", icon: "tv", href: "/katalogs?category=electronics" },
  { label: "Kameras", icon: "camera", href: "/katalogs?category=electronics" },
  { label: "Audio", icon: "audio", href: "/katalogs?category=electronics" },
  { label: "Māksla", icon: "art", href: "/katalogs?category=art_antiques" },
  { label: "Mājai", icon: "home", href: "/katalogs?category=home_garden" },
  { label: "Instrumenti", icon: "tools", href: "/katalogs?category=tools" },
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


  useEffect(() => {
    const el = document.querySelector<HTMLElement>("[data-chrome]");
    const head = document.querySelector<HTMLElement>(".head");
    if (!el || !head) return;
    const measure = () => {
      document.documentElement.style.setProperty("--chrome-h", `${el.offsetHeight}px`);
      document.documentElement.style.setProperty("--chrome-c", `${head.offsetHeight}px`);
    };
    measure();
    let raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        setCompact(window.scrollY > 56);
        setTimeout(measure, 360);
      });
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", measure);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", measure);
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
          <nav className="util-c" aria-label="Ātrās saites">
            <Link href="/tiesraide"><i className="pulse" aria-hidden="true" />Tiešraidē</Link>
            <Link href="/katalogs">Visas kategorijas</Link>
            <Link href="/rezultati">Izsoļu rezultāti</Link>
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
            <Icon name={menu ? "x" : "menu"} size={18} /><span>Katalogs</span>
          </button>

          <button className="search" type="button" aria-haspopup="dialog" aria-expanded={search}
                  onClick={() => setSearch(true)}>
            <Icon name="search" size={20} />
            <span className="ph">Meklēt lotus…</span>
          </button>

          <div className="head-act">
            <Link className="icon-link" href="/account?tab=alerts">
              <Icon name="bell" size={22} />Brīdinājumi
              {alerts > 0 && (
                <>
                  <span className="n" aria-hidden="true">{alerts}</span>
                  <span className="sr">{alerts} brīdinājumi</span>
                </>
              )}
            </Link>
            <Link className="icon-link" href="/velmes">
              <Icon name="heart" size={22} />Vēlmes
              {watched > 0 && (
                <>
                  <span className="n" aria-hidden="true">{watched}</span>
                  <span className="sr">{watched} saglabāti loti</span>
                </>
              )}
            </Link>
            {signedIn ? (
              <>
                <Link className="btn btn-outline btn-sm" href="/account">{t("nav.account")}</Link>
                <button className="btn btn-primary btn-sm" onClick={() => publicApi.logout()}>{t("nav.signout")}</button>
              </>
            ) : (
              <>
                <Link className="btn btn-outline btn-sm" href="/login">{t("nav.signin")}</Link>
                <Link className="btn btn-primary btn-sm" href="/register">{t("nav.register")}</Link>
              </>
            )}
          </div>
        </div>
      </header>

      <nav className="cats" aria-label="Kategorijas">
        <div className="wrap">
          <div className="scroller" ref={rail}>
            {RAIL.map((c, i) => (
              <Link key={c.label} className="cat" href={c.href} aria-current={i === 0 ? "page" : undefined}>
                {c.live && <i className="dot" aria-hidden="true" />}
                <span className="ic"><Icon name={c.icon} /></span>
                <span>{c.label}</span>
              </Link>
            ))}
            {/* «Visas» открывает разворот каталога — на телефоне это
                единственный вход в него, кнопка «Katalogs» там скрыта. */}
            <button className="cat" type="button" aria-haspopup="dialog" aria-expanded={menu}
                    onClick={() => setMenu((v) => !v)}>
              <span className="ic"><Icon name="plus" /></span>
              <span>Visas</span>
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
