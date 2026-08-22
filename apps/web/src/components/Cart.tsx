"use client";

/** Корзина: несколько выигранных лотов одним платежом (макеты № 47 и 48).
 *
 *  Заказы остаются раздельными — у каждого свой счёт, своя доставка и своя
 *  выдача. Общей становится только касса: провайдеру уходит одна сумма.
 *  Поэтому здесь нет выбора доставки: её выбирают в оплате каждого лота, а
 *  экран честно показывает, что уже выбрано и сколько это стоит.
 */

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { publicApi, PublicApiError } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { orderEcom, track } from "@/lib/track";
import { formatEur, type MyOrder } from "@/lib/types";
import { Ph } from "./Ph";
import { say } from "./Toast";

export function Cart() {
  const { t, lang } = useT();
  const [orders, setOrders] = useState<MyOrder[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    void publicApi
      .get<{ orders: MyOrder[] }>("/api/public/me/orders")
      .then((r) => {
        const unpaid = r.orders.filter((o) => o.status === "awaiting_payment");
        setOrders(unpaid);
        // По умолчанию отмечено всё: чаще всего человек платит за всё сразу.
        setPicked(new Set(unpaid.map((o) => o.ref)));
        // Аналитика (GTM): просмотр корзины со всеми неоплаченными лотами.
        // value — сумма «лот + комиссия» без НДС, ровно Σ items[].price.
        if (unpaid.length > 0) {
          const ecs = unpaid.map(orderEcom);
          const net = ecs.reduce((s, e) => s + e.netCents, 0);
          const gross = ecs.reduce((s, e) => s + e.grossCents, 0) / 100;
          track("view_cart", {
            value: net / 100, currency: "EUR",
            gross_total: gross, cart_gross_total: gross, cart_size: unpaid.length,
            ecommerce: { currency: "EUR", value: net / 100, items: ecs.map((e) => e.item) },
          });
        }
      })
      .catch(() => setOrders([]));
  }, []);
  useEffect(load, [load]);

  if (orders === null) return <section className="wrap" style={{ paddingTop: 24 }} aria-busy="true" />;

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
      // Аналитика (GTM): лот добавлен к общей оплате. Верхние параметры —
      // про ДОБАВЛЕННЫЙ лот и явно в каждом событии: GTM помнит значения
      // прошлых пушей, и без явной перезаписи сюда подмешивался gross_total
      // всей корзины из view_cart. Корзина целиком — отдельными полями.
      const o = orders.find((x) => x.ref === ref);
      if (o) {
        const e = orderEcom(o);
        const chosenAfter = orders.filter((x) => next.has(x.ref));
        track("add_to_cart", {
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
    track("begin_checkout", {
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
          <p className="cnt">{t("cart.sub", { n: orders.length })}</p>
        </div>
      </div>

      {orders.length === 0 ? (
        <div className="empty">
          <span className="ic" aria-hidden="true"><Ph name="package" size={22} /></span>
          <h3>{t("cart.emptyT")}</h3>
          <p>{t("cart.emptyD")}</p>
          <Link className="btn btn-primary" href="/katalogs">{t("kb.findLots")}</Link>
        </div>
      ) : (
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
