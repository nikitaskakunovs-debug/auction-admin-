"use client";

import Link from "next/link";
import { BrandMark } from "@/components/BrandMark";
import { useCallback, useEffect, useRef, useState } from "react";
import { publicApi, PublicApiError } from "@/lib/api";
import { dateLocale, useT } from "@/lib/i18n";
import { adsUserData, orderEcom, purchaseOnce, track } from "@/lib/track";
import { useStickyBar } from "@/lib/ui";
import { formatEur, type MyOrder, type ShippingOption } from "@/lib/types";
import { Icon } from "./Icon";
import { KlixPayLater } from "./KlixPayLater";
import { ParcelPicker } from "./ParcelPicker";
import { PhoneField, fromE164, phoneComplete } from "./PhoneField";
import { say } from "./Toast";

/** Страница оплаты утверждённого макета: доставка, способ оплаты, получатель
 *  и сводка заказа справа. Данные и цены — из движка; выбор доставки
 *  пересчитывает заказ на сервере. */
/** Профиль реквизитов в том виде, в каком его отдаёт кабинет. */
interface CoBillingProfile {
  id: string;
  kind: "person" | "company";
  name: string;
  regNo: string;
  vatNo: string;
  address: string;
  city: string;
  zip: string;
  isDefault: boolean;
}

const PAY_METHODS: Array<[string, string, string, string]> = [
  ["klix", "co.card", "co.cardD", "card"],
  ["inbank", "co.instal", "co.instalD", "home"],
];

/**
 * Шаг оформления. На компьютере — обычная карточка, как раньше.
 * На телефоне заполненный шаг сворачивается в строку с выбранным значением
 * и ссылкой «Mainīt»: на 390 px открытым остаётся только текущий шаг.
 */
function PayStep({ n, label, value, done, open, onOpen, editLabel, children }: {
  n: number; label: string; value?: string; done: boolean;
  open: boolean; onOpen: () => void; editLabel: string; children: React.ReactNode;
}) {
  const collapsed = done && !open;
  return (
    <section className={`pay-step${collapsed ? " is-done" : ""}`}>
      <header className="pay-head">
        <span className="pay-num" aria-hidden="true">{done ? <Icon name="check" size={14} /> : n}</span>
        <span className="t">
          <small>{label}</small>
          <b>{collapsed && value ? value : label}</b>
        </span>
        {collapsed && (
          <button className="pay-edit" type="button" onClick={onOpen}>{editLabel}</button>
        )}
      </header>
      <div className="pay-body">{children}</div>
    </section>
  );
}

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
  const [phoneTouched, setPhoneTouched] = useState(false);
  /* Шаг сворачивается только после того, как выбор сделал человек: значение
     из заказа — это ещё не выбор, и на телефоне список должен быть открыт. */
  const [deliveryPicked, setDeliveryPicked] = useState(false);
  /* Курьер и негабарит просят улицу вместо номера пакомата (макеты № 74, 75). */
  const [addr, setAddr] = useState({ address: "", city: "", zip: "", accessNote: "" });
  const [insured, setInsured] = useState(false);
  const [insuranceRule, setInsuranceRule] = useState({ bp: 100, minCents: 100 });
  const [terms, setTerms] = useState(false);
  /** Какой шаг раскрыт вручную на телефоне; null — автоматически. */
  const [openStep, setOpenStep] = useState<number | null>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [payVisible, setPayVisible] = useState(true);
  const payBox = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Аванс (№ 72): остаток на счету и переключатель «использовать».
  const [creditCents, setCreditCents] = useState(0);
  const [useCredit, setUseCredit] = useState(true);
  const [meWho, setMeWho] = useState<string | null>(null);
  /** Для Google Ads Enhanced Conversions (user_data) — только при согласии.
   *  meReady = ответ /auth/me получен (успех или отказ): begin_checkout ждёт
   *  его, иначе гонка двух параллельных запросов оставляла user_data пустым. */
  const [meContact, setMeContact] = useState<{ email: string; name: string | null } | null>(null);
  const [meReady, setMeReady] = useState(false);
  /* Реквизиты для счёта: по умолчанию основной профиль, но на этой покупке
     можно выбрать другой — заказ запомнит снимок (макет № 42). */
  const [billing, setBilling] = useState<CoBillingProfile[]>([]);
  const [billingId, setBillingId] = useState<string>("");

  const load = useCallback(async () => {
    try {
      const r = await publicApi.get<{ orders: MyOrder[] }>("/api/public/me/orders");
      const found = r.orders.find((o) => o.ref === orderRef) ?? null;
      setOrder(found);
      if (found) {
        setMethod(found.fulfilment);
        setMachineId(found.shippingTo?.machineId ?? "");
        // Телефон уже вводили при прошлом заходе — не заставляем набирать снова.
        if (found.recipientPhone) setPhone((prev) => prev || found.recipientPhone!);
      }
    } catch { setOrder(null); }
  }, [orderRef]);

  // Аналитика (GTM): человек дошёл до оплаты. Один раз на заказ; в параметрах
  // сумма и разбивка — комиссия площадки (buyer premium) отдельно, чтобы в
  // отчётах считалась не только касса, но и наш собственный доход.
  const beganRef = useRef<string | null>(null);
  useEffect(() => {
    if (!order || !meReady || beganRef.current === order.ref) return;
    beganRef.current = order.ref;
    const ec = orderEcom(order);
    track("begin_checkout", {
      ...adsUserData({
        email: meContact?.email, name: meContact?.name, phone: order.recipientPhone,
        country: order.shippingTo?.country, zip: order.shippingTo?.zip,
      }),
      value: ec.netCents / 100, currency: "EUR",
      gross_total: ec.grossCents / 100, cart_gross_total: ec.grossCents / 100, cart_size: 1,
      commission_value: ec.commissionCents / 100,
      vat_scheme: ec.vatScheme,
      ecommerce: { currency: "EUR", value: ec.netCents / 100, items: [ec.item] },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [order, meReady]);

  useEffect(() => {
    setSignedIn(publicApi.hasSession);
    const fn = () => setSignedIn(publicApi.hasSession);
    publicApi.listeners.add(fn);
    return () => { publicApi.listeners.delete(fn); };
  }, []);

  useEffect(() => { if (signedIn) void load(); }, [signedIn, load]);

  useEffect(() => {
    if (!signedIn) return;
    void publicApi.get<{ balanceCents: number }>("/api/public/me/credit")
      .then((r) => setCreditCents(r.balanceCents))
      .catch(() => undefined);
    void publicApi.get<{ bidder: { alias: string; email: string; name: string | null; company: string | null } }>("/api/public/auth/me")
      .then((r) => {
        setMeWho(r.bidder.company ?? r.bidder.name ?? r.bidder.alias);
        setMeContact({ email: r.bidder.email, name: r.bidder.name });
      })
      .catch(() => undefined)
      .finally(() => setMeReady(true));
    void publicApi.get<{ profiles: CoBillingProfile[] }>("/api/public/me/billing-profiles")
      .then((r) => {
        setBilling(r.profiles);
        setBillingId((prev) => prev || r.profiles.find((p) => p.isDefault)?.id || r.profiles[0]?.id || "");
      })
      .catch(() => undefined);
  }, [signedIn]);

  useEffect(() => {
    void publicApi.get<{ options: ShippingOption[]; insurance?: { bp: number; minCents: number } }>("/api/public/shipping/options?market=LV")
      .then((r) => { setOptions(r.options); if (r.insurance) setInsuranceRule(r.insurance); })
      .catch(() => setOptions([{ method: "pickup", priceCents: 0, handlingCents: 0 }]));
  }, []);

  const provider = method === "dpd_pm" ? "dpd" : method === "omniva_pm" ? "omniva" : null;
  const needsAddress = method === "courier" || method === "freight";
  const addrReady = Boolean(addr.address.trim() && addr.city.trim() && addr.zip.trim());


  const saveDelivery = async (next: string, machine: string) => {
    setBusy(true); setError(null);
    try {
      await publicApi.post(`/api/public/orders/${encodeURIComponent(orderRef)}/fulfilment`, {
        method: next,
        ...(next === "pickup"
          ? {}
          : next === "courier" || next === "freight"
            ? {
                recipientPhone: phone,
                insurance: insured,
                address: {
                  name: name.trim(),
                  address: addr.address.trim(),
                  city: addr.city.trim(),
                  zip: addr.zip.trim(),
                  ...(addr.accessNote.trim() ? { accessNote: addr.accessNote.trim() } : {}),
                },
              }
            : { machineId: machine, recipientPhone: phone, insurance: insured }),
      });
      await load();
      say(t("co.deliverySaved"));
      track("add_shipping_info", { transaction_id: orderRef, shipping_tier: next });
    } catch (err) {
      setError(err instanceof Error ? err.message : "error");
    } finally { setBusy(false); }
  };

  /** Фиксирует реквизиты на заказе: счёт выпишется по этому снимку. */
  const saveBilling = async (profileId: string) => {
    try {
      await publicApi.post(`/api/public/me/orders/${encodeURIComponent(orderRef)}/billing`, { profileId });
    } catch {
      // Не блокируем оплату: счёт можно перевыставить, деньги важнее.
    }
  };

  const startPayment = async () => {
    setBusy(true); setError(null);
    try {
      const r = await publicApi.post<{ checkoutUrl?: string; paid?: boolean }>(
        `/api/public/orders/${encodeURIComponent(orderRef)}/pay`,
        { language: lang, provider: pay, ...(creditCents > 0 && useCredit ? { useCredit: true } : {}) },
      );
      setSubmitted(true);
      track("add_payment_info", {
        transaction_id: orderRef, payment_type: pay,
        value: (order?.totalCents ?? 0) / 100, currency: "EUR",
      });
      // Аванс покрыл всё — провайдер не нужен, сразу чек. event_id = номер
      // заказа: серверный Meta CAPI пришлёт такой же, дубль не засчитается.
      if (r.paid) {
        const ec = order ? orderEcom(order) : null;
        purchaseOnce(orderRef, {
          ...adsUserData({
            email: meContact?.email, name: meContact?.name,
            phone: phone || order?.recipientPhone,
            country: order?.shippingTo?.country, zip: order?.shippingTo?.zip,
          }),
          transaction_id: orderRef, event_id: orderRef,
          value: (ec ? ec.netCents : 0) / 100, currency: "EUR",
          gross_total: (ec ? ec.grossCents : 0) / 100,
          commission_value: (ec ? ec.commissionCents : 0) / 100,
          vat_scheme: ec?.vatScheme ?? "standard",
          payment_status: "paid", payment_type: "avanss",
          ecommerce: {
            transaction_id: orderRef, currency: "EUR",
            value: (ec ? ec.netCents : 0) / 100,
            tax: (ec ? ec.taxCents : 0) / 100,
            shipping: (ec ? ec.shippingCents : 0) / 100,
            items: ec ? [ec.item] : [],
          },
        });
        window.location.assign(`/account?tab=pirkumi&cek=${encodeURIComponent(orderRef)}`);
        return;
      }
      window.location.assign(r.checkoutUrl!);
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
  /* Ту же формулу считает движок при сохранении доставки — здесь она только
     показывает цену до отправки, чтобы галочка не была котом в мешке. */
  const goodsCents = order.hammerCents + order.premiumCents + order.vatCents;
  const insuranceQuoteCents = Math.max(
    insuranceRule.minCents,
    Math.round((goodsCents * insuranceRule.bp) / 10_000),
  );
  const insuranceCents = insured && method !== "pickup" ? insuranceQuoteCents : 0;
  const gross = goodsCents + shipCost + insuranceCents;
  const creditApplied = creditCents > 0 && useCredit ? Math.min(creditCents, gross) : 0;
  const total = gross - creditApplied;

  // Шаги оформления: заполненный сворачивается на телефоне (веб не меняется).
  const deliveryReady = Boolean(method) && (!provider || Boolean(machineId)) && (!needsAddress || addrReady);
  /* Телефон нужен всегда: по нему звонит курьер и приходит код пакомата
     (макет № 51 — просим прямо в шаге, не отправляя в настройки). */
  const phoneParsed = fromE164(phone);
  const phoneOk = phoneComplete(phoneParsed.digits, phoneParsed.iso);
  const recipientReady = Boolean(name.trim()) && Boolean(email.trim()) && phoneOk;
  const deliveryName = chosen
    ? chosen.method === "pickup" ? t("acc.deliveryPickup")
      : chosen.method === "dpd_pm" ? t("acc.deliveryDpd")
      : chosen.method === "omniva_pm" ? t("acc.deliveryOmniva")
      : chosen.method === "courier" ? t("co.courier")
      : t("co.freight")
    : "";
  const deliveryValue =
    method === "freight" ? `${deliveryName} · ${t("co.byQuote")}`
    : shipCost === 0 ? deliveryName
    : `${deliveryName} · ${formatEur(shipCost)}`;
  const recipientValue = [name.trim(), email.trim()].filter(Boolean).join(" · ");

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
          if (needsAddress && !addrReady) { say(t("co.addrNeeded")); return; }
          if (!phoneOk) { setPhoneTouched(true); say(t("co.phoneNeeded")); return; }
          say(t("co.processing"));
          // Сначала фиксируем доставку на сервере — он пересчитывает заказ,
          // и только потом уходим на оплату уже с итоговой суммой.
          void saveDelivery(method, machineId)
            .then(() => (billingId ? saveBilling(billingId) : undefined))
            .then(() => startPayment());
        }}>
          <div className="pay-main">
            <div className="pay-sum" aria-hidden="true">
              <span className="ic"><Icon name="box" /></span>
              <span className="t"><small>{t("co.order")} {order.ref}</small><b>{order.itemTitle}</b></span>
              <span className="sum tnum">{formatEur(total)}</span>
            </div>

            <PayStep n={1} label={t("f.delivery")} value={deliveryValue} done={deliveryReady && deliveryPicked}
                     open={openStep === 1} onOpen={() => setOpenStep(1)} editLabel={t("ac.change")}>
            <fieldset className="card-b">
              <legend><h2>{t("f.delivery")}</h2></legend>
              {options.map((o) => (
                <label className="opt" key={o.method}>
                  <input type="radio" name="ship" value={o.method} checked={method === o.method}
                         onChange={() => { setMethod(o.method); setDeliveryPicked(true); }} />
                  <span>
                    <b className="pay-opt-t">
                      {o.method === "omniva_pm" && <BrandMark name="omniva" h={16} />}
                      {(o.method === "dpd_pm" || o.method === "courier") && <BrandMark name="dpd" h={16} />}
                      {o.method === "pickup" ? t("acc.deliveryPickup")
                        : o.method === "dpd_pm" ? t("acc.deliveryDpd")
                        : o.method === "courier" ? t("co.courier")
                        : o.method === "freight" ? t("co.freight")
                        : t("acc.deliveryOmniva")}
                    </b>
                    <small>
                      {o.method === "pickup" ? t("co.pickupAddr")
                        : o.method === "courier" ? t("co.courierD")
                        : o.method === "freight" ? t("co.freightD")
                        : t("co.parcelEta")}
                    </small>
                  </span>
                  <span className="opt-p tnum">
                    {o.method === "freight" ? t("co.byQuote")
                      : o.priceCents + o.handlingCents === 0 ? t("co.free")
                      : formatEur(o.priceCents + o.handlingCents)}
                  </span>
                </label>
              ))}

              {needsAddress && (
                <div className="fields addr-fields">
                  <label style={{ gridColumn: "1 / -1" }}>{t("co.street")}
                    <input type="text" autoComplete="street-address" required
                           value={addr.address} onChange={(e) => setAddr({ ...addr, address: e.target.value })} /></label>
                  <label>{t("co.city")}
                    <input type="text" autoComplete="address-level2" required
                           value={addr.city} onChange={(e) => setAddr({ ...addr, city: e.target.value })} /></label>
                  <label>{t("co.zip")}
                    <input type="text" autoComplete="postal-code" required inputMode="numeric"
                           value={addr.zip} onChange={(e) => setAddr({ ...addr, zip: e.target.value })} /></label>
                  <label style={{ gridColumn: "1 / -1" }}>{t("co.accessNote")}
                    <input type="text" value={addr.accessNote}
                           onChange={(e) => setAddr({ ...addr, accessNote: e.target.value })} /></label>
                  {method === "freight" && <p className="note" style={{ gridColumn: "1 / -1" }}>{t("co.freightNote")}</p>}
                </div>
              )}

              {method !== "pickup" && (
                <label className="opt credit">
                  <input type="checkbox" checked={insured} onChange={(e) => setInsured(e.target.checked)} />
                  <span>
                    <b>{t("co.insure", { sum: formatEur(insuranceQuoteCents) })}</b>
                    <small>{t("co.insureD")}</small>
                  </span>
                </label>
              )}

            </fieldset>
            </PayStep>

            {creditCents > 0 && (
              <fieldset className="card-b">
                <legend><h2>{t("kb.credit")}</h2></legend>
                <label className="opt credit">
                  <input type="checkbox" checked={useCredit} onChange={(e) => setUseCredit(e.target.checked)} />
                  <span>
                    <b>{t("kb.creditUse", { sum: formatEur(Math.min(creditCents, gross)) })}</b>
                    <small>{t("kb.creditNote")}</small>
                  </span>
                </label>
              </fieldset>
            )}

            <PayStep n={2} label={t("co.recipient")} value={recipientValue} done={recipientReady}
                     open={openStep === 2} onOpen={() => setOpenStep(2)} editLabel={t("ac.change")}>
            <fieldset className="card-b">
              <legend><h2>{t("co.recipient")}</h2></legend>
              {billing.length > 0 ? (
                <div className="co-billing">
                  <span className="g-lbl">{t("bp.forThis")}</span>
                  {billing.map((p) => (
                    <label className="opt" key={p.id}>
                      <input type="radio" name="billing" value={p.id} checked={billingId === p.id}
                             onChange={() => setBillingId(p.id)} />
                      <span>
                        <b>{p.name}</b>
                        <small>
                          {p.kind === "company"
                            ? [p.regNo && `${t("bp.regNo")} ${p.regNo}`, p.vatNo,
                               [p.address, p.city, p.zip].filter(Boolean).join(", ")].filter(Boolean).join(" · ")
                            : t("kb.person")}
                        </small>
                      </span>
                    </label>
                  ))}
                  <p className="note">
                    <Link href="/account?tab=iestatijumi&s=rekviziti">{t("bp.manage")}</Link>
                  </p>
                </div>
              ) : (
                meWho && (
                  <p className="note" style={{ marginBottom: 10 }}>
                    {t("kb.invoiceTo", { who: meWho })}{" "}
                    <Link href="/account?tab=iestatijumi&s=rekviziti">{t("kb.invoiceToSia")}</Link>
                  </p>
                )
              )}
              <div className="fields">
                <label>{t("co.fullName")}
                  <input type="text" name="name" autoComplete="name" required
                         value={name} onChange={(e) => setName(e.target.value)} /></label>
                <label>{t("auth.email")}
                  <input type="email" name="email" autoComplete="email" required
                         value={email} onChange={(e) => setEmail(e.target.value)} /></label>
                <div className="phone-cell">
                  <PhoneField id="co-phone" label={t("co.phone")} lang={lang} required
                              value={phone} onChange={(v) => { setPhone(v); setPhoneTouched(true); }}
                              invalid={phoneTouched && !phoneOk} />
                  {phoneTouched && !phoneOk && <small className="fld-err">{t("co.phoneNeeded")}</small>}
                </div>
                {provider && (
                  <div style={{ gridColumn: "1 / -1" }}>
                    <span className="sr" id="parcel-lab">{t("co.parcel")}</span>
                    <ParcelPicker provider={provider} valueId={machineId}
                                  onPick={(l) => { setMachineId(l.id); setMachineName(`${l.city} — ${l.name}`); }} />
                  </div>
                )}
              </div>
            </fieldset>

            </PayStep>

            <PayStep n={3} label={t("co.payment")} done={false}
                     open onOpen={() => setOpenStep(3)} editLabel={t("ac.change")}>
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
              <p className="pay-marks" aria-hidden="true">
                <BrandMark name="swedbank" h={16} /><BrandMark name="seb" h={16} />
                <BrandMark name="citadele" h={16} /><BrandMark name="luminor" h={16} />
                <BrandMark name="revolut" h={16} /><BrandMark name="visa" h={16} />
                <BrandMark name="mastercard" h={16} />
              </p>
            </fieldset>
            </PayStep>
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
                  <td className="tnum">
                    {method === "freight" ? t("co.byQuote") : shipCost === 0 ? t("co.free") : formatEur(shipCost)}
                  </td></tr>
                {machineName && !needsAddress && (
                  <tr><th scope="row">{t("co.parcel")}</th><td>{machineName}</td></tr>
                )}
                {needsAddress && addrReady && (
                  <tr><th scope="row">{t("co.address")}</th><td>{addr.address}, {addr.city} {addr.zip}</td></tr>
                )}
                {insuranceCents > 0 && (
                  <tr><th scope="row">{t("co.insurance")}</th><td className="tnum">{formatEur(insuranceCents)}</td></tr>
                )}
                {creditApplied > 0 && (
                  <tr><th scope="row">{t("kb.creditRow")}</th><td className="tnum">−{formatEur(creditApplied)}</td></tr>
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
          if (needsAddress && !addrReady) { say(t("co.addrNeeded")); return; }
          if (!phoneOk) { setPhoneTouched(true); say(t("co.phoneNeeded")); return; }
                    say(t("co.processing"));
                    void saveDelivery(method, machineId)
            .then(() => (billingId ? saveBilling(billingId) : undefined))
            .then(() => startPayment());
                  }}>
            {t("co.pay")}
          </button>
        </div>
      )}
    </section>
  );
}
