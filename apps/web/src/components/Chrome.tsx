"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { publicApi } from "@/lib/api";
import { useT, type Lang } from "@/lib/i18n";
import { watchStore } from "@/lib/watch";
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
  { label: "Visas", icon: "plus", href: "/katalogs" },
];

const LANG_NAME: Record<string, string> = {
  lv: "Latviešu", ru: "Русский", en: "English", et: "Eesti", lt: "Lietuvių",
};

/** Верхняя панель макета: утилити-полоса, шапка и лента категорий.
 *  Панель зафиксирована; при скролле вниз утилити и категории сворачиваются. */
export function Chrome() {
  const { lang, setLang, available, t } = useT();
  const [signedIn, setSignedIn] = useState(false);
  const [watched, setWatched] = useState(0);
  const [compact, setCompact] = useState(false);
  const [langOpen, setLangOpen] = useState(false);

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
    if (!langOpen) return;
    const close = () => setLangOpen(false);
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [langOpen]);

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
          <span className="util-l"><Icon name="pin" size={16} />Rīga, LV</span>
          <nav className="util-c" aria-label="Ātrās saites">
            <Link href="/tiesraide"><i className="pulse" aria-hidden="true" />Tiešraidē</Link>
            <Link href="/katalogs">Visas kategorijas</Link>
            <Link href="/rezultati">Izsoļu rezultāti</Link>
          </nav>
          <div className="util-r">
            <span style={{ position: "relative" }}>
              <button type="button" aria-expanded={langOpen} aria-haspopup="listbox"
                      onClick={(e) => { e.stopPropagation(); setLangOpen((v) => !v); }}>
                <Icon name="globe" size={16} />{LANG_NAME[lang] ?? lang.toUpperCase()}
              </button>
              {langOpen && (
                <div className="pop right" role="listbox" style={{ top: "100%", marginTop: 6 }}>
                  {available.map((l: Lang) => (
                    <button key={l} type="button" role="option" aria-selected={lang === l}
                            onClick={() => { setLang(l); setLangOpen(false); }}>
                      <span className="nm">{LANG_NAME[l] ?? l.toUpperCase()}</span>
                    </button>
                  ))}
                </div>
              )}
            </span>
            <span>EUR €</span>
          </div>
        </div>
      </div>

      <header className="head">
        <div className="wrap">
          <Link className="logo" href="/">
            <span className="logo-mark" aria-hidden="true">I</span>Izsoli.lv
          </Link>

          <Link className="cat-btn" href="/katalogs"><Icon name="menu" size={18} /><span>Katalogs</span></Link>

          <form className="search" role="search" action="/meklet" method="get">
            <Icon name="search" size={20} />
            <label className="sr" htmlFor="q">Meklēt lotus</label>
            <input id="q" name="q" type="search" placeholder="Meklēt lotus…" autoComplete="off" />
          </form>

          <div className="head-act">
            <Link className="icon-link" href="/velmes">
              <Icon name="bell" size={22} />Brīdinājumi
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
          <div className="scroller">
            {RAIL.map((c, i) => (
              <Link key={c.label} className="cat" href={c.href} aria-current={i === 0 ? "page" : undefined}>
                {c.live && <i className="dot" aria-hidden="true" />}
                <span className="ic"><Icon name={c.icon} /></span>
                <span>{c.label}</span>
              </Link>
            ))}
          </div>
        </div>
      </nav>
    </div>
  );
}
