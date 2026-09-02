"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { publicApi } from "@/lib/api";
import { captureAttribution, submitAttribution } from "@/lib/attr";
import { useT } from "@/lib/i18n";
import type { Country } from "@/lib/country";
import { alertStore, useRail, useReveal } from "@/lib/ui";
import { cartStore } from "@/lib/cart";
import { loginHref } from "@/lib/nav";
import { trackPageView } from "@/lib/track";
import { watchStore } from "@/lib/watch";
import { markAlertsSeen, relTime, type MyNotification } from "./account/data";
import { CatalogMenu } from "./CatalogMenu";
import { Ph } from "./Ph";
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
  const [region, setRegion] = useState(false);
  const [search, setSearch] = useState(false);
  const [alerts, setAlerts] = useState(0);
  const [cart, setCart] = useState(0);
  const [menu, setMenu] = useState(false);
  const rail = useRail<HTMLDivElement>();
  const path = usePathname();

  useReveal();

  useEffect(() => {
    setSignedIn(publicApi.hasSession);
    // Первое касание рекламы запоминаем на любом входе на сайт; как только
    // появляется аккаунт — один раз отдаём движку (для отчёта по кампаниям).
    captureAttribution();
    submitAttribution();
    const fn = () => { setSignedIn(publicApi.hasSession); submitAttribution(); };
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
    const sync = () => setCart(cartStore.count());
    sync();
    return cartStore.subscribe(sync);
  }, []);

  // §4: «vēlmes на исходе» — бейдж срочности на сердце: сколько наблюдаемых
  // лотов закрывается в ближайшие сутки. Не поп-ап, просто число.
  const [endingSoon, setEndingSoon] = useState(0);
  useEffect(() => {
    if (!publicApi.hasSession) return;
    void publicApi.get<{ endingSoon: number }>("/api/public/me/wishlist-alerts")
      .then((r) => setEndingSoon(r.endingSoon))
      .catch(() => undefined);
  }, [path]);

  // Meta PageView при переходах внутри витрины. Выключен, пока базовый тег
  // GTM не переведён на событие meta_page_view (иначе просмотр считался бы
  // дважды) — см. trackPageView.
  useEffect(() => { trackPageView(); }, [path]);


  /* Высота верхней панели постоянна.
   *
   *  Раньше при скролле ниже 56 px панель складывалась, а через 360 мс JS
   *  переписывал `--chrome-h`, из которого считается `body{padding-top}`.
   *  На телефоне 390×844 это давало мгновенный сдвиг всей страницы на 195 px —
   *  четверть экрана — вверх при прокрутке вниз и обратно вниз при прокрутке
   *  вверх. Именно это читается как «экран дёргается».
   *
   *  Теперь панель не складывается, а лента категорий на телефоне свёрнута до
   *  одной строки чипов (см. globals.css). Высоту меряет ResizeObserver —
   *  он срабатывает ровно тогда, когда она действительно изменилась;
   *  на скролл не реагируем вообще.
   */
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

  return (
    <div className="topchrome" data-chrome>
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
            {signedIn ? (
              <BellMenu alerts={alerts} />
            ) : (
              <Link className="icon-link" href="/account?tab=bridinajumi">
                <Icon name="bell" size={22} />{t("nav.alerts")}
                {alerts > 0 && (
                  <>
                    <span className="n" aria-hidden="true">{alerts}</span>
                    <span className="sr">{t("nav.alertsN", { n: alerts })}</span>
                  </>
                )}
              </Link>
            )}
            <Link className="icon-link" href="/velmes">
              <Icon name="heart" size={22} />{t("nav.watchlist")}
              {endingSoon > 0 ? (
                <>
                  <span className="n" aria-hidden="true" style={{ background: "var(--live, #C43C2E)", color: "#fff" }}>{endingSoon}</span>
                  <span className="sr">{t("nav.watchEndingN", { n: endingSoon })}</span>
                </>
              ) : watched > 0 && (
                <>
                  <span className="n" aria-hidden="true">{watched}</span>
                  <span className="sr">{t("nav.watchlistN", { n: watched })}</span>
                </>
              )}
            </Link>
            {/* Корзина. Раньше страница /grozs существовала, но попасть на
                неё было неоткуда: ссылка появлялась в кабинете только при
                двух и более неоплаченных лотах. Значок даёт корзине
                постоянное место — как в любом магазине, — и показывает
                число лотов, ждущих оплаты. Гостю корзину не показываем:
                у него нет заказов, и пустой значок только путал бы. */}
            {signedIn && (
              <Link className="icon-link" href="/grozs">
                <Icon name="cart" size={22} />{t("nav.cart")}
                {cart > 0 && (
                  <>
                    <span className="n" aria-hidden="true">{cart}</span>
                    <span className="sr">{t("nav.cartN", { n: cart })}</span>
                  </>
                )}
              </Link>
            )}

            {/* На телефоне видна только primary-кнопка, поэтому главным
                действием стоит вход и кабинет, а не выход. */}
            {signedIn ? (
              <UserMenu />
            ) : (
              <>
                <Link className="btn btn-outline btn-sm keep" href={loginHref(path)}>{t("nav.signin")}</Link>
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


/** Выпадающее меню уведомлений в шапке (макет № 11). Список подтягивается
 *  при открытии — шапка не делает лишних запросов на каждой странице. */
function BellMenu({ alerts }: { alerts: number }) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<MyNotification[] | null>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest(".ddwrap")) setOpen(false);
    };
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [open]);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && rows === null) {
      void publicApi
        .get<{ notifications: MyNotification[] }>("/api/public/me/notifications")
        .then((r) => setRows(r.notifications))
        .catch(() => setRows([]));
    }
    if (next) markAlertsSeen();
  };

  return (
    <span className="ddwrap">
      <button className="icon-link" type="button" aria-haspopup="menu" aria-expanded={open} onClick={toggle}>
        <Icon name="bell" size={22} />{t("nav.alerts")}
        {alerts > 0 && <span className="n" aria-hidden="true">{alerts}</span>}
      </button>
      {open && (
        <div className="ddown" role="menu" aria-label={t("nav.alerts")}>
          <div className="dd-h">
            <b>{t("nav.alerts")}</b>
          </div>
          {(rows ?? []).slice(0, 4).map((n) => (
            <div className="dd-row" key={n.id}>
              <span className="ic" aria-hidden="true">
                <Ph name={n.type === "outbid" ? "gavel" : n.type === "won" ? "check" : "bell"} size={14} />
              </span>
              <span className="t">
                <b>{n.subject}</b>
                <small>{n.body}</small>
              </span>
              <small className="when">{relTime(n.createdAt, t)}</small>
            </div>
          ))}
          {rows !== null && rows.length === 0 && <p className="dd-empty">{t("kb.emptyAlertsT")}</p>}
          <Link className="dd-all" href="/account?tab=bridinajumi" onClick={() => setOpen(false)}>
            {t("kb.allAlerts")}
          </Link>
        </div>
      )}
    </span>
  );
}

/** Меню аккаунта в шапке (макет № 11): разделы кабинета со счётчиками. */
function UserMenu() {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const [me, setMe] = useState<{ alias: string; email: string } | null>(null);
  const [counts, setCounts] = useState<{ bids: number; orders: number; pickup: number } | null>(null);

  // Буква на аватаре видна сразу, а не после первого клика.
  useEffect(() => {
    void publicApi
      .get<{ bidder: { alias: string; email: string } }>("/api/public/auth/me")
      .then((r) => setMe(r.bidder))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest(".ddwrap")) setOpen(false);
    };
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [open]);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && counts === null) {
      void Promise.all([
        publicApi.get<{ bids: Array<{ status: string }> }>("/api/public/me/bids").catch(() => ({ bids: [] })),
        publicApi.get<{ orders: Array<{ status: string }> }>("/api/public/me/orders").catch(() => ({ orders: [] })),
        publicApi.get<{ pickup: unknown[] }>("/api/public/me/pickup").catch(() => ({ pickup: [] })),
      ]).then(([b, o, p]) =>
        setCounts({
          bids: b.bids.filter((x) => x.status === "live").length,
          orders: o.orders.length,
          pickup: p.pickup.length,
        }),
      );
    }
  };

  const rows: Array<[string, string, number]> = [
    ["parskats", "ac.overview", 0],
    ["izsoles", "acc.myBids", counts?.bids ?? 0],
    ["pirkumi", "kb.purchases", counts?.orders ?? 0],
    ["velmes", "nav.watchlist", watchStore.list().length],
    ["bridinajumi", "nav.alerts", 0],
    ["iznemsana", "ac.pickup", counts?.pickup ?? 0],
    ["iestatijumi", "ac.settings", 0],
  ];

  return (
    <span className="ddwrap">
      <button className="ava-btn" type="button" aria-haspopup="menu" aria-expanded={open}
              aria-label={t("kb.accountMenu")} onClick={toggle}>
        {(me?.alias ?? "•").slice(0, 1).toUpperCase()}
      </button>
      {open && (
        <div className="ddown" role="menu" aria-label={t("kb.accountMenu")}>
          <div className="dd-h">
            <b>{me?.alias ?? ""}</b>
            <small>{me?.email ?? ""}</small>
          </div>
          {rows.map(([tab, key, n]) => (
            <Link className="dd-nav" key={tab} role="menuitem" onClick={() => setOpen(false)}
                  href={tab === "parskats" ? "/account" : `/account?tab=${tab}`}>
              <span>{t(key)}</span>
              {n > 0 && <span className="n">{n}</span>}
            </Link>
          ))}
          <button className="dd-nav out" type="button" role="menuitem"
                  onClick={() => {
                    publicApi.logout();
                    // Человек остаётся там, где был: уводить с карточки лота
                    // на главную при выходе — значит терять его. На главную —
                    // только со страниц, которых без входа не существует.
                    const p = window.location.pathname;
                    if (p.startsWith("/account") || p.startsWith("/apmaksa")) window.location.href = "/";
                    else window.location.reload();
                  }}>
            <Ph name="sign-out" size={15} /> {t("ac.signOutFull")}
          </button>
        </div>
      )}
    </span>
  );
}
