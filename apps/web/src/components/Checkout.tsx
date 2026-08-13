"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { publicApi, PublicApiError } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { formatEur, type MyOrder, type ShippingOption } from "@/lib/types";
import { Icon } from "./Icon";
import { KlixPayLater } from "./KlixPayLater";
import { ParcelPicker } from "./ParcelPicker";
import { say } from "./Toast";

/** Страница оплаты утверждённого макета: доставка, способ оплаты, получатель
 *  и сводка заказа справа. Данные и цены — из движка; выбор доставки
 *  пересчитывает заказ на сервере. */
const PAY_METHODS: Array<[string, string, string, string]> = [
  ["klix", "Karte", "Visa, Mastercard · Klix by Citadele", "card"],
  ["inbank", "Maksā pa daļām", "Inbank · sadali maksājumu pa mēnešiem", "home"],
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
      say("Piegāde saglabāta");
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
          <h3>Pasūtījums nav atrasts</h3>
          <p>Pārbaudi saiti vai atver sarakstu savā kontā.</p>
          <Link className="btn btn-primary" href="/account">Mani pasūtījumi</Link>
        </div>
      </section>
    );
  }

  const paid = order.status === "paid" || order.status === "collected" || order.status === "shipped";
  // Итог пересчитываем сразу при выборе способа: цену берём из тарифов,
  // а не ждём сохранения на сервере — как в макете.
  const chosen = options.find((o) => o.method === method);
  const shipCost = chosen ? chosen.priceCents + chosen.handlingCents : order.shippingCents + order.handlingCents;
  const total = order.hammerCents + order.premiumCents + order.vatCents + shipCost;

  return (
    <section className="wrap" style={{ paddingTop: 24 }}>
      <nav className="crumbs" aria-label="Navigācijas ceļš">
        <ol>
          <li><Link href="/">Sākums</Link></li>
          <li><Link href="/account">Mani solījumi</Link></li>
          <li aria-current="page">Apmaksa</li>
        </ol>
      </nav>

      <div className="page-head" hidden={paid || submitted}>
        <div>
          <h1 data-hero>Apmaksa</h1>
          <p className="cnt">
            Uzvarētais lots {order.itemSku}
            {order.paymentDeadlineAt && !paid && (
              <> · nokārto līdz {new Date(order.paymentDeadlineAt).toLocaleDateString("lv-LV")}</>
            )}
          </p>
        </div>
      </div>

      {paid || submitted ? (
        <div className="done">
          <span className="ic" aria-hidden="true"><Icon name="check" /></span>
          <h2>Paldies! Maksājums saņemts</h2>
          <p className="lead">
            Rēķinu un piegādes informāciju nosūtījām uz e-pastu.
            Lotu izsūtīsim nākamajā darba dienā.
          </p>
          <div className="done-acts">
            <Link className="btn btn-dark" href="/katalogs">Turpināt solīt</Link>
            <Link className="btn btn-outline" href="/">Uz sākumu</Link>
          </div>
        </div>
      ) : (
        <form className="pay" onSubmit={(e) => {
          e.preventDefault();
          if (!terms) { say("Lūdzu, apstiprini noteikumus"); return; }
          if (provider && !machineId) { say("Izvēlies pakomātu"); return; }
          say("Apstrādājam maksājumu…");
          // Сначала фиксируем доставку на сервере — он пересчитывает заказ,
          // и только потом уходим на оплату уже с итоговой суммой.
          void saveDelivery(method, machineId).then(() => startPayment());
        }}>
          <div className="pay-main">
            <fieldset className="card-b">
              <legend><h2>Piegāde</h2></legend>
              {options.map((o) => (
                <label className="opt" key={o.method}>
                  <input type="radio" name="ship" value={o.method} checked={method === o.method}
                         onChange={() => setMethod(o.method)} />
                  <span>
                    <b>{o.method === "pickup" ? t("acc.deliveryPickup")
                      : o.method === "dpd_pm" ? t("acc.deliveryDpd") : t("acc.deliveryOmniva")}</b>
                    <small>{o.method === "pickup"
                      ? "Brīvības iela 137, Rīga · darbdienās"
                      : "1–2 darba dienas · izsekojams"}</small>
                  </span>
                  <span className="opt-p tnum">
                    {o.priceCents + o.handlingCents === 0 ? "Bez maksas" : formatEur(o.priceCents + o.handlingCents)}
                  </span>
                </label>
              ))}

            </fieldset>

            <fieldset className="card-b">
              <legend><h2>Saņēmējs</h2></legend>
              <div className="fields">
                <label>Vārds, uzvārds
                  <input type="text" name="name" autoComplete="name" required
                         value={name} onChange={(e) => setName(e.target.value)} /></label>
                <label>E-pasts
                  <input type="email" name="email" autoComplete="email" required
                         value={email} onChange={(e) => setEmail(e.target.value)} /></label>
                <label>Tālrunis
                  <input type="tel" name="tel" autoComplete="tel"
                         value={phone} onChange={(e) => setPhone(e.target.value)} /></label>
                {provider && (
                  <div style={{ gridColumn: "1 / -1" }}>
                    <span className="sr" id="parcel-lab">Pakomāts</span>
                    <ParcelPicker provider={provider} valueId={machineId}
                                  onPick={(l) => { setMachineId(l.id); setMachineName(`${l.city} — ${l.name}`); }} />
                  </div>
                )}
              </div>
            </fieldset>

            <fieldset className="card-b">
              <legend><h2>Maksājums</h2></legend>
              {PAY_METHODS.map(([id, title, sub, icon]) => (
                <label className="opt" key={id}>
                  <input type="radio" name="pay" value={id} checked={pay === id} onChange={() => setPay(id)} />
                  <span><b>{title}</b><small>{sub}</small></span>
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
              <h2>Pasūtījums</h2>
              <div className="pay-lot">
                <span className="ic" aria-hidden="true"><Icon name="box" /></span>
                <span><b>{order.itemTitle}</b><small>{order.itemSku} · {order.ref}</small></span>
              </div>
              <table className="fees"><tbody>
                <tr><th scope="row">Āmura cena</th><td className="tnum">{formatEur(order.hammerCents)}</td></tr>
                <tr><th scope="row">Pircēja komisija ({Math.round((order.premiumCents / Math.max(order.hammerCents, 1)) * 100)} %)</th><td className="tnum">{formatEur(order.premiumCents)}</td></tr>
                <tr><th scope="row">PVN</th><td className="tnum">{formatEur(order.vatCents)}</td></tr>
                <tr><th scope="row">Piegāde</th>
                  <td className="tnum">{shipCost === 0 ? "Bez maksas" : formatEur(shipCost)}</td></tr>
                {machineName && (
                  <tr><th scope="row">Pakomāts</th><td>{machineName}</td></tr>
                )}
                <tr className="tot"><th scope="row">Kopā</th><td className="tnum">{formatEur(total)}</td></tr>
              </tbody></table>

              {error && <p className="bb-status err" style={{ marginTop: 12 }}>{error}</p>}

              <label className="terms">
                <input type="checkbox" required checked={terms} onChange={(e) => setTerms(e.target.checked)} />
                <span>
                  Piekrītu <Link href="/lietosanas-noteikumi">lietošanas noteikumiem</Link> un apstiprinu,
                  ka esmu iepazinies ar <Link href="/atteikuma-tiesibas">atteikuma tiesībām</Link>.
                </span>
              </label>

              <button className="btn btn-primary btn-lg btn-block" type="submit" disabled={busy}>
                {busy ? "Novirzām…" : <>Maksāt <span className="tnum">{formatEur(total)}</span></>}
              </button>
              <p className="note" style={{ textAlign: "center", marginTop: 10 }}>
                Droša apmaksa · Klix by Citadele
              </p>
            </div>
          </aside>
        </form>
      )}

      {!paid && !submitted && !payVisible && (
        <div className="bidbar">
          <div className="t">
            <span className="lab">Kopā ar piegādi</span>
            <b className="tnum">{formatEur(total)}</b>
          </div>
          <button className="btn btn-primary" type="button" disabled={busy}
                  onClick={() => {
                    if (!terms) { say("Lūdzu, apstiprini noteikumus"); payBox.current?.scrollIntoView({ behavior: "smooth", block: "center" }); return; }
                    if (provider && !machineId) { say("Izvēlies pakomātu"); return; }
                    say("Apstrādājam maksājumu…");
                    void saveDelivery(method, machineId).then(() => startPayment());
                  }}>
            Maksāt
          </button>
        </div>
      )}
    </section>
  );
}
