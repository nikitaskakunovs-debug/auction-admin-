"use client";

import { useEffect, useState } from "react";
import { publicApi } from "@/lib/api";
import { PUBLIC_API_URL } from "@/lib/config";
import { dateLocale, useT } from "@/lib/i18n";
import { formatEur } from "@/lib/types";
import { Ph } from "../Ph";
import { say } from "../Toast";

/** Чек после оплаты (макет № 41): статус, код выдачи, шаги, данные платежа. */
interface ReceiptData {
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
  paidAt: string | null;
  fulfilment: string;
  pickupCode: string | null;
  invoiceNumber: string | null;
  payment: { provider: string; method: string | null; providerId: string | null } | null;
}

export function Receipt({ orderRef, onBack }: { orderRef: string; onBack: () => void }) {
  const { t, lang } = useT();
  const [r, setR] = useState<ReceiptData | null | "missing">(null);

  useEffect(() => {
    void publicApi
      .get<ReceiptData>(`/api/public/me/orders/${encodeURIComponent(orderRef)}/receipt`)
      .then(setR)
      .catch(() => setR("missing"));
  }, [orderRef]);

  if (r === null) return <div className="acct" aria-busy="true" />;
  if (r === "missing") {
    return (
      <div className="acct">
        <button className="btn-back" type="button" onClick={onBack}>
          <Ph name="caret-right" size={14} className="flip" /> {t("kb.purchases")}
        </button>
        <div className="empty"><h3>{t("co.notFound")}</h3></div>
      </div>
    );
  }
  const when = r.paidAt
    ? new Date(r.paidAt).toLocaleString(dateLocale(lang), { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" })
    : "—";

  return (
    <div className="acct">
      <button className="btn-back" type="button" onClick={onBack}>
        <Ph name="caret-right" size={14} className="flip" /> {t("kb.purchases")}
      </button>
      <div className="page-head" style={{ alignItems: "flex-start" }}>
        <div>
          <h1 data-hero>{t("kb.receipt")}</h1>
          <p className="cnt">{t("kb.receiptSub")}</p>
        </div>
      </div>

      <div className="rcp-cols">
        <div className="rcp-main">
          <div className="rcp-head">
            <span className="ok" aria-hidden="true"><Ph name="check" size={20} /></span>
            <span className="t">
              <b>{t("kb.paidBig")}</b>
              <small className="tnum">{t("kb.orderN", { ref: r.ref })} · {when}</small>
            </span>
            <b className="sum tnum">{formatEur(r.totalCents)}</b>
          </div>

          {r.fulfilment === "pickup" && r.pickupCode && (
            <>
              <p className="g-lbl">{t("kb.whatNext")}</p>
              <div className="rcp-code">
                <span className="lbl">{t("pickup.code")}</span>
                <b className="tnum">{r.pickupCode}</b>
                <Ph name="qr-code" size={36} />
              </div>
              <ol className="rcp-steps">
                <li><i>1</i><span><b>{t("kb.stepCome", { addr: t("kb.addressShort") })}</b><small>{t("kb.addressHint")} · {t("kb.hoursVal")}</small></span></li>
                <li><i>2</i><span><b>{t("kb.stepCode")}</b><small>{t("kb.bringText")}</small></span></li>
                <li><i>3</i><span><b>{t("kb.stepCheck")}</b><small>{t("kb.stepCheckD")}</small></span></li>
              </ol>
            </>
          )}

          <div className="acts">
            <InvoicePdfButton orderRef={r.ref} disabled={r.invoiceNumber === null} />
          </div>
        </div>

        <aside className="rcp-side">
          <p className="g-lbl">{t("kb.payData")}</p>
          <div className="prow-s"><span className="k">{t("kb.lot")}</span><b className="tnum">{r.itemSku}</b><small>{r.itemTitle}</small></div>
          <div className="prow-s"><span className="k">{t("ac.hammer")}</span><b className="tnum">{formatEur(r.hammerCents)}</b></div>
          <div className="prow-s"><span className="k">{t("ac.premium")}</span><b className="tnum">{formatEur(r.premiumCents)}</b></div>
          <div className="prow-s"><span className="k">{t("ac.vat")}</span><b className="tnum">{formatEur(r.vatCents)}</b></div>
          {r.creditAppliedCents > 0 && (
            <div className="prow-s"><span className="k">{t("kb.creditRow")}</span><b className="tnum">−{formatEur(r.creditAppliedCents)}</b></div>
          )}
          <div className="prow-s"><span className="k">{t("kb.datums")}</span><b>{when}</b></div>
          <div className="prow-s">
            <span className="k">{t("kb.payKind")}</span>
            <b>{r.payment ? (r.payment.method ?? r.payment.provider) : r.creditAppliedCents >= r.totalCents ? t("kb.byCredit") : "—"}</b>
            {r.payment?.providerId && <small className="tnum">{t("kb.payId")}: {r.payment.providerId}</small>}
          </div>
        </aside>
      </div>
    </div>
  );
}

/** Кнопка «Rēķins PDF»: тянет файл со своим токеном и открывает вкладку. */
export function InvoicePdfButton({ orderRef, disabled }: { orderRef: string; disabled?: boolean }) {
  const { t } = useT();
  const [busy, setBusy] = useState(false);
  const open = async () => {
    setBusy(true);
    try {
      const res = await fetch(`${PUBLIC_API_URL}/api/public/me/orders/${encodeURIComponent(orderRef)}/invoice.pdf`, {
        headers: publicApi.accessToken ? { authorization: `Bearer ${publicApi.accessToken}` } : {},
      });
      if (!res.ok) { say(t("kb.invoiceMissing")); return; }
      const url = URL.createObjectURL(await res.blob());
      window.open(url, "_blank", "noopener");
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch { say(t("err.generic")); }
    finally { setBusy(false); }
  };
  return (
    <button className="btn btn-outline" type="button" disabled={busy || disabled}
            title={disabled ? t("kb.invoiceMissing") : undefined} onClick={() => void open()}>
      <Ph name="file-text" size={16} /> {t("ac.invoicePdf")}
    </button>
  );
}

/** Konta atlikums (макет № 71): аванс и движение денег. */
interface CreditEntry { kind: string; amountCents: number; orderRef: string | null; note: string; createdAt: string }

export function CreditBoard({ onChanged }: { onChanged?: () => void }) {
  const { t, lang } = useT();
  const [balance, setBalance] = useState(0);
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const [entries, setEntries] = useState<CreditEntry[]>([]);
  const [busy, setBusy] = useState(false);

  const load = () =>
    void publicApi
      .get<{ balanceCents: number; expiresAt: string | null; entries: CreditEntry[] }>("/api/public/me/credit")
      .then((r) => { setBalance(r.balanceCents); setExpiresAt(r.expiresAt); setEntries(r.entries); })
      .catch(() => undefined);
  useEffect(load, []);

  if (balance === 0 && entries.length === 0) return null;

  const short = (d: string) => new Date(d).toLocaleDateString(dateLocale(lang));
  const kindLabel = (e: CreditEntry) =>
    e.kind === "overpay" ? t("kb.ckOverpay")
    : e.kind === "refund_to_credit" ? t("kb.ckRefund")
    : e.kind === "used_for_order" ? t("kb.ckUsed", { ref: e.orderRef ?? "—" })
    : e.kind === "withdrawn" ? t("kb.ckWithdrawn")
    : t("kb.ckGrant");

  return (
    <section className="creditboard">
      <div className="cb-head">
        <span className="t">
          <small>{t("kb.creditAvail")}</small>
          <b className="tnum">{formatEur(balance)}</b>
          {expiresAt && balance > 0 && <small>{t("kb.until")} {short(expiresAt)}</small>}
        </span>
        {balance > 0 && (
          <button
            className="btn btn-outline btn-sm" type="button" disabled={busy}
            onClick={() => {
              setBusy(true);
              void publicApi.post("/api/public/me/credit/withdraw")
                .then(() => { say(t("kb.creditRequested")); load(); onChanged?.(); })
                .catch(() => say(t("err.generic")))
                .finally(() => setBusy(false));
            }}
          >{t("kb.creditWithdraw")}</button>
        )}
      </div>
      {entries.length > 0 && (
        <>
          <p className="g-lbl">{t("kb.creditMoves")}</p>
          {entries.map((e, i) => (
            <div className="cb-row" key={i}>
              <span className="t">
                <b>{kindLabel(e)}</b>
                <small>{short(e.createdAt)}{e.note ? ` · ${e.note}` : ""}</small>
              </span>
              <b className={`tnum ${e.amountCents < 0 ? "neg" : "pos"}`}>
                {e.amountCents < 0 ? "−" : "+"}{formatEur(Math.abs(e.amountCents))}
              </b>
            </div>
          ))}
        </>
      )}
      <p className="note">{t("kb.creditNote")} {t("kb.creditWithdrawD")}</p>
    </section>
  );
}
