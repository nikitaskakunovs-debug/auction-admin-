"use client";

/** Корзина: несколько выигранных лотов одним платежом (макеты № 47 и 48).
 *
 *  Заказы остаются раздельными — у каждого свой счёт, своя доставка и своя
 *  выдача. Общей становится только касса: провайдеру уходит одна сумма.
 *  Поэтому здесь нет выбора доставки: её выбирают в оплате каждого лота, а
 *  экран честно показывает, что уже выбрано и сколько это стоит.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { publicApi, PublicApiError } from "@/lib/api";
import { cartCheckout, cartList, cartRemove, setCartCount, setCartItemsCount, type CartItem, type CartView } from "@/lib/cart";
import { useT } from "@/lib/i18n";
import { loginHref } from "@/lib/nav";
import { photoThumb } from "@/lib/photos";
import { addToCartOnce, adsUserData, beginCheckoutOnce, gaItem, markBeginCheckout, orderEcom, track } from "@/lib/track";
import { formatEur, type MyOrder } from "@/lib/types";
import { Ph } from "./Ph";
import { say } from "./Toast";

/** Идентификатор checkout-сессии гостевой корзины. Живёт во вкладке до
 *  превращения корзины в заказы: уход на вход и возврат обратно, обновление
 *  страницы — та же сессия, и InitiateCheckout по ней уходит один раз. */
const CHECKOUT_KEY = "izsoli_checkout_v1";
function checkoutId(): string {
  try {
    let v = sessionStorage.getItem(CHECKOUT_KEY);
    if (!v) {
      v = `co-${crypto.randomUUID()}`;
      sessionStorage.setItem(CHECKOUT_KEY, v);
    }
    return v;
  } catch {
    return "co-fallback";
  }
}
function clearCheckoutId(): void {
  try { sessionStorage.removeItem(CHECKOUT_KEY); } catch { /* нет хранилища */ }
}

/** Товарная строка аналитики из серверного лота корзины: все суммы движка. */
function itemEcom(i: CartItem) {
  const netCents = i.hammerCents + i.premiumCents;
  return {
    netCents,
    grossCents: i.totalCents,
    commissionCents: i.premiumCents,
    item: gaItem({
      sku: i.sku, listingId: i.listingId, name: i.title, category: i.category,
      netCents, hammerCents: i.hammerCents, feeCents: i.premiumCents,
      vatRateBp: i.vatRateBp, grossCents: i.totalCents,
    }),
  };
}

export function Cart() {
  const { t, lang } = useT();
  const router = useRouter();
  const [orders, setOrders] = useState<MyOrder[] | null>(null);
  const [cart, setCart] = useState<CartView | null>(null);
  const [signedIn, setSignedIn] = useState(publicApi.hasSession);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  /** Контакт для Google Ads Enhanced Conversions — только при согласии. */
  const [meContact, setMeContact] = useState<{ email: string; name: string | null } | null>(null);

  useEffect(() => {
    void publicApi
      .get<{ bidder: { email: string; name: string | null } }>("/api/public/auth/me")
      .then((r) => setMeContact({ email: r.bidder.email, name: r.bidder.name }))
      .catch(() => undefined);
  }, []);

  const load = useCallback(() => {
    setSignedIn(publicApi.hasSession);
    // Отложенные лоты — у всех: гостевая корзина живёт на сервере.
    void cartList()
      .then((c) => { setCart(c); setCartItemsCount(c.count); })
      .catch(() => setCart({ items: [], count: 0, totalCents: 0 }));
    if (!publicApi.hasSession) {
      setOrders([]);
      setCartCount(0);
      return;
    }
    void publicApi
      .get<{ orders: MyOrder[] }>("/api/public/me/orders")
      .then((r) => {
        const unpaid = r.orders.filter((o) => o.status === "awaiting_payment");
        setOrders(unpaid);
        setCartCount(unpaid.length);
        // По умолчанию отмечено всё: чаще всего человек платит за всё сразу.
        setPicked(new Set(unpaid.map((o) => o.ref)));
      })
      .catch(() => setOrders([]));
  }, []);
  useEffect(load, [load]);

  // Аналитика (GTM): просмотр корзины — отложенные лоты и неоплаченные заказы
  // вместе, один раз на открытие страницы. value — «лот + комиссия» без НДС.
  const sawCart = useRef(false);
  useEffect(() => {
    if (sawCart.current || orders === null || cart === null) return;
    const avail = cart.items.filter((i) => i.available);
    const ecs = [...avail.map(itemEcom), ...orders.map(orderEcom)];
    if (ecs.length === 0) return;
    sawCart.current = true;
    const net = ecs.reduce((s, e) => s + e.netCents, 0);
    const gross = ecs.reduce((s, e) => s + e.grossCents, 0) / 100;
    track("view_cart", {
      value: net / 100, currency: "EUR",
      gross_total: gross, cart_gross_total: gross, cart_size: ecs.length,
      ecommerce: { currency: "EUR", value: net / 100, items: ecs.map((e) => e.item) },
    });
  }, [orders, cart]);

  /** Убрать отложенный лот — явное действие человека, корзину иначе не чистим. */
  const removeItem = (i: CartItem) => {
    void cartRemove(i.listingId)
      .then(() => {
        const e = itemEcom(i);
        track("remove_from_cart", {
          value: e.netCents / 100, currency: "EUR",
          gross_total: e.grossCents / 100,
          commission_value: e.commissionCents / 100,
          vat_scheme: "standard",
          ecommerce: { currency: "EUR", value: e.netCents / 100, items: [e.item] },
        });
        load();
      })
      .catch(() => say(t("acc.payFailed")));
  };

  /**
   * «Noformēt pasūtījumu»: гостя отправляем на вход с возвратом сюда — его
   * корзина никуда не денется, она на сервере. Вошедшему корзина
   * превращается в заказы; лот, уже ушедший другому, к оплате не попадает,
   * и об этом говорится прямо.
   */
  const [checkingOut, setCheckingOut] = useState(false);
  const checkoutCart = () => {
    if (!cart) return;
    const avail = cart.items.filter((i) => i.available);
    if (avail.length === 0) return;
    // InitiateCheckout — один раз на checkout-сессию: возврат со входа или
    // обновление страницы события не повторяют.
    const coId = checkoutId();
    const ecs = avail.map(itemEcom);
    const net = ecs.reduce((s, e) => s + e.netCents, 0);
    const gross = ecs.reduce((s, e) => s + e.grossCents, 0) / 100;
    beginCheckoutOnce(coId, {
      ...adsUserData({ email: meContact?.email, name: meContact?.name }),
      value: net / 100, currency: "EUR", cart_size: avail.length,
      checkout_id: coId,
      gross_total: gross, cart_gross_total: gross,
      commission_value: ecs.reduce((s, e) => s + e.commissionCents, 0) / 100,
      ecommerce: { currency: "EUR", value: net / 100, items: ecs.map((e) => e.item) },
    });
    if (!signedIn) {
      router.push(loginHref("/grozs"));
      return;
    }
    setCheckingOut(true);
    void cartCheckout()
      .then((r) => {
        if (r.unavailable && r.unavailable.length > 0) say(t("cart.gone"));
        // Страница оплаты не должна отправлять второй InitiateCheckout той
        // же сессии — заказы из этой корзины уже учтены.
        for (const o of r.orders) markBeginCheckout(o.ref);
        clearCheckoutId();
        if (r.orders.length === 1 && (orders?.length ?? 0) === 0) {
          window.location.assign(`/apmaksa/${encodeURIComponent(r.orders[0]!.ref)}`);
          return;
        }
        setCheckingOut(false);
        load();
      })
      .catch((e: unknown) => {
        setCheckingOut(false);
        if (e instanceof PublicApiError && e.body.code === "EMAIL_NOT_VERIFIED") say(t("lc.verifyFirst"));
        else if (e instanceof PublicApiError && e.body.code === "FEES_OUTSTANDING") say(t("fees.blockedShort"));
        else if (e instanceof PublicApiError && e.body.code === "BIDDER_BLOCKED") say(t("buy.blocked"));
        else say(t("acc.payFailed"));
      });
  };

  if (orders === null || cart === null) return <section className="wrap" style={{ paddingTop: 24 }} aria-busy="true" />;
  const pending = cart.items;
  const pendingAvail = pending.filter((i) => i.available);

  const chosen = orders.filter((o) => picked.has(o.ref));
  const totalCents = chosen.reduce((sum, o) => sum + o.totalCents, 0);
  const shipCents = chosen.reduce((sum, o) => sum + o.shippingCents + o.handlingCents, 0);
  const goodsCents = totalCents - shipCents;

  const toggle = (ref: string) => {
    const next = new Set(picked);
    if (next.has(ref)) {
      next.delete(ref);
      // Аналитика (GTM): лот снят с общей оплаты; корзина — после удаления.
      const o = orders.find((x) => x.ref === ref);
      if (o) {
        const e = orderEcom(o);
        const chosenAfter = orders.filter((x) => next.has(x.ref));
        track("remove_from_cart", {
          value: e.netCents / 100, currency: "EUR",
          gross_total: e.grossCents / 100,
          commission_value: e.commissionCents / 100,
          vat_scheme: e.vatScheme,
          cart_size: chosenAfter.length,
          cart_gross_total: chosenAfter.reduce((s, x) => s + x.totalCents, 0) / 100,
          ecommerce: { currency: "EUR", value: e.netCents / 100, items: [e.item] },
        });
      }
    } else {
      next.add(ref);
      // Аналитика (GTM): лот отмечен к общей оплате. Верхние параметры —
      // про ОТМЕЧЕННЫЙ лот и явно в каждом событии: GTM помнит значения
      // прошлых пушей, и без явной перезаписи сюда подмешивался gross_total
      // всей корзины из view_cart. Корзина целиком — отдельными полями.
      //
      // Один раз на лот: в корзину он попал раньше — при победе на торгах
      // или нажатии «Pirkt tagad», — и там add_to_cart уже был. Снять и
      // вернуть галочку — это выбор способа оплаты, а не второе добавление,
      // и считать его второй раз значило бы раздувать воронку Meta и Google.
      const o = orders.find((x) => x.ref === ref);
      if (o) {
        const e = orderEcom(o);
        const chosenAfter = orders.filter((x) => next.has(x.ref));
        addToCartOnce(o.ref, {
          value: e.netCents / 100, currency: "EUR",
          gross_total: e.grossCents / 100,
          commission_value: e.commissionCents / 100,
          vat_scheme: e.vatScheme,
          cart_size: chosenAfter.length,
          cart_gross_total: chosenAfter.reduce((s, x) => s + x.totalCents, 0) / 100,
          ecommerce: { currency: "EUR", value: e.netCents / 100, items: [e.item] },
        });
      }
    }
    setPicked(next);
  };

  const pay = () => {
    const refs = chosen.map((o) => o.ref);
    if (refs.length === 0) return;
    // Один лот — обычная оплата: незачем городить группу из одного.
    if (refs.length === 1) { window.location.assign(`/apmaksa/${encodeURIComponent(refs[0]!)}`); return; }
    setBusy(true);
    // Аналитика (GTM): оплата корзины началась — все выбранные лоты.
    const ecs = chosen.map(orderEcom);
    const net = ecs.reduce((s, e) => s + e.netCents, 0);
    // Один раз на состав группы: возврат с оплаты и повторное нажатие не
    // рождают второй InitiateCheckout той же сессии.
    beginCheckoutOnce(`group:${[...refs].sort().join("+")}`, {
      ...adsUserData({ email: meContact?.email, name: meContact?.name }),
      value: net / 100, currency: "EUR", cart_size: refs.length,
      gross_total: totalCents / 100, cart_gross_total: totalCents / 100,
      commission_value: ecs.reduce((s, e) => s + e.commissionCents, 0) / 100,
      ecommerce: { currency: "EUR", value: net / 100, items: ecs.map((e) => e.item) },
    });
    void publicApi
      .post<{ checkoutUrl: string }>("/api/public/orders/pay-group", { refs, language: lang })
      .then((r) => window.location.assign(r.checkoutUrl))
      .catch((e: unknown) => {
        setBusy(false);
        say(e instanceof PublicApiError && e.status === 503 ? t("acc.payUnavailable") : t("acc.payFailed"));
      });
  };

  return (
    <section className="wrap" style={{ paddingTop: 24 }}>
      <div className="page-head" style={{ alignItems: "flex-start" }}>
        <div>
          <h1 data-hero>{t("cart.title")}</h1>
          <p className="cnt">{orders.length > 0 ? t("cart.sub", { n: orders.length }) : t("cart.subG", { n: pendingAvail.length })}</p>
        </div>
      </div>

      {orders.length === 0 && pending.length === 0 ? (
        <div className="empty">
          <span className="ic" aria-hidden="true"><Ph name="package" size={22} /></span>
          <h3>{signedIn ? t("cart.emptyT") : t("cart.emptyG")}</h3>
          <p>{signedIn ? t("cart.emptyD") : t("cart.emptyGD")}</p>
          <Link className="btn btn-primary" href="/katalogs?type=fixed">{t("kb.findLots")}</Link>
        </div>
      ) : null}

      {/* ── Отложенные лоты: серверная корзина, работает и без входа ── */}
      {pending.length > 0 && (
        <div className="cart-cols" style={{ marginBottom: orders.length > 0 ? 32 : 0 }}>
          <div className="cart-main">
            {pending.map((i) => (
              <div className="cart-row" key={i.listingId} style={i.available ? undefined : { opacity: .55 }}>
                <span className="cart-pic" aria-hidden="true">
                  {i.photo ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={photoThumb(i.photo)} alt="" loading="lazy"
                         style={{ width: 48, height: 48, objectFit: "cover", borderRadius: 8 }} />
                  ) : <Ph name="package" size={22} />}
                </span>
                <span className="t">
                  <b>{i.title}</b>
                  <small>{i.sku} · {t("bn.vat")} {formatEur(i.vatCents)} · 1 gab.</small>
                  {!i.available && <small style={{ color: "var(--live)" }}>{t("cart.gone")}</small>}
                  {i.priceChanged && <small style={{ color: "var(--live)" }}>{t("cart.priceChanged")}</small>}
                </span>
                <b className="sum tnum">{formatEur(i.totalCents)}</b>
                <button className="btn btn-outline btn-sm" type="button"
                        aria-label={`${t("cart.remove")}: ${i.title}`}
                        onClick={() => removeItem(i)}>{t("cart.remove")}</button>
              </div>
            ))}
            {!signedIn && <p className="note">{t("cart.signinNote")}</p>}
          </div>

          <aside className="cart-side">
            <p className="g-lbl">{t("cart.summary")}</p>
            <table className="fees"><tbody>
              <tr><th scope="row">{t("cart.lotsN", { n: pendingAvail.length })}</th>
                <td className="tnum">{formatEur(cart.totalCents)}</td></tr>
              <tr className="tot"><th scope="row">{t("bn.total")}</th>
                <td className="tnum">{formatEur(cart.totalCents)}</td></tr>
            </tbody></table>
            <button className="btn btn-primary" type="button"
                    disabled={checkingOut || pendingAvail.length === 0} onClick={checkoutCart}>
              {t("cart.checkout")}
            </button>
            <p className="note">{t("bn.noPremium")}</p>
          </aside>
        </div>
      )}

      {orders.length > 0 && (
        <div className="cart-cols">
          <div className="cart-main">
            {orders.map((o) => (
              /* Строка не <label> целиком: внутри есть ссылка «Mainīt», а клик
                 по ней не должен заодно снимать галочку. */
              <div className="cart-row" key={o.ref}>
                <label className="cart-tick">
                  <input type="checkbox" checked={picked.has(o.ref)} onChange={() => toggle(o.ref)} />
                  <span className="sr">{o.itemTitle}</span>
                </label>
                <span className="t">
                  <b>{o.itemTitle}</b>
                  <small>{o.itemSku} · {o.ref}</small>
                  <small>
                    {o.fulfilment === "pickup" ? t("acc.deliveryPickup") : t("f.delivery")}
                    {o.shippingCents + o.handlingCents > 0 ? ` · ${formatEur(o.shippingCents + o.handlingCents)}` : ` · ${t("co.free")}`}
                    {" · "}
                    <Link href={`/apmaksa/${encodeURIComponent(o.ref)}`}>{t("ac.change")}</Link>
                  </small>
                </span>
                <b className="sum tnum">{formatEur(o.totalCents)}</b>
              </div>
            ))}
            <p className="note">{t("cart.note")}</p>
          </div>

          <aside className="cart-side">
            <p className="g-lbl">{t("cart.summary")}</p>
            <table className="fees"><tbody>
              <tr><th scope="row">{t("cart.lotsN", { n: chosen.length })}</th><td className="tnum">{formatEur(goodsCents)}</td></tr>
              <tr><th scope="row">{t("f.delivery")}</th>
                <td className="tnum">{shipCents === 0 ? t("co.free") : formatEur(shipCents)}</td></tr>
              <tr className="tot"><th scope="row">{t("bn.total")}</th><td className="tnum">{formatEur(totalCents)}</td></tr>
            </tbody></table>
            <button className="btn btn-primary" type="button" disabled={busy || chosen.length === 0} onClick={pay}>
              {t("cart.pay", { sum: formatEur(totalCents) })}
            </button>
            <p className="note">{t("cart.oneCharge")}</p>
          </aside>
        </div>
      )}
    </section>
  );
}
