"use client";

/** Корзина — ОДИН список и ОДНА кнопка (макеты № 47 и 48).
 *
 *  Внутри живут лоты двух возрастов: отложенные (ещё не заказы; так кладёт
 *  гость и любой «Pievienot grozam») и неоплаченные заказы (выигранные торги
 *  и «Pirkt tagad»). Для человека это одна корзина, поэтому экран не делит
 *  её на два блока с двумя итогами: всё в одном списке с галочками, итог
 *  один, кнопка одна. Что она делает — зависит от того, кто нажал и что
 *  отмечено: гостя ведёт на вход (с резервом единиц на десять минут),
 *  вошедшему сперва превращает отмеченные отложенные лоты в заказы, затем
 *  отправляет всё отмеченное в оплату.
 *
 *  Заказы остаются раздельными — у каждого свой счёт, своя доставка и своя
 *  выдача. Общей становится только касса: провайдеру уходит одна сумма.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { publicApi, PublicApiError } from "@/lib/api";
import { cartCheckout, cartCheckoutStart, cartList, cartRemove, setCartCount, setCartItemsCount, type CartItem, type CartView } from "@/lib/cart";
import { useT } from "@/lib/i18n";
import { loginHref } from "@/lib/nav";
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
  /** Отмеченные к оплате: заказы — по номеру, отложенные лоты — по id продажи. */
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [pickedPending, setPickedPending] = useState<Set<string>>(new Set());
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
      .then((c) => {
        setCart(c);
        setCartItemsCount(c.count);
        // По умолчанию отмечено всё доступное.
        setPickedPending(new Set(c.items.filter((i) => i.available).map((i) => i.listingId)));
      })
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

  /* Таймер резерва: с нажатия кнопки одна единица каждого отложенного лота
   * держится за человеком десять минут — чтобы вход или регистрация не
   * стоили ему выбранного. Вышло время — резерв снят сервером сам. */
  const [reservedUntil, setReservedUntil] = useState<number | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!cart) return;
    const mine = cart.items.map((i) => i.reservedUntil).filter((v): v is number => v !== null && v > Date.now());
    setReservedUntil(mine.length > 0 ? Math.min(...mine) : null);
  }, [cart]);
  useEffect(() => {
    if (!reservedUntil) return;
    const timer = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [reservedUntil]);
  const reserveLeftMs = reservedUntil ? reservedUntil - nowMs : 0;
  useEffect(() => {
    if (reservedUntil && reserveLeftMs <= 0) {
      setReservedUntil(null);
      load();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reservedUntil, reserveLeftMs]);
  const mmss = (ms: number) => {
    const total = Math.max(Math.floor(ms / 1000), 0);
    return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
  };

  if (orders === null || cart === null) return <section className="wrap" style={{ paddingTop: 24 }} aria-busy="true" />;

  const pending = cart.items;
  const chosenPending = pending.filter((i) => i.available && pickedPending.has(i.listingId));
  const chosenOrders = orders.filter((o) => picked.has(o.ref));
  const chosenCount = chosenPending.length + chosenOrders.length;

  const shipCents = chosenOrders.reduce((sum, o) => sum + o.shippingCents + o.handlingCents, 0);
  const totalCents =
    chosenPending.reduce((sum, i) => sum + i.totalCents, 0) +
    chosenOrders.reduce((sum, o) => sum + o.totalCents, 0);
  const goodsCents = totalCents - shipCents;

  /** Галочка на заказе или отложенном лоте: снял — remove_from_cart, вернул —
   *  add_to_cart один раз на лот (отметка не даёт раздуть воронку). */
  const cartPulse = (on: boolean, key: string, e: { netCents: number; grossCents: number; commissionCents: number; item: unknown }, sizeAfter: number, grossAfter: number) => {
    const params = {
      value: e.netCents / 100, currency: "EUR",
      gross_total: e.grossCents / 100,
      commission_value: e.commissionCents / 100,
      vat_scheme: "standard",
      cart_size: sizeAfter,
      cart_gross_total: grossAfter / 100,
      ecommerce: { currency: "EUR", value: e.netCents / 100, items: [e.item] },
    };
    if (on) addToCartOnce(key, params);
    else track("remove_from_cart", params);
  };

  const toggleOrder = (ref: string) => {
    const next = new Set(picked);
    const on = !next.has(ref);
    if (on) next.add(ref); else next.delete(ref);
    const o = orders.find((x) => x.ref === ref);
    if (o) {
      const after = orders.filter((x) => next.has(x.ref));
      const grossAfter = after.reduce((s, x) => s + x.totalCents, 0) + chosenPending.reduce((s, i) => s + i.totalCents, 0);
      cartPulse(on, o.ref, orderEcom(o), after.length + chosenPending.length, grossAfter);
    }
    setPicked(next);
  };

  const togglePending = (i: CartItem) => {
    const next = new Set(pickedPending);
    const on = !next.has(i.listingId);
    if (on) next.add(i.listingId); else next.delete(i.listingId);
    const after = pending.filter((x) => x.available && next.has(x.listingId));
    const grossAfter = after.reduce((s, x) => s + x.totalCents, 0) + chosenOrders.reduce((s, o) => s + o.totalCents, 0);
    cartPulse(on, `listing:${i.listingId}`, itemEcom(i), after.length + chosenOrders.length, grossAfter);
    setPickedPending(next);
  };

  /**
   * Единственная кнопка корзины.
   *
   * Гость: резерв единиц + вход с возвратом сюда. Вошедший: отмеченные
   * отложенные лоты превращаются в заказы, затем всё отмеченное уходит в
   * оплату — один лот на страницу оплаты, несколько одним платежом.
   * InitiateCheckout — один раз на checkout-сессию, каким бы путём она
   * ни продолжилась.
   */
  const proceed = () => {
    if (chosenCount === 0) return;
    const ecs = [...chosenPending.map(itemEcom), ...chosenOrders.map(orderEcom)];
    const net = ecs.reduce((s, e) => s + e.netCents, 0);
    const orderRefs = chosenOrders.map((o) => o.ref);
    const coId = chosenPending.length > 0 ? checkoutId() : `group:${[...orderRefs].sort().join("+")}`;
    beginCheckoutOnce(coId, {
      ...adsUserData({ email: meContact?.email, name: meContact?.name }),
      value: net / 100, currency: "EUR", cart_size: ecs.length,
      checkout_id: coId,
      gross_total: totalCents / 100, cart_gross_total: totalCents / 100,
      commission_value: ecs.reduce((s, e) => s + e.commissionCents, 0) / 100,
      ecommerce: { currency: "EUR", value: net / 100, items: ecs.map((e) => e.item) },
    });

    if (!signedIn) {
      // Резерв — и на вход: по одной единице на лот, десять минут.
      void cartCheckoutStart()
        .then((r) => { if (r.reservedUntil) setReservedUntil(r.reservedUntil); })
        .catch(() => undefined)
        .finally(() => router.push(loginHref("/grozs")));
      return;
    }

    setBusy(true);
    const toPay = (refs: string[]) => {
      if (refs.length === 0) { setBusy(false); load(); return; }
      if (refs.length === 1) {
        window.location.assign(`/apmaksa/${encodeURIComponent(refs[0]!)}`);
        return;
      }
      void publicApi
        .post<{ checkoutUrl: string }>("/api/public/orders/pay-group", { refs, language: lang })
        .then((r) => window.location.assign(r.checkoutUrl))
        .catch((e: unknown) => {
          setBusy(false);
          load();
          say(e instanceof PublicApiError && e.status === 503 ? t("acc.payUnavailable") : t("acc.payFailed"));
        });
    };

    if (chosenPending.length === 0) {
      toPay(orderRefs);
      return;
    }
    void cartCheckout(chosenPending.map((i) => i.listingId))
      .then((r) => {
        if (r.unavailable && r.unavailable.length > 0) say(t("cart.gone"));
        // Страница оплаты не должна отправлять второй InitiateCheckout той
        // же сессии — заказы из этой корзины уже учтены.
        for (const o of r.orders) markBeginCheckout(o.ref);
        clearCheckoutId();
        toPay([...r.orders.map((o) => o.ref), ...orderRefs]);
      })
      .catch((e: unknown) => {
        setBusy(false);
        if (e instanceof PublicApiError && e.body.code === "EMAIL_NOT_VERIFIED") say(t("lc.verifyFirst"));
        else if (e instanceof PublicApiError && e.body.code === "FEES_OUTSTANDING") say(t("fees.blockedShort"));
        else if (e instanceof PublicApiError && e.body.code === "BIDDER_BLOCKED") say(t("buy.blocked"));
        else say(t("acc.payFailed"));
      });
  };

  const empty = orders.length === 0 && pending.length === 0;

  return (
    <section className="wrap" style={{ paddingTop: 24 }}>
      <div className="page-head" style={{ alignItems: "flex-start" }}>
        <div>
          <h1 data-hero>{t("cart.title")}</h1>
          <p className="cnt">{t("cart.subG", { n: pending.filter((i) => i.available).length + orders.length })}</p>
        </div>
      </div>

      {empty ? (
        <div className="empty">
          <span className="ic" aria-hidden="true"><Ph name="package" size={22} /></span>
          <h3>{signedIn ? t("cart.emptyT") : t("cart.emptyG")}</h3>
          <p>{signedIn ? t("cart.emptyD") : t("cart.emptyGD")}</p>
          <Link className="btn btn-primary" href="/katalogs?type=fixed">{t("kb.findLots")}</Link>
        </div>
      ) : (
        <div className="cart-cols">
          <div className="cart-main">
            {/* Отложенные лоты — станут заказами при оформлении. */}
            {pending.map((i) => (
              <div className="cart-row" key={i.listingId} style={i.available ? undefined : { opacity: .55 }}>
                <label className="cart-tick">
                  <input type="checkbox" disabled={!i.available}
                         checked={i.available && pickedPending.has(i.listingId)}
                         onChange={() => togglePending(i)} />
                  <span className="sr">{i.title}</span>
                </label>
                <span className="t">
                  <b>{i.title}</b>
                  <small>{i.sku} · {t("bn.vat")} {formatEur(i.vatCents)} · 1 gab.</small>
                  {!i.available && <small style={{ color: "var(--live)" }}>{t("cart.gone")}</small>}
                  {i.priceChanged && <small style={{ color: "var(--live)" }}>{t("cart.priceChanged")}</small>}
                  {i.available && i.reservedUntil !== null && i.reservedUntil > nowMs && (
                    <small style={{ color: "var(--brand)", fontWeight: 600 }} suppressHydrationWarning>
                      {t("cart.rowReserved", { t: mmss(i.reservedUntil - nowMs) })}
                    </small>
                  )}
                </span>
                <b className="sum tnum">{formatEur(i.totalCents)}</b>
                <button className="btn btn-outline btn-sm" type="button"
                        aria-label={`${t("cart.remove")}: ${i.title}`}
                        onClick={() => removeItem(i)}>{t("cart.remove")}</button>
              </div>
            ))}

            {/* Неоплаченные заказы — доставка уже выбрана или ждёт выбора. */}
            {orders.map((o) => (
              /* Строка не <label> целиком: внутри есть ссылка «Mainīt», а клик
                 по ней не должен заодно снимать галочку. */
              <div className="cart-row" key={o.ref}>
                <label className="cart-tick">
                  <input type="checkbox" checked={picked.has(o.ref)} onChange={() => toggleOrder(o.ref)} />
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

            {!signedIn && <p className="note">{t("cart.signinNote")}</p>}
            {signedIn && orders.length > 0 && <p className="note">{t("cart.note")}</p>}
          </div>

          <aside className="cart-side">
            <p className="g-lbl">{t("cart.summary")}</p>
            <table className="fees"><tbody>
              <tr><th scope="row">{t("cart.lotsN", { n: chosenCount })}</th>
                <td className="tnum">{formatEur(goodsCents)}</td></tr>
              {shipCents > 0 && (
                <tr><th scope="row">{t("f.delivery")}</th><td className="tnum">{formatEur(shipCents)}</td></tr>
              )}
              <tr className="tot"><th scope="row">{t("bn.total")}</th><td className="tnum">{formatEur(totalCents)}</td></tr>
            </tbody></table>
            <button className="btn btn-primary" type="button" disabled={busy || chosenCount === 0} onClick={proceed}>
              {signedIn ? t("cart.pay", { sum: formatEur(totalCents) }) : t("cart.checkout")}
            </button>
            {chosenPending.length > 0 && <p className="note">{t("cart.shipLater")}</p>}
            {chosenCount > 1 && <p className="note">{t("cart.oneCharge")}</p>}
            <p className="note">{t("bn.noPremium")}</p>
          </aside>
        </div>
      )}
    </section>
  );
}
