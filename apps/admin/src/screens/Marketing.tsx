import { useCallback, useEffect, useState } from "react";
import { api } from "../api.js";
import type { Nav } from "../App.js";
import { formatDay, formatEur } from "../format.js";
import { orderStatusLabel, useT } from "../i18n.js";
import { dateInputStyle } from "../powerkit.js";
import { attrRoute } from "./Orders.js";
import { AT, ORDER_STATUS_TONE } from "../theme.js";
import { ABadge, ABtn, ACard, ADrawer, AEmpty, APills, ATable, ATd, ATr } from "../ui.js";

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
  model: "first" | "last";
  rows: MarketingRow[];
  totals: { registrations: number; orders: number; paidOrders: number; revenueCents: number };
}

interface DetailResponse {
  key: { source: string; medium: string; campaign: string };
  model: "first" | "last";
  registrations: Array<{
    id: string; alias: string; email: string; country: string | null;
    createdAt: string; marketingOptIn: boolean; landing: string; referrer: string;
  }>;
  orders: Array<{
    id: string; ref: string; customerId: string; customerAlias: string;
    status: string; totalCents: number; createdAt: string; landing: string;
  }>;
  revenueCents: number;
}

const day = (d: Date) => d.toISOString().slice(0, 10);

/** Хост из полного реферера: https://l.facebook.com/l.php?u=… → l.facebook.com */
const refHost = (url: string): string => {
  try { return new URL(url).host.replace(/^www\./, ""); } catch { return url.slice(0, 40); }
};

/**
 * Отдача рекламы.
 *
 * Каждая строка — источник+кампания из utm-меток: сколько привёл регистраций,
 * заказов и оплаченной выручки. Расходы живут в кабинетах Meta/Google — ROI
 * считается сверкой их трат с этой выручкой: наша сторона тут честная, из
 * своей базы.
 *
 * Строка кликабельна: цифра «2 заказа» сама по себе бесполезна, вопрос всегда
 * следующий — какие это заказы и что за люди. Ответ открывается рядом.
 */
export function MarketingScreen({ nav }: { nav: Nav }) {
  const { t } = useT();
  const [from, setFrom] = useState(() => day(new Date(Date.now() - 30 * 86_400_000)));
  const [to, setTo] = useState(() => day(new Date()));
  const [model, setModel] = useState<"first" | "last">("first");
  const [report, setReport] = useState<MarketingReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<MarketingRow | null>(null);
  const [detail, setDetail] = useState<DetailResponse | null>(null);

  const load = useCallback(() => {
    setError(null);
    void api
      .get<MarketingReport>(`/api/reports/marketing?from=${from}&to=${to}&model=${model}`)
      .then(setReport)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [from, to, model]);

  useEffect(() => { load(); }, [load]);

  // Расшифровка строки грузится при открытии, а не вместе с отчётом: строк
  // бывают десятки, и тянуть подробности всех ради одной — расточительство.
  useEffect(() => {
    if (!picked) { setDetail(null); return; }
    const p = new URLSearchParams({
      from, to, model,
      source: picked.source, medium: picked.medium, campaign: picked.campaign,
    });
    let alive = true;
    void api
      .get<DetailResponse>(`/api/reports/marketing/detail?${p.toString()}`)
      .then((d) => { if (alive) setDetail(d); })
      .catch(() => { if (alive) setDetail(null); });
    return () => { alive = false; };
  }, [picked, from, to, model]);

  const label = (r: { source: string; campaign: string; referrer: string }): string => {
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

      {/* Две модели атрибуции. Разница между ними — это и есть весь вклад
          писем и ретаргетинга: в модели первого касания его не видно. */}
      <div style={{ display: "grid", gap: 6 }}>
        <APills
          options={[
            { id: "first" as const, label: t("mk.model.first") },
            { id: "last" as const, label: t("mk.model.last") },
          ]}
          value={model}
          onChange={(v) => setModel(v)}
        />
        <span style={{ fontFamily: AT.body, fontSize: 12, color: AT.inkSoft, maxWidth: "72ch" }}>{t("mk.modelHint")}</span>
      </div>

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
              <ATr key={`${r.source}|${r.medium}|${r.campaign}`} onClick={() => setPicked(r)}>
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

      <p style={{ fontFamily: AT.body, fontSize: 12.5, color: AT.inkSoft, margin: 0, maxWidth: "72ch" }}>
        {rows.length > 0 ? `${t("mk.rowHint")} ` : ""}{t("mk.hint")}
      </p>

      {picked && (
        <ADrawer
          title={`${t("mk.detail")} · ${label(picked)}`}
          onClose={() => setPicked(null)}
          width={640}
          footer={
            <>
              <ABtn
                kind="ghost"
                onClick={() => nav.go("orders", attrRoute(model, picked.source, picked.medium, picked.campaign))}
              >
                {t("mk.detail.openOrders")}
              </ABtn>
              <ABtn onClick={() => setPicked(null)}>{t("c.close")}</ABtn>
            </>
          }
        >
          {!detail ? (
            <AEmpty text={t("c.loading")} />
          ) : detail.registrations.length === 0 && detail.orders.length === 0 ? (
            <AEmpty text={t("mk.detail.empty")} />
          ) : (
            <div style={{ display: "grid", gap: 14 }}>
              {detail.orders.length > 0 && (
                <ACard title={`${t("mk.detail.orders")} (${detail.orders.length}) · ${formatEur(detail.revenueCents)}`} pad={false}>
                  <ATable head={[t("c.date"), t("ord.thOrder"), t("ord.thBidder"), t("c.total"), t("c.status")]}>
                    {detail.orders.map((o) => (
                      <ATr key={o.id} onClick={() => nav.go("orders", o.id)}>
                        <ATd>{formatDay(o.createdAt)}</ATd>
                        <ATd mono>{o.ref}</ATd>
                        <ATd>{o.customerAlias}</ATd>
                        <ATd mono right>{formatEur(o.totalCents)}</ATd>
                        <ATd>
                          <ABadge tone={ORDER_STATUS_TONE[o.status]?.tone ?? "neutral"}>
                            {orderStatusLabel(o.status)}
                          </ABadge>
                        </ATd>
                      </ATr>
                    ))}
                  </ATable>
                </ACard>
              )}

              {detail.registrations.length > 0 && (
                <ACard title={`${t("mk.detail.regs")} (${detail.registrations.length})`} pad={false}>
                  <ATable head={[t("c.date"), t("ord.thBidder"), t("attr.landing"), t("cd.consent.marketing")]}>
                    {detail.registrations.map((c) => (
                      <ATr key={c.id} onClick={() => nav.go("customers", c.id)}>
                        <ATd>{formatDay(c.createdAt)}</ATd>
                        <ATd>
                          <div style={{ fontWeight: 600 }}>{c.alias}</div>
                          <div style={{ fontSize: 10.5, color: AT.inkSoft }}>{c.email}</div>
                        </ATd>
                        <ATd mono>{c.landing || "—"}</ATd>
                        <ATd>{c.marketingOptIn ? t("c.yes") : t("c.no")}</ATd>
                      </ATr>
                    ))}
                  </ATable>
                </ACard>
              )}
            </div>
          )}
        </ADrawer>
      )}
    </div>
  );
}
