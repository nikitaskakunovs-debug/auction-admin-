import { useCallback, useEffect, useState } from "react";
import { api } from "../api.js";
import { formatEur } from "../format.js";
import { useT } from "../i18n.js";
import { dateInputStyle } from "../powerkit.js";
import { AT } from "../theme.js";
import { ABtn, ACard, AEmpty, ATable, ATd, ATr } from "../ui.js";

interface MarketingRow {
  source: string;
  medium: string;
  campaign: string;
  referrer: string;
  registrations: number;
  orders: number;
  paidOrders: number;
  revenueCents: number;
}

interface MarketingReport {
  rows: MarketingRow[];
  totals: { registrations: number; orders: number; paidOrders: number; revenueCents: number };
}

const day = (d: Date) => d.toISOString().slice(0, 10);

/** Хост из полного реферера: https://l.facebook.com/l.php?u=… → l.facebook.com */
const refHost = (url: string): string => {
  try { return new URL(url).host.replace(/^www\./, ""); } catch { return url.slice(0, 40); }
};

/**
 * Отдача рекламы (атрибуция первого касания).
 *
 * Каждая строка — источник+кампания из utm-меток рекламной ссылки: сколько
 * привёл регистраций, заказов и оплаченной выручки. Расходы на рекламу живут
 * в кабинетах Meta/Google — ROI считается сверкой их трат с этой выручкой:
 * наша сторона тут честная, из своей базы.
 */
export function MarketingScreen() {
  const { t } = useT();
  const [from, setFrom] = useState(() => day(new Date(Date.now() - 30 * 86_400_000)));
  const [to, setTo] = useState(() => day(new Date()));
  const [report, setReport] = useState<MarketingReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    void api
      .get<MarketingReport>(`/api/reports/marketing?from=${from}&to=${to}`)
      .then(setReport)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [from, to]);

  useEffect(() => { load(); }, [load]);

  const label = (r: MarketingRow): string => {
    if (r.source) return r.campaign ? `${r.source} · ${r.campaign}` : r.source;
    if (r.referrer) return refHost(r.referrer);
    return t("mk.direct");
  };

  const rows = report?.rows ?? [];
  const totals = report?.totals;

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <h1 style={{ fontFamily: AT.body, fontSize: 20, fontWeight: 700, color: AT.ink, flex: 1 }}>{t("mk.title")}</h1>
        <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontFamily: AT.body, fontSize: 12.5, color: AT.inkSoft }}>
          {t("mk.from")}
          <input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} style={dateInputStyle} />
          {t("mk.to")}
          <input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} style={dateInputStyle} />
        </label>
      </div>

      <p style={{ fontFamily: AT.body, fontSize: 13, color: AT.inkSoft, margin: 0, maxWidth: "72ch" }}>{t("mk.intro")}</p>

      <ACard pad={false}>
        {error !== null ? (
          <div style={{ display: "grid", gap: 10, justifyItems: "start", padding: 18 }}>
            <span style={{ fontFamily: AT.body, fontSize: 13.5, color: AT.danger }}>{t("mk.loadFailed")}: {error}</span>
            <ABtn kind="ghost" onClick={load}>{t("c.refresh")}</ABtn>
          </div>
        ) : rows.length === 0 ? (
          <AEmpty text={t("mk.empty")} />
        ) : (
          <ATable head={[t("mk.source"), t("mk.registrations"), t("mk.orders"), t("mk.paid"), t("mk.revenue"), t("mk.revPerReg")]}>
            {rows.map((r) => (
              <ATr key={`${r.source}|${r.medium}|${r.campaign}`}>
                <ATd>
                  <div style={{ fontWeight: 600 }}>{label(r)}</div>
                  {(r.medium || (r.source && r.referrer)) && (
                    <div style={{ fontSize: 10.5, color: AT.inkSoft }}>
                      {[r.medium, r.source && r.referrer ? refHost(r.referrer) : ""].filter(Boolean).join(" · ")}
                    </div>
                  )}
                </ATd>
                <ATd mono right>{r.registrations || "—"}</ATd>
                <ATd mono right>{r.orders || "—"}</ATd>
                <ATd mono right>{r.paidOrders || "—"}</ATd>
                <ATd mono right>{r.revenueCents > 0 ? formatEur(r.revenueCents) : "—"}</ATd>
                <ATd mono right>
                  {r.registrations > 0 && r.revenueCents > 0
                    ? formatEur(Math.round(r.revenueCents / r.registrations))
                    : "—"}
                </ATd>
              </ATr>
            ))}
            {totals && (
              <ATr>
                <ATd><strong>{t("mk.total")}</strong></ATd>
                <ATd mono right><strong>{totals.registrations}</strong></ATd>
                <ATd mono right><strong>{totals.orders}</strong></ATd>
                <ATd mono right><strong>{totals.paidOrders}</strong></ATd>
                <ATd mono right><strong>{formatEur(totals.revenueCents)}</strong></ATd>
                <ATd right>{""}</ATd>
              </ATr>
            )}
          </ATable>
        )}
      </ACard>

      <p style={{ fontFamily: AT.body, fontSize: 12.5, color: AT.inkSoft, margin: 0, maxWidth: "72ch" }}>{t("mk.hint")}</p>
    </div>
  );
}
