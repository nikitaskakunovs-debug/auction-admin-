"use client";

/** Экран состояния заказа — макеты № 64, 65, 67, 68, 69, 69b, 70.
 *
 *  Один экран, а не семь: состояние приходит с сервера одним запросом, и
 *  по нему решаем, какую шапку и какие действия показать. Деньги считает
 *  движок, здесь только форматирование. Классы с префиксом `os-`, чтобы
 *  не столкнуться с боевыми `.opt`, `.step`, `.done`, `.srch`.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { publicApi, PublicApiError } from "@/lib/api";
import { dateLocale, useT } from "@/lib/i18n";
import { formatEur } from "@/lib/types";
import { Ph } from "../Ph";
import { say } from "../Toast";
import { InvoicePdfButton } from "./Money";

interface FeeRow { type: string; amountCents: number; createdAt: string }
interface RefundRow { amountCents: number; reason: string | null; createdAt: string }
interface ReturnCase {
  ref: string;
  status: string;
  reason: string;
  decision: string | null;
  refundCents: number;
  createdAt: string;
}

interface OrderState {
  ref: string;
  itemTitle: string;
  itemSku: string;
  hammerCents: number;
  premiumCents: number;
  vatCents: number;
  shippingCents: number;
  handlingCents: number;
  creditAppliedCents: number;
  totalCents: number;
  status: string;
  fulfilment: string;
  paymentDeadlineAt: string | null;
  paidAt: string | null;
  pickupCode: string | null;
  lateDays: number;
  paidCents: number;
  feesCents: number;
  fees: FeeRow[];
  lastPayment: { status: string; method: string | null; provider: string; createdAt: string } | null;
  shippingTo: { provider: string; machineId: string; name: string; zip: string; country: string; address?: string; city?: string; accessNote?: string } | null;
  insuranceCents: number;
  pickupProxyName: string;
  recipientPhone: string | null;
  shipment: { provider: string; barcode: string; status: string; providerStatus: string | null; createdAt: string } | null;
  invoice: { number: string; issuedAt: string } | null;
  returnCase: ReturnCase | null;
  refunds: RefundRow[];
}

type Tone = "bad" | "wait" | "ok";

export function OrderStatus({ orderRef }: { orderRef: string }) {
  const { t, lang } = useT();
  const [o, setO] = useState<OrderState | null | "missing">(null);

  const load = useCallback(() => {
    void publicApi
      .get<OrderState>(`/api/public/me/orders/${encodeURIComponent(orderRef)}`)
      .then(setO)
      .catch(() => setO("missing"));
  }, [orderRef]);
  useEffect(load, [load]);

  if (o === null) return <section className="wrap acct-page" style={{ paddingTop: 24 }}><div className="acct" aria-busy="true" /></section>;
  if (o === "missing") {
    return (
      <section className="wrap acct-page" style={{ paddingTop: 24 }}>
        <div className="acct">
          <Link className="btn-back" href="/account">
            <Ph name="caret-right" size={14} className="flip" /> {t("os.back")}
          </Link>
          <div className="empty"><h3>{t("os.notFound")}</h3></div>
        </div>
      </section>
    );
  }

  const when = (d: string | null) =>
    d
      ? new Date(d).toLocaleString(dateLocale(lang), {
          day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit",
        })
      : "—";

  const dueCents = Math.max(0, o.totalCents + o.feesCents - o.paidCents);
  const overCents = Math.max(0, o.paidCents - (o.totalCents + o.feesCents));
  const refundedCents = o.refunds.reduce((sum, r) => sum + r.amountCents, 0);

  /* Какое состояние показываем — порядок важен: сначала деньги, потом возврат. */
  const failed = o.status === "awaiting_payment" && o.lastPayment?.status === "failed";
  const waiting =
    o.status === "awaiting_payment" && o.lastPayment?.status === "created" && o.paidCents === 0;
  const under = o.status === "awaiting_payment" && o.paidCents > 0 && dueCents > 0;
  const late = o.status === "awaiting_payment" && o.lateDays > 0;
  const over = overCents > 0;
  const refunding = refundedCents > 0;
  /* Посылка вернулась к нам — это важнее зелёного «оплачено» (макет № 77). */
  const unclaimed = o.shipment?.status === "returned" || o.shipment?.status === "unclaimed";

  const head: { tone: Tone; icon: string; title: string; text: string } =
    refunding
      ? { tone: "ok", icon: "arrow-counter-clockwise", title: t("os.refT"), text: t("os.refD", { sum: formatEur(refundedCents) }) }
      : unclaimed
      ? { tone: "bad", icon: "package", title: t("os.unclaimedT"),
          text: t("os.unclaimedD", { sum: formatEur(o.shippingCents || 690) }) }
      : under
        ? { tone: "wait", icon: "warning-circle", title: t("os.underT"), text: t("os.underD", { paid: formatEur(o.paidCents), rest: formatEur(dueCents) }) }
        : over
          ? { tone: "ok", icon: "info", title: t("os.overT"), text: t("os.overD", { sum: formatEur(overCents) }) }
          : failed
            ? { tone: "bad", icon: "warning-circle", title: t("os.failT"), text: t("os.failD") }
            : late
              ? { tone: "bad", icon: "clock", title: t("os.lateT"), text: t("os.lateD", { n: o.lateDays }) }
              : waiting
                ? { tone: "wait", icon: "clock", title: t("os.waitT"), text: t("os.waitD") }
                : { tone: "ok", icon: "check", title: t("kb.paidBig"), text: t("kb.stepCheckD") };

  return (
    <section className="wrap acct-page" style={{ paddingTop: 24 }}>
    <div className="acct">
      <Link className="btn-back" href="/account">
        <Ph name="caret-right" size={14} className="flip" /> {t("os.back")}
      </Link>

      <div className="page-head" style={{ alignItems: "flex-start" }}>
        <div>
          <h1 data-hero>{t("kb.orderN", { ref: o.ref })}</h1>
          <p className="cnt">{o.itemTitle}</p>
        </div>
      </div>

      {/* Итог сверху — на телефоне сумма не должна прятаться в конце страницы. */}
      <div className="os-sum">
        <span className="t">
          <small>{dueCents > 0 ? t("os.toPay") : t("os.total")}</small>
          <b className="tnum">{formatEur(dueCents > 0 ? dueCents : o.totalCents)}</b>
        </span>
        {o.paymentDeadlineAt && dueCents > 0 && (
          <span className="t">
            <small>{t("os.deadline")}</small>
            <b>{when(o.paymentDeadlineAt)}</b>
          </span>
        )}
        {o.paidCents > 0 && (
          <span className="t">
            <small>{t("os.paidSoFar")}</small>
            <b className="tnum">{formatEur(o.paidCents)}</b>
          </span>
        )}
      </div>

      <section className={`os-head is-${head.tone}`}>
        <span className="ic" aria-hidden="true"><Ph name={head.icon} size={20} /></span>
        <span className="t">
          <b>{head.title}</b>
          <small>{head.text}</small>
        </span>
      </section>

      <div className="acts os-acts">
        {(failed || late || under || waiting) && dueCents > 0 && (
          <Link className="btn btn-primary" href={`/apmaksa/${encodeURIComponent(o.ref)}`}>
            <Ph name="credit-card" size={18} />{" "}
            {failed ? t("os.retry") : under ? t("os.payRest") : t("os.payNow")}
          </Link>
        )}
        {failed && (
          <Link className="btn btn-outline" href={`/apmaksa/${encodeURIComponent(o.ref)}`}>{t("os.otherWay")}</Link>
        )}
        {over && (
          <Link className="btn btn-outline" href="/account?tab=credit">{t("os.toCredit")}</Link>
        )}
        <InvoicePdfButton orderRef={o.ref} disabled={o.invoice === null} />
      </div>

      {waiting && <TransferBlock orderRef={o.ref} />}
      {late && <ExtendBlock orderRef={o.ref} onDone={load} />}
      {o.status === "paid" && o.fulfilment === "pickup" && <ProxyBlock order={o} onDone={load} />}
      {(o.shipment?.status === "returned" || o.shipment?.status === "unclaimed") && (
        <ReshipBlock order={o} onDone={load} />
      )}

      {o.fees.length > 0 && (
        <section className="os-block">
          <p className="g-lbl">{t("os.fees")}</p>
          {o.fees.map((f, i) => (
            <div className="prow-s" key={i}>
              <span className="k">{feeLabel(f.type, t)}</span>
              <b className="tnum">{formatEur(f.amountCents)}</b>
              <small>{when(f.createdAt)}</small>
            </div>
          ))}
        </section>
      )}

      {o.refunds.length > 0 && (
        <section className="os-block">
          <p className="g-lbl">{t("os.refRow")}</p>
          {o.refunds.map((r, i) => (
            <div className="prow-s" key={i}>
              <span className="k">{t("os.refRow")}</span>
              <b className="tnum pos">+{formatEur(r.amountCents)}</b>
              <small>{when(r.createdAt)}{r.reason ? ` · ${r.reason}` : ""}</small>
            </div>
          ))}
        </section>
      )}

      <ReturnBlock order={o} onDone={load} />

      <section className="os-block">
        <p className="g-lbl">{t("kb.payData")}</p>
        <div className="prow-s"><span className="k">{t("os.lot")}</span><b className="tnum">{o.itemSku}</b><small>{o.itemTitle}</small></div>
        <div className="prow-s"><span className="k">{t("ac.hammer")}</span><b className="tnum">{formatEur(o.hammerCents)}</b></div>
        <div className="prow-s"><span className="k">{t("ac.premium")}</span><b className="tnum">{formatEur(o.premiumCents)}</b></div>
        <div className="prow-s"><span className="k">{t("ac.vat")}</span><b className="tnum">{formatEur(o.vatCents)}</b></div>
        {o.shippingCents > 0 && (
          <div className="prow-s"><span className="k">{t("co.delivery")}</span><b className="tnum">{formatEur(o.shippingCents)}</b></div>
        )}
        {o.insuranceCents > 0 && (
          <div className="prow-s"><span className="k">{t("co.insurance")}</span><b className="tnum">{formatEur(o.insuranceCents)}</b></div>
        )}
        {o.shippingTo?.address && (
          <div className="prow-s">
            <span className="k">{t("co.address")}</span>
            <b>{o.shippingTo.address}{o.shippingTo.city ? `, ${o.shippingTo.city}` : ""} {o.shippingTo.zip}</b>
            {o.shippingTo.accessNote && <small>{o.shippingTo.accessNote}</small>}
          </div>
        )}
        {o.creditAppliedCents > 0 && (
          <div className="prow-s"><span className="k">{t("kb.creditRow")}</span><b className="tnum">−{formatEur(o.creditAppliedCents)}</b></div>
        )}
        <div className="prow-s"><span className="k">{t("os.total")}</span><b className="tnum">{formatEur(o.totalCents)}</b></div>
        {o.invoice && (
          <div className="prow-s"><span className="k">{t("os.invoice")}</span><b className="tnum">{o.invoice.number}</b><small>{when(o.invoice.issuedAt)}</small></div>
        )}
      </section>
    </div>
    </section>
  );
}

function feeLabel(type: string, t: (k: string) => string): string {
  if (type === "storage") return t("os.feeStorage");
  if (type === "late") return t("os.feeLate");
  if (type === "reship") return t("os.feeReship");
  return t("os.fees");
}

/** Макет № 65: реквизиты для банковского перевода с кнопкой «скопировать». */
function TransferBlock({ orderRef }: { orderRef: string }) {
  const { t } = useT();
  const copy = () => {
    void navigator.clipboard?.writeText(orderRef).then(() => say(t("os.copied"))).catch(() => undefined);
  };
  return (
    <section className="os-block">
      <p className="g-lbl">{t("os.payRef")}</p>
      <div className="os-copy">
        <b className="tnum">{orderRef}</b>
        <button className="btn btn-outline btn-sm" type="button" onClick={copy}>
          <Ph name="copy-simple" size={18} /> {t("os.copy")}
        </button>
      </div>
    </section>
  );
}

/** Макет № 67: одно продление срока, без объяснений со стороны покупателя. */
function ExtendBlock({ orderRef, onDone }: { orderRef: string; onDone: () => void }) {
  const { t } = useT();
  const [busy, setBusy] = useState(false);
  const [used, setUsed] = useState(false);
  return (
    <section className="os-block">
      <p className="g-lbl">{t("os.extend")}</p>
      <p className="note">{t("os.extendD")}</p>
      <button
        className="btn btn-outline"
        type="button"
        disabled={busy || used}
        onClick={() => {
          setBusy(true);
          void publicApi
            .post(`/api/public/me/orders/${encodeURIComponent(orderRef)}/extend`)
            .then(() => { say(t("os.extendOk")); onDone(); })
            .catch((e: unknown) => {
              if (e instanceof PublicApiError && e.message === "already_extended") {
                setUsed(true);
                say(t("os.extendUsed"));
              } else say(t("err.generic"));
            })
            .finally(() => setBusy(false));
        }}
      >
        <Ph name="clock" size={18} /> {used ? t("os.extendUsed") : t("os.extend")}
      </button>
    </section>
  );
}

/** Макет № 76: выдача другому человеку — имя на стойке рядом с кодом. */
function ProxyBlock({ order, onDone }: { order: OrderState; onDone: () => void }) {
  const { t } = useT();
  const [draft, setDraft] = useState(order.pickupProxyName);
  const [busy, setBusy] = useState(false);

  const send = (name: string) => {
    setBusy(true);
    void publicApi
      .post(`/api/public/me/orders/${encodeURIComponent(order.ref)}/proxy`, { name })
      .then(() => { say(t("os.proxySaved")); onDone(); })
      .catch(() => say(t("err.generic")))
      .finally(() => setBusy(false));
  };

  return (
    <section className="os-block">
      <p className="g-lbl">{t("os.proxyT")}</p>
      <p className="note">{t("os.proxyD")}</p>
      <div className="os-copy">
        <label className="fld" style={{ flex: 1, minWidth: 0 }}>
          <span className="sr">{t("os.proxyName")}</span>
          <input type="text" autoComplete="name" maxLength={120} placeholder={t("os.proxyName")}
                 value={draft} onChange={(e) => setDraft(e.target.value)} />
        </label>
        <button className="btn btn-outline btn-sm" type="button" disabled={busy || !draft.trim()}
                onClick={() => send(draft.trim())}>{t("os.proxySave")}</button>
        {order.pickupProxyName && (
          <button className="btn btn-outline btn-sm" type="button" disabled={busy}
                  onClick={() => { setDraft(""); send(""); }}>{t("os.proxyClear")}</button>
        )}
      </div>
    </section>
  );
}

/** Наши статусы посылки на языке интерфейса — сырой код перевозчика
 *  покупателю ничего не говорит. */
const SHIP_STATUS: Record<string, string> = {
  registered: "os.shipRegistered",
  in_transit: "os.shipTransit",
  at_point: "os.shipAtPoint",
  delivered: "os.shipDelivered",
  unclaimed: "os.shipUnclaimed",
  returned: "os.shipReturned",
  cancelled: "os.shipCancelled",
};

/** Макеты № 77 и 77b: посылку не забрали — повторная отправка за плату. */
function ReshipBlock({ order, onDone }: { order: OrderState; onDone: () => void }) {
  const { t } = useT();
  const [busy, setBusy] = useState(false);
  const [asked, setAsked] = useState(order.fees.some((f) => f.type === "reship"));
  const priceCents = order.shippingCents || 690;

  return (
    <section className="os-block">
      <p className="g-lbl">{t("os.unclaimedT")}</p>
      <p className="note">{t("os.unclaimedD", { sum: formatEur(priceCents) })}</p>
      {order.shipment && (
        <div className="prow-s">
          <span className="k">{t("os.shipStatus")}</span>
          <b className="tnum">{order.shipment.barcode}</b>
          <small>{order.shipment.provider.toUpperCase()} · {t(SHIP_STATUS[order.shipment.status] ?? "os.shipStatus")}</small>
        </div>
      )}
      {asked ? (
        <p className="note">{t("os.reshipAsked")}</p>
      ) : (
        <div className="acts">
          <button
            className="btn btn-primary" type="button" disabled={busy}
            onClick={() => {
              setBusy(true);
              void publicApi
                .post(`/api/public/me/orders/${encodeURIComponent(order.ref)}/reship`)
                .then(() => { setAsked(true); say(t("os.reshipAsked")); onDone(); })
                .catch(() => say(t("err.generic")))
                .finally(() => setBusy(false));
            }}
          >
            <Ph name="package" size={18} /> {t("os.reship")}
          </button>
        </div>
      )}
    </section>
  );
}

const REASONS = ["not_as_described", "damaged", "changed_mind", "other"] as const;
const REASON_KEY: Record<string, string> = {
  not_as_described: "os.rsNotAs", damaged: "os.rsDamaged", changed_mind: "os.rsChanged", other: "os.rsOther",
};

/** Макет № 68: заявка на возврат в течение 14 дней и её состояние. */
function ReturnBlock({ order, onDone }: { order: OrderState; onDone: () => void }) {
  const { t, lang } = useT();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<string>("not_as_described");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  if (order.status !== "paid" && !order.returnCase) return null;

  const c = order.returnCase;
  if (c) {
    const decision =
      c.decision === "refund_full" ? t("os.retDecFull")
      : c.decision === "refund_partial" ? t("os.retDecPartial")
      : c.decision === "rejected" ? t("os.retDecRejected")
      : null;
    return (
      <section className="os-block">
        <p className="g-lbl">{t("os.retCase")}</p>
        <div className="prow-s">
          <span className="k">{c.ref}</span>
          <b>{c.status === "open" ? t("os.retOpenSt") : t("os.retDoneSt")}</b>
          <small>
            {t(REASON_KEY[c.reason] ?? "os.rsOther")} ·{" "}
            {new Date(c.createdAt).toLocaleDateString(dateLocale(lang))}
          </small>
        </div>
        {decision && (
          <div className="prow-s">
            <span className="k">{t("rs.colResult")}</span>
            <b>{decision}</b>
            {c.refundCents > 0 && <small className="tnum">{formatEur(c.refundCents)}</small>}
          </div>
        )}
      </section>
    );
  }

  return (
    <section className="os-block">
      <p className="g-lbl">{t("os.retT")}</p>
      <p className="note">{t("os.retD")}</p>
      {!open ? (
        <button className="btn btn-outline" type="button" onClick={() => setOpen(true)}>
          <Ph name="arrow-counter-clockwise" size={18} /> {t("os.retOpen")}
        </button>
      ) : (
        <form
          className="os-form"
          onSubmit={(e) => {
            e.preventDefault();
            setBusy(true);
            void publicApi
              .post<{ ref: string; withinWindow: boolean }>(
                `/api/public/me/orders/${encodeURIComponent(order.ref)}/return`,
                { reason, note: note.trim() || undefined },
              )
              .then((r) => {
                say(t("os.retSent", { ref: r.ref }));
                if (!r.withinWindow) say(t("os.retLate"));
                setOpen(false);
                onDone();
              })
              .catch(() => say(t("err.generic")))
              .finally(() => setBusy(false));
          }}
        >
          <fieldset className="os-reasons">
            <legend className="g-lbl">{t("os.retReason")}</legend>
            {REASONS.map((r) => (
              <label className="os-radio" key={r}>
                <input type="radio" name="os-reason" value={r} checked={reason === r} onChange={() => setReason(r)} />
                <span>{t(REASON_KEY[r] ?? "os.rsOther")}</span>
              </label>
            ))}
          </fieldset>
          <label className="fld">
            <span>{t("os.retNote")}</span>
            <textarea rows={3} value={note} maxLength={2000} onChange={(e) => setNote(e.target.value)} />
          </label>
          <div className="acts">
            <button className="btn btn-primary" type="submit" disabled={busy}>{t("os.retSend")}</button>
            <button className="btn btn-outline" type="button" onClick={() => setOpen(false)}>{t("nav.cancel")}</button>
          </div>
        </form>
      )}
    </section>
  );
}
