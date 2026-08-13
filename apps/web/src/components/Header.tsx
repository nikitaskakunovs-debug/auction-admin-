"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { publicApi } from "@/lib/api";
import { useT, type Lang } from "@/lib/i18n";

/** Шапка зафиксирована на весь скролл. При прокрутке вниз верхняя
 *  утилити-полоса сворачивается, строка с логотипом и поиском остаётся. */
export function Header() {
  const { lang, setLang, available, t } = useT();
  const [signedIn, setSignedIn] = useState(false);
  const [compact, setCompact] = useState(false);

  useEffect(() => {
    setSignedIn(publicApi.hasSession);
    const fn = () => setSignedIn(publicApi.hasSession);
    publicApi.listeners.add(fn);
    return () => {
      publicApi.listeners.delete(fn);
    };
  }, []);

  // Высоту панели меряем в рантайме: она разная на мобильном и десктопе,
  // и меняется, когда утилити-полоса сворачивается.
  useEffect(() => {
    const el = document.querySelector<HTMLElement>(".topchrome");
    if (!el) return;
    const measure = () =>
      document.documentElement.style.setProperty("--chrome-h", `${el.offsetHeight}px`);
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
    <div className={`topchrome${compact ? " is-compact" : ""}`}>
      <div className="util">
        <div className="wrap">
          <span>Rīga, LV</span>
          <nav aria-label={t("nav.auctions")} style={{ display: "flex", gap: 24 }}>
            <Link href="/">{t("nav.auctions")}</Link>
            <Link href="/conditions">{t("nav.conditions")}</Link>
          </nav>
          <span>EUR €</span>
        </div>
      </div>

      <header className="head">
        <div className="wrap">
          <Link className="logo" href="/">
            <span className="logo-mark" aria-hidden="true">I</span>
            Izsoli.lv
          </Link>

          <form className="head-search" role="search" action="/" method="get">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 strokeWidth="1.9" strokeLinecap="round" aria-hidden="true">
              <circle cx="11" cy="11" r="7" /><path d="M20 20l-3.6-3.6" />
            </svg>
            <label className="sr" htmlFor="q">{t("nav.auctions")}</label>
            <input id="q" name="q" type="search" placeholder={t("nav.searchPh")} />
          </form>

          <div className="head-act">
            {signedIn ? (
              <>
                <Link className="btn btn-outline btn-sm" href="/account">{t("nav.account")}</Link>
                <button className="btn btn-sm" onClick={() => publicApi.logout()}>{t("nav.signout")}</button>
              </>
            ) : (
              <>
                <Link className="btn btn-outline btn-sm" href="/login">{t("nav.signin")}</Link>
                <Link className="btn btn-primary btn-sm" href="/register">{t("nav.register")}</Link>
              </>
            )}
            <span className="langs">
              {available.map((l: Lang) => (
                <button key={l} aria-pressed={lang === l} onClick={() => setLang(l)}>{l}</button>
              ))}
            </span>
          </div>
        </div>
      </header>
    </div>
  );
}
