"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { publicApi, PublicApiError } from "@/lib/api";
import { dateLocale, useT } from "@/lib/i18n";
import { useStickyBar } from "@/lib/ui";
import { formatEur, type MyOrder, type ShippingOption } from "@/lib/types";
import { Icon } from "./Icon";
import { KlixPayLater } from "./KlixPayLater";
import { ParcelPicker } from "./ParcelPicker";
import { say } from "./Toast";

/** Страница оплаты утверждённого макета: доставка, способ оплаты, получатель
 *  и сводка заказа справа. Данные и цены — из движка; выбор доставки
 *  пересчитывает заказ на сервере. */
const PAY_METHODS: Array<[string, string, string, string]> = [
  ["klix", "co.card", "co.cardD", "card"],
  ["inbank", "co.instal", "co.instalD", "home"],
];

export function Checkout({ orderRef }: { orderRef: string }) {
  const { t, lang } = useT();
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [order, setOrder] = useState<MyOrder | null>(null);
  const [options, setOptions] = useState<ShippingOption[]>([]);
  const [method, setMethod] = useState("pickup");
  const [machineId, setMachineId] = useState("");
  const [machineName, setMachineName] = useState("");
  const [pay, setPay] = useState("klix");
  const [phone, setPhone] = useState("");
  const [terms, setTerms] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [payVisible, setPayVisible] = useState(true);
  const payBox = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await publicApi.get<{ orders: MyOrder[] }>("/api/public/me/orders");
      const found = r.orders.find((o) => o.ref === orderRef) ?? null;
      setOrder(found);
      if (found) {
        setMethod(found.fulfilment);
        setMachineId(found.shippingTo?.machineId ?? "");
      }
    } catch { setOrder(null); }
  }, [orderRef]);

  useEffect(() => {
    setSignedIn(publicApi.hasSession);
    const fn = () => setSignedIn(publicApi.hasSession);
    publicApi.listeners.add(fn);
    return () => { publicApi.listeners.delete(fn); };
  }, []);

  useEffect(() => { if (signedIn) void load(); }, [signedIn, load]);

  useEffect(() => {
    void publicApi.get<{ options: ShippingOption[] }>("/api/public/shipping/options?market=LV")
      .then((r) => setOptions(r.options))
      .catch(() => setOptions([{ method: "pickup", priceCents: 0, handlingCents: 0 }]));
  }, []);

  const provider = method === "dpd_pm" ? "dpd" : method === "omniva_pm" ? "omniva" : null;


  const saveDelivery = async (next: string, machine: string) => {
    setBusy(true); setError(null);
    try {
      await publicApi.post(`/api/public/orders/${encodeURIComponent(orderRef)}/fulfilment`, {
        method: next,
        ...(next === "pickup" ? {} : { machineId: machine, recipientPhone: phone }),
      });
      await load();
      say(t("co.deliverySaved"));
    } catch (err) {
      setError(err instanceof Error ? err.message : "error");
    } finally { setBusy(false); }
  };

  const startPayment = async () => {
    setBusy(true); setError(null);
    try {
      const r = await publicApi.post<{ checkoutUrl: string }>(
        `/api/public/orders/${encodeURIComponent(orderRef)}/pay`,
        { language: lang, provider: pay },
      );
      setSubmitted(true);
      window.location.assign(r.checkoutUrl);
    } catch (err) {
      setBusy(false);
      setError(err instanceof PublicApiError && err.status === 503
        ? t("acc.payUnavailable") : t("acc.payFailed"));
    }
  };

  // Липкая кнопка оплаты на телефоне — пока сводка не на экране.
  useEffect(() => {
    const el = payBox.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(([e]) => setPayVisible(!!e?.isIntersecting), { threshold: 0.2 });
    io.observe(el);
    return () => io.disconnect();
  }, [order, submitted]);

  const paid = order
    ? order.status === "paid" || order.status === "collected" || order.status === "shipped"
    : false;
  // Хук должен вызываться до любых ранних возвратов, иначе порядок хуков плывёт.
  useStickyBar(!!order && !paid && !submitted && !payVisible);

  if (signedIn === false) {
    return (
      <section className="wrap" style={{ paddingTop: 24 }}>
        <div className="empty">
          <span className="ic" aria-hidden="true"><Icon name="shield" /></span>
          <h3>{t("a.signinToBid")}</h3>
          <Link className="btn btn-primary" href="/login">{t("nav.signin")}</Link>
        </div>
      </section>
    );
  }

  if (!order) {
    return (
      <section className="wrap" style={{ paddingTop: 24 }}>
        <div className="empty">
          <span className="ic" aria-hidden="true"><Icon name="search" /></span>
          <h3>{t("co.notFound")}</h3>
          <p>{t("co.notFoundD")}</p>
          <Link className="btn btn-primary" href="/account">{t("co.myOrders")}</Link>
        </div>
      </section>
    );
  }

  // Итог пересчитываем сразу при выборе способа: цену берём из тарифов,
  // а не ждём сохранения на сервере — как в макете.
  const chosen = options.find((o) => o.method === method);
  const shipCost = chosen ? chosen.priceCents + chosen.handlingCents : order.shippingCents + order.handlingCents;
  const total = order.hammerCents + order.premiumCents + order.vatCents + shipCost;

  return (
    <section className="wrap" style={{ paddingTop: 24 }}>
      <nav className="crumbs" aria-label={t("nav.breadcrumb")}>
        <ol>
          <li><Link href="/">{t("nav.home")}</Link></li>
          <li><Link href="/account">{t("co.myBids")}</Link></li>
          <li aria-current="page">{t("co.title")}</li>
        </ol>
      </nav>

      <div className="page-head" hidden={paid || submitted}>
        <div>
          <h1 data-hero>{t("co.title")}</h1>
          <p className="cnt">
            {t("co.wonLot", { sku: order.itemSku })}
            {order.paymentDeadlineAt && !paid &&
              t("co.payBy", { date: new Date(order.paymentDeadlineAt).toLocaleDateString(dateLocale(lang)) })}
          </p>
        </div>
      </div>

      {paid || submitted ? (
        <div className="done">
          <span className="ic" aria-hidden="true"><Icon name="check" /></span>
          <h2>{t("co.thanks")}</h2>
          <p className="lead">{t("co.thanksD")}</p>
          <div className="done-acts">
            <Link className="btn btn-dark" href="/katalogs">{t("co.keepBidding")}</Link>
            <Link className="btn btn-outline" href="/">{t("co.toHome")}</Link>
          </div>
        </div>
      ) : (
        <form className="pay" onSubmit={(e) => {
          e.preventDefault();
          if (!terms) { say(t("co.confirmTerms")); return; }
          if (provider && !machineId) { say(t("co.pickParcel")); return; }
          say(t("co.processing"));
          // Сначала фиксируем доставку на сервере — он пересчитывает заказ,
          // и только потом уходим на оплату уже с итоговой суммой.
          void saveDelivery(method, machineId).then(() => startPayment());
        }}>
          <div className="pay-main">
            <fieldset className="card-b">
              <legend><h2>{t("f.delivery")}</h2></legend>
              {options.map((o) => (
                <label className="opt" key={o.method}>
                  <input type="radio" name="ship" value={o.method} checked={method === o.method}
                         onChange={() => setMethod(o.method)} />
                  <span>
                    <b>{o.method === "pickup" ? t("acc.deliveryPickup")
                      : o.method === "dpd_pm" ? t("acc.deliveryDpd") : t("acc.deliveryOmniva")}</b>
                    <small>{o.method === "pickup" ? t("co.pickupAddr") : t("co.parcelEta")}</small>
                  </span>
                  <span className="opt-p tnum">
                    {o.priceCents + o.handlingCents === 0 ? t("co.free") : formatEur(o.priceCents + o.handlingCents)}
                  </span>
                </label>
              ))}

            </fieldset>

            <fieldset className="card-b">
              <legend><h2>{t("co.recipient")}</h2></legend>
              <div className="fields">
                <label>{t("co.fullName")}
                  <input type="text" name="name" autoComplete="name" required
                         value={name} onChange={(e) => setName(e.target.value)} /></label>
                <label>{t("auth.email")}
                  <input type="email" name="email" autoComplete="email" required
                         value={email} onChange={(e) => setEmail(e.target.value)} /></label>
                <label>{t("co.phone")}
                  <input type="tel" name="tel" autoComplete="tel"
                         value={phone} onChange={(e) => setPhone(e.target.value)} /></label>
                {provider && (
                  <div style={{ gridColumn: "1 / -1" }}>
                    <span className="sr" id="parcel-lab">{t("co.parcel")}</span>
                    <ParcelPicker provider={provider} valueId={machineId}
                                  onPick={(l) => { setMachineId(l.id); setMachineName(`${l.city} — ${l.name}`); }} />
                  </div>
                )}
              </div>
            </fieldset>

            <fieldset className="card-b">
              <legend><h2>{t("co.payment")}</h2></legend>
              {PAY_METHODS.map(([id, titleKey, subKey, icon]) => (
                <label className="opt" key={id}>
                  <input type="radio" name="pay" value={id} checked={pay === id} onChange={() => setPay(id)} />
                  <span><b>{t(titleKey)}</b><small>{t(subKey)}</small></span>
                  <Icon name={icon} size={22} />
                </label>
              ))}
              <div style={{ marginTop: 12 }}>
                <KlixPayLater amountCents={order.totalCents} view="checkout" />
              </div>
            </fieldset>
          </div>

          <aside className="pay-side">
            <div className="card-b" ref={payBox}>
              <h2>{t("co.order")}</h2>
              <div className="pay-lot">
                <span className="ic" aria-hidden="true"><Icon name="box" /></span>
                <span><b>{order.itemTitle}</b><small>{order.itemSku} · {order.ref}</small></span>
              </div>
              <table className="fees"><tbody>
                <tr><th scope="row">{t("lp.hammer")}</th><td className="tnum">{formatEur(order.hammerCents)}</td></tr>
                <tr><th scope="row">{t("lp.premium", { n: Math.round((order.premiumCents / Math.max(order.hammerCents, 1)) * 100) })}</th><td className="tnum">{formatEur(order.premiumCents)}</td></tr>
                <tr><th scope="row">{t("lp.vatN", { n: Math.round((order.vatCents / Math.max(order.hammerCents + order.premiumCents, 1)) * 100) })}</th><td className="tnum">{formatEur(order.vatCents)}</td></tr>
                <tr><th scope="row">{t("f.delivery")}</th>
                  <td className="tnum">{shipCost === 0 ? "Bez maksas" : formatEur(shipCost)}</td></tr>
                {machineName && (
                  <tr><th scope="row">{t("co.parcel")}</th><td>{machineName}</td></tr>
                )}
                <tr className="tot"><th scope="row">{t("bn.total")}</th><td className="tnum">{formatEur(total)}</td></tr>
              </tbody></table>

              {error && <p className="bb-status err" style={{ marginTop: 12 }}>{error}</p>}

              <label className="terms">
                <input type="checkbox" required checked={terms} onChange={(e) => setTerms(e.target.checked)} />
                <span>
                  {t("co.agree")} <Link href="/lietosanas-noteikumi">{t("f.terms")}</Link>{" "}
                  {t("co.agreeAnd")} <Link href="/atteikuma-tiesibas">{t("f.withdrawal")}</Link>.
                </span>
              </label>

              <button className="btn btn-primary btn-lg btn-block" type="submit" disabled={busy}>
                {busy ? t("co.redirecting") : <>{t("co.pay")} <span className="tnum">{formatEur(total)}</span></>}
              </button>
              <p className="note" style={{ textAlign: "center", marginTop: 10 }}>
                {t("co.securePay")}
              </p>
            </div>
          </aside>
        </form>
      )}

      {!paid && !submitted && !payVisible && (
        <div className="bidbar">
          <div className="t">
            <span className="lab">{t("co.totalWithDelivery")}</span>
            <b className="tnum">{formatEur(total)}</b>
          </div>
          <button className="btn btn-primary" type="button" disabled={busy}
                  onClick={() => {
                    if (!terms) { say(t("co.confirmTerms")); payBox.current?.scrollIntoView({ behavior: "smooth", block: "center" }); return; }
                    if (provider && !machineId) { say(t("co.pickParcel")); return; }
                    say(t("co.processing"));
                    void saveDelivery(method, machineId).then(() => startPayment());
                  }}>
            {t("co.pay")}
          </button>
        </div>
      )}
    </section>
  );
}
