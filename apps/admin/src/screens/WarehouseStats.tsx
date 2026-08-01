import { useEffect, useMemo, useState } from "react";
import { CATEGORIES } from "@auction/domain/categories";
import { api, ApiError } from "../api.js";
import type { Nav } from "../App.js";
import { exportCSV } from "../exporters.js";
import { formatEur } from "../format.js";
import { useT, type TKey } from "../i18n.js";
import { AT, toneColors, type Tone } from "../theme.js";
import { AAvatar, ABtn, ACard, ADrawer, AEmpty, APills, AStat, ATable, ATd, ATr } from "../ui.js";

/**
 * W3 — Warehouse stats: team totals for a period, per-day activity chart,
 * sortable per-worker table, and a who-did-what day timeline per worker.
 * Everything is read from records the system already keeps.
 *
 * R3 adds a second tab — "Kas pārdodas" — which answers the other half of the
 * question: not how fast the team works, but which categories actually sell
 * and which ones tie up a shelf. It reads /api/reports/sell-through, which
 * states its own basis; the screen prints that basis rather than restating it.
 */

interface WorkerRow {
  userId: string;
  name: string;
  received: number;
  putaway: number;
  moved: number;
  graded: number;
  picks: number;
  tickets: number;
  avgPickSec: number | null;
  picksPerHour: number | null;
  breakSec: number;
}

interface Totals {
  received: number;
  putaways: number;
  graded: number;
  picks: number;
  ticketsClosed: number;
  avgPickSec: number | null;
}

interface StatsPayload {
  from: string;
  to: string;
  totals: Totals;
  prev: Totals;
  workers: WorkerRow[];
  byDay: Array<{ day: string; received: number; putaway: number; picks: number; graded: number }>;
}

interface TimelineEntry {
  at: string;
  kind: string;
  sku?: string;
  itemId?: string;
  detail?: string;
}

type Period = "today" | "7d" | "30d" | "custom";

const utcDay = (d: Date) => d.toISOString().slice(0, 10);
const daysAgo = (n: number) => utcDay(new Date(Date.now() - n * 86_400_000));

/** m:ss for pick times, h m for breaks. */
const fmtSec = (s: number | null) => (s === null ? "—" : `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`);
const fmtDur = (s: number) => (s === 0 ? "—" : s < 3600 ? `${Math.round(s / 60)}m` : `${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m`);
const fmtTime = (iso: string) => new Date(iso).toLocaleTimeString("lv", { hour: "2-digit", minute: "2-digit" });

const KIND_META: Record<string, { key: TKey; tone: Tone }> = {
  intake: { key: "ws.k.intake", tone: "accent" },
  putaway: { key: "ws.k.putaway", tone: "accent" },
  move: { key: "ws.k.move", tone: "neutral" },
  restock: { key: "ws.k.restock", tone: "neutral" },
  adjust: { key: "ws.k.adjust", tone: "warn" },
  handover: { key: "ws.k.handover", tone: "ok" },
  pick: { key: "ws.k.pick", tone: "ok" },
  grade: { key: "ws.k.grade", tone: "warn" },
  ticket_done: { key: "ws.k.ticket_done", tone: "ok" },
  status: { key: "ws.k.status", tone: "neutral" },
};

const CHART = [
  { key: "received" as const, labelKey: "rcv.received" as const, color: AT.accent },
  { key: "putaway" as const, labelKey: "ws.putaway" as const, color: "#8B9BFF" },
  { key: "picks" as const, labelKey: "ws.picks" as const, color: AT.ok },
  { key: "graded" as const, labelKey: "ws.graded" as const, color: "#C9CFF2" },
];

const SORTS = [
  { id: "received", labelKey: "rcv.received" },
  { id: "putaway", labelKey: "ws.putaway" },
  { id: "graded", labelKey: "ws.graded" },
  { id: "picks", labelKey: "ws.picks" },
  { id: "tickets", labelKey: "ws.tickets" },
  { id: "avgPickSec", labelKey: "ws.avgPick" },
  { id: "picksPerHour", labelKey: "ws.picksPerHour" },
  { id: "breakSec", labelKey: "ws.breaks" },
] as const;
type SortId = (typeof SORTS)[number]["id"];

const SCREEN_TABS = [
  { id: "work" as const, labelKey: "whs.st.tabWork" as const },
  { id: "sell" as const, labelKey: "whs.st.tab" as const },
];
type ScreenTab = (typeof SCREEN_TABS)[number]["id"];

export function WarehouseStatsScreen({ nav }: { nav: Nav }) {
  const { t } = useT();
  const [tab, setTab] = useState<ScreenTab>("work");

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <h1 style={{ fontFamily: AT.body, fontSize: 20, fontWeight: 700, color: AT.ink }}>{t("ws.title")}</h1>
      <div style={{ display: "flex", gap: 2, borderBottom: `1px solid ${AT.rule}` }}>
        {SCREEN_TABS.map((tb) => (
          <button key={tb.id} onClick={() => setTab(tb.id)} style={{
            all: "unset", cursor: "pointer", padding: "9px 14px", fontFamily: AT.body,
            fontSize: 13, fontWeight: 600, color: tab === tb.id ? AT.ink : AT.inkSoft,
            borderBottom: `2px solid ${tab === tb.id ? AT.accent : "transparent"}`, marginBottom: -1,
          }}>{t(tb.labelKey)}</button>
        ))}
      </div>
      {tab === "work" ? <ProductivityTab /> : <SellThroughTab nav={nav} />}
    </div>
  );
}

// ── Tab 1: team productivity (W3) ───────────────────────────────────────────

function ProductivityTab() {
  const { t } = useT();
  const [period, setPeriod] = useState<Period>("7d");
  const [customFrom, setCustomFrom] = useState(daysAgo(7));
  const [customTo, setCustomTo] = useState(daysAgo(0));
  const [data, setData] = useState<StatsPayload | null>(null);
  const [failed, setFailed] = useState(false);
  const [sort, setSort] = useState<SortId>("picks");
  const [drill, setDrill] = useState<WorkerRow | null>(null);

  const range = useMemo(() => {
    if (period === "today") return { from: daysAgo(0), to: daysAgo(0) };
    if (period === "7d") return { from: daysAgo(6), to: daysAgo(0) };
    if (period === "30d") return { from: daysAgo(29), to: daysAgo(0) };
    return { from: customFrom, to: customTo };
  }, [period, customFrom, customTo]);

  useEffect(() => {
    let stale = false;
    setFailed(false);
    void api
      .get<StatsPayload>(`/api/warehouse/stats?from=${range.from}&to=${range.to}`)
      .then((r) => {
        if (!stale) setData(r);
      })
      .catch(() => {
        if (!stale) setFailed(true);
      });
    return () => {
      stale = true;
    };
  }, [range.from, range.to]);

  const workers = useMemo(() => {
    if (!data) return [];
    const list = [...data.workers];
    // Nulls (no measurable value) always sink to the bottom.
    list.sort((a, b) => {
      const av = a[sort];
      const bv = b[sort];
      if (av === null) return 1;
      if (bv === null) return -1;
      // Faster picks are better — ascending; everything else descending.
      return sort === "avgPickSec" ? av - bv : bv - av;
    });
    return list;
  }, [data, sort]);

  const delta = (cur: number, prev: number): string | undefined => {
    if (prev <= 0) return undefined;
    const pct = Math.round(((cur - prev) / prev) * 100);
    return pct === 0 ? undefined : `${pct > 0 ? "+" : ""}${pct}% ${t("ws.vsPrev")}`;
  };

  const exportRows = () =>
    exportCSV(
      "warehouse-stats",
      [t("ws.worker"), t("rcv.received"), t("ws.putaway"), t("ws.moved"), t("ws.graded"), t("ws.picks"), t("ws.tickets"), t("ws.avgPick"), t("ws.picksPerHour"), t("ws.breaks")],
      workers.map((w) => [
        w.name,
        String(w.received),
        String(w.putaway),
        String(w.moved),
        String(w.graded),
        String(w.picks),
        String(w.tickets),
        fmtSec(w.avgPickSec),
        w.picksPerHour === null ? "—" : String(w.picksPerHour),
        fmtDur(w.breakSec),
      ]),
    );

  const tot = data?.totals;
  const prevTot = data?.prev;

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <APills
            options={[
              { id: "today" as const, label: t("c.today") },
              { id: "7d" as const, label: t("ws.7d") },
              { id: "30d" as const, label: t("ws.30d") },
              { id: "custom" as const, label: t("ws.custom") },
            ]}
            value={period}
            onChange={setPeriod}
          />
          {period === "custom" && (
            <span style={{ display: "inline-flex", gap: 6, alignItems: "center", fontFamily: AT.body, fontSize: 12.5, color: AT.inkSoft }}>
              <input type="date" value={customFrom} max={customTo} onChange={(e) => setCustomFrom(e.target.value)} style={dateStyle} />
              –
              <input type="date" value={customTo} min={customFrom} max={daysAgo(0)} onChange={(e) => setCustomTo(e.target.value)} style={dateStyle} />
            </span>
          )}
          <ABtn kind="ghost" size="sm" onClick={exportRows} disabled={workers.length === 0}>{t("ws.exportCsv")}</ABtn>
        </div>
      </div>

      {failed && <ACard pad={false}><AEmpty text={t("ws.loadFailed")} /></ACard>}

      {tot && prevTot && (
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <AStat label={t("rcv.received")} value={tot.received} sub={delta(tot.received, prevTot.received)} />
          <AStat label={t("ws.putaways")} value={tot.putaways} sub={delta(tot.putaways, prevTot.putaways)} />
          <AStat label={t("ws.graded")} value={tot.graded} sub={delta(tot.graded, prevTot.graded)} />
          <AStat label={t("ws.picks")} value={tot.picks} sub={delta(tot.picks, prevTot.picks)} />
          <AStat label={t("ws.ticketsClosed")} value={tot.ticketsClosed} sub={delta(tot.ticketsClosed, prevTot.ticketsClosed)} />
          <AStat label={t("ws.avgPick")} value={fmtSec(tot.avgPickSec)} sub={prevTot.avgPickSec !== null && tot.avgPickSec !== null ? `${t("ws.prev")} ${fmtSec(prevTot.avgPickSec)}` : undefined} />
        </div>
      )}

      {data && data.byDay.length > 1 && <ActivityChart byDay={data.byDay} />}

      <ACard title={t("ws.perWorker")} pad={false} actions={
        <span style={{ fontFamily: AT.body, fontSize: 11.5, color: AT.inkSoft }}>
          {t("ws.sortHint")}
        </span>
      }>
        {workers.length === 0 ? (
          <AEmpty text={t("ws.empty")} />
        ) : (
          <ATable
            head={[
              t("ws.worker"),
              ...SORTS.map((s) => (
                <button
                  key={s.id}
                  onClick={() => setSort(s.id)}
                  style={{
                    all: "unset", cursor: "pointer", fontWeight: 700,
                    color: sort === s.id ? AT.accent : undefined,
                  }}
                >
                  {t(s.labelKey)}{sort === s.id ? " ↓" : ""}
                </button>
              )),
            ]}
          >
            {workers.map((w) => (
              <ATr key={w.userId} onClick={() => setDrill(w)}>
                <ATd>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 8, fontWeight: 600 }}>
                    <AAvatar name={w.name} size={22} />{w.name}
                  </span>
                </ATd>
                <ATd right>{w.received}</ATd>
                <ATd right>{w.putaway}</ATd>
                <ATd right>{w.graded}</ATd>
                <ATd right>{w.picks}</ATd>
                <ATd right>{w.tickets}</ATd>
                <ATd right mono>{fmtSec(w.avgPickSec)}</ATd>
                <ATd right mono>{w.picksPerHour ?? "—"}</ATd>
                <ATd right mono>{fmtDur(w.breakSec)}</ATd>
              </ATr>
            ))}
          </ATable>
        )}
      </ACard>

      {drill && <TimelineDrawer worker={drill} defaultDay={range.to} minDay={range.from} onClose={() => setDrill(null)} />}
    </div>
  );
}

const dateStyle: React.CSSProperties = {
  height: 32, borderRadius: AT.radiusSm, border: `1px solid ${AT.rule}`, background: AT.panel,
  fontFamily: AT.body, fontSize: 12.5, color: AT.ink, padding: "0 8px",
};

// ── Per-day stacked bars (inline SVG, no chart lib) ─────────────────────────

function ActivityChart({ byDay }: { byDay: StatsPayload["byDay"] }) {
  const { t } = useT();
  const W = 700;
  const H = 132;
  const plotH = 104;
  const max = Math.max(1, ...byDay.map((d) => d.received + d.putaway + d.picks + d.graded));
  const slot = W / byDay.length;
  const barW = Math.min(48, slot * 0.55);

  return (
    <ACard title={t("ws.activityByDay")}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={t("ws.chartAria")}>
        <line x1="0" y1={plotH} x2={W} y2={plotH} stroke={AT.rule} />
        {byDay.map((d, i) => {
          const x = i * slot + (slot - barW) / 2;
          let y = plotH;
          return (
            <g key={d.day}>
              {CHART.map((seg) => {
                const h = (d[seg.key] / max) * (plotH - 8);
                y -= h;
                return h > 0 ? <rect key={seg.key} x={x} y={y} width={barW} height={h} fill={seg.color} /> : null;
              })}
              <text x={x + barW / 2} y={H - 8} fontSize="10" fill={AT.inkSoft} textAnchor="middle" fontFamily={AT.body}>
                {d.day.slice(5).replace("-", "/")}
              </text>
            </g>
          );
        })}
      </svg>
      <div style={{ display: "flex", gap: 16, marginTop: 6, fontFamily: AT.body, fontSize: 11.5, color: AT.inkSoft }}>
        {CHART.map((seg) => (
          <span key={seg.key} style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
            <span style={{ width: 9, height: 9, borderRadius: 2, background: seg.color, display: "inline-block" }} />
            {t(seg.labelKey)}
          </span>
        ))}
      </div>
    </ACard>
  );
}

// ── Who-did-what timeline drawer ────────────────────────────────────────────

function TimelineDrawer({ worker, defaultDay, minDay, onClose }: {
  worker: WorkerRow;
  defaultDay: string;
  minDay: string;
  onClose: () => void;
}) {
  const { t } = useT();
  const [day, setDay] = useState(defaultDay);
  const [entries, setEntries] = useState<TimelineEntry[] | null>(null);

  useEffect(() => {
    setEntries(null);
    void api
      .get<{ entries: TimelineEntry[] }>(`/api/warehouse/stats/timeline?userId=${worker.userId}&day=${day}`)
      .then((r) => setEntries(r.entries))
      .catch(() => setEntries([]));
  }, [worker.userId, day]);

  return (
    <ADrawer
      title={<span style={{ display: "inline-flex", alignItems: "center", gap: 9 }}><AAvatar name={worker.name} size={24} />{worker.name}</span>}
      onClose={onClose}
      width={460}
    >
      <div style={{ display: "grid", gap: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <input type="date" value={day} min={minDay} max={utcDay(new Date())} onChange={(e) => setDay(e.target.value)} style={dateStyle} />
          <span style={{ fontFamily: AT.body, fontSize: 12, color: AT.inkSoft }}>
            {entries === null ? t("c.loading") : `${entries.length} ${t("ws.actionsWord")}`}
          </span>
        </div>
        {entries !== null && entries.length === 0 && (
          <div style={{ fontFamily: AT.body, fontSize: 13, color: AT.inkSoft }}>{t("ws.noActions")}</div>
        )}
        <div style={{ display: "grid" }}>
          {(entries ?? []).map((e, i) => {
            const meta = KIND_META[e.kind];
            const c = toneColors[meta?.tone ?? ("neutral" as Tone)];
            return (
              <div key={i} style={{
                display: "flex", alignItems: "baseline", gap: 10, padding: "7px 0",
                borderBottom: `1px solid ${AT.ruleSoft}`, fontFamily: AT.body, fontSize: 13,
              }}>
                <span style={{ fontFamily: AT.mono, fontSize: 11.5, color: AT.inkSoft, flexShrink: 0, width: 38 }}>{fmtTime(e.at)}</span>
                <span style={{
                  background: c.bg, color: c.fg, borderRadius: 999, padding: "1px 9px",
                  fontSize: 11, fontWeight: 700, flexShrink: 0,
                }}>{meta ? t(meta.key) : e.kind}</span>
                <span style={{ minWidth: 0 }}>
                  {e.sku && <span style={{ fontFamily: AT.mono, fontSize: 12, fontWeight: 700, marginRight: 6 }}>{e.sku}</span>}
                  {e.detail && <span style={{ color: AT.inkSoft }}>{e.detail}</span>}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </ADrawer>
  );
}

// ── Tab 2: R3 — what sells, what sits ───────────────────────────────────────

interface CategoryRow {
  category: string;
  offered: number;
  soldFromOffered: number;
  sellThroughPct: number | null;
  soldInPeriod: number;
  revenueCents: number;
  avgDaysToSell: number | null;
  avgPriceCents: number | null;
  /** Finance-only: absent entirely for roles without finance.view. */
  profitCents?: number | null;
  noCostData?: number;
}

interface AgingRow {
  category: string;
  units: number;
  d0_30: number;
  d31_60: number;
  d61_90: number;
  d90plus: number;
}

interface SittingRow {
  id: string;
  sku: string;
  title: string;
  category: string;
  status: string;
  daysOnShelf: number;
  timesListed: number;
}

interface SellThroughPayload {
  from: string;
  to: string;
  asOf: string;
  basis: { sellThrough: string; daysToSell: string; excluded: string };
  totals: { soldInPeriod: number; offered: number; soldFromOffered: number; revenueCents: number };
  byCategory: CategoryRow[];
  auctionOutcomes: { ended: number; won: number; noBids: number; reserveNotMet: number; cancelledExcluded: number };
  aging: AgingRow[];
  sittingLongest: SittingRow[];
}

type SellPeriod = "30d" | "90d" | "12m" | "custom";

/** Visible category names, same map the Inventory screen uses; unknown codes
 * fall back to the domain label and then to the raw code. */
const CATEGORY_KEY: Record<string, TKey> = {
  electronics: "inv.cat.electronics",
  appliances: "inv.cat.appliances",
  furniture: "inv.cat.furniture",
  tools: "inv.cat.tools",
  home_garden: "inv.cat.home_garden",
  jewellery_watches: "inv.cat.jewellery_watches",
  art_antiques: "inv.cat.art_antiques",
  sports_outdoors: "inv.cat.sports_outdoors",
  kids_toys: "inv.cat.kids_toys",
  fashion: "inv.cat.fashion",
  food_household: "inv.cat.food_household",
  other: "inv.cat.other",
};

/** 70%+ is healthy, 40–69% needs a look, below that the category is stuck. */
const healthTone = (pct: number): Tone => (pct >= 70 ? "ok" : pct >= 40 ? "warn" : "danger");

/** The report's `to` is exclusive, so the last day the operator picked has to
 * be handed over as the next day or its sales silently drop out. */
const nextDay = (day: string) => utcDay(new Date(new Date(`${day}T00:00:00Z`).getTime() + 86_400_000));

const AGE_BANDS = [
  { key: "d0_30" as const, labelKey: "whs.st.age0_30" as const, color: AT.ok },
  { key: "d31_60" as const, labelKey: "whs.st.age31_60" as const, color: AT.accent },
  { key: "d61_90" as const, labelKey: "whs.st.age61_90" as const, color: AT.warn },
  { key: "d90plus" as const, labelKey: "whs.st.age90plus" as const, color: AT.danger },
];

function SellThroughTab({ nav }: { nav: Nav }) {
  const { t } = useT();
  const [period, setPeriod] = useState<SellPeriod>("90d");
  const [customFrom, setCustomFrom] = useState(daysAgo(89));
  const [customTo, setCustomTo] = useState(daysAgo(0));
  const [data, setData] = useState<SellThroughPayload | null>(null);
  /** null = fine, "forbidden" = the API refused, "failed" = anything else. */
  const [problem, setProblem] = useState<"forbidden" | "failed" | null>(null);

  const catLabel = (code: string): string => {
    const k = CATEGORY_KEY[code];
    return k ? t(k) : CATEGORIES.find((c) => c.code === code)?.label ?? code;
  };

  const range = useMemo(() => {
    if (period === "30d") return { from: daysAgo(29), to: daysAgo(0) };
    if (period === "90d") return { from: daysAgo(89), to: daysAgo(0) };
    if (period === "12m") return { from: daysAgo(364), to: daysAgo(0) };
    return { from: customFrom, to: customTo };
  }, [period, customFrom, customTo]);

  useEffect(() => {
    let stale = false;
    setProblem(null);
    void api
      .get<SellThroughPayload>(`/api/reports/sell-through?from=${range.from}&to=${nextDay(range.to)}`)
      .then((r) => {
        if (!stale) setData(r);
      })
      .catch((err: unknown) => {
        if (stale) return;
        setData(null);
        setProblem(err instanceof ApiError && err.status === 403 ? "forbidden" : "failed");
      });
    return () => {
      stale = true;
    };
  }, [range.from, range.to]);

  // The profit column exists only when the API sent the key — its absence is
  // how the server says "not yours to see", and we never invent a column.
  const showProfit = (data?.byCategory ?? []).some((r) => "profitCents" in r);

  const catRows = useMemo(() => {
    const rows = [...(data?.byCategory ?? [])];
    // Best sell-through first; categories with nothing offered sink last —
    // they have no rate at all, rather than a bad one.
    rows.sort((a, b) => {
      if (a.sellThroughPct === null) return b.sellThroughPct === null ? 0 : 1;
      if (b.sellThroughPct === null) return -1;
      return b.sellThroughPct - a.sellThroughPct || b.soldInPeriod - a.soldInPeriod;
    });
    return rows;
  }, [data]);

  const exportRows = () =>
    exportCSV(
      "sell-through",
      [
        t("inv.category"), t("whs.st.offered"), t("whs.st.thSold"), t("whs.st.thSellThrough"),
        t("whs.st.thAvgDays"), t("whs.st.thAvgPrice"), ...(showProfit ? [t("whs.st.thProfit")] : []),
      ],
      catRows.map((r) => [
        catLabel(r.category),
        String(r.offered),
        String(r.soldInPeriod),
        r.sellThroughPct === null ? "—" : `${r.sellThroughPct}%`,
        r.avgDaysToSell === null ? "—" : String(r.avgDaysToSell),
        r.avgPriceCents === null ? "—" : formatEur(r.avgPriceCents),
        ...(showProfit ? [r.profitCents == null ? t("whs.st.noCost") : formatEur(r.profitCents)] : []),
      ]),
    );

  const tot = data?.totals;
  const offeredPct = tot && tot.offered > 0 ? Math.round((tot.soldFromOffered / tot.offered) * 100) : null;

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <APills
          options={[
            { id: "30d" as const, label: t("ws.30d") },
            { id: "90d" as const, label: t("whs.st.90d") },
            { id: "12m" as const, label: t("whs.st.12m") },
            { id: "custom" as const, label: t("ws.custom") },
          ]}
          value={period}
          onChange={setPeriod}
        />
        {period === "custom" && (
          <span style={{ display: "inline-flex", gap: 6, alignItems: "center", fontFamily: AT.body, fontSize: 12.5, color: AT.inkSoft }}>
            <input type="date" value={customFrom} max={customTo} onChange={(e) => setCustomFrom(e.target.value)} style={dateStyle} />
            –
            <input type="date" value={customTo} min={customFrom} max={daysAgo(0)} onChange={(e) => setCustomTo(e.target.value)} style={dateStyle} />
          </span>
        )}
        <ABtn kind="ghost" size="sm" style={{ marginLeft: "auto" }} onClick={exportRows} disabled={catRows.length === 0}>
          {t("ws.exportCsv")}
        </ABtn>
      </div>

      {problem && (
        <ACard pad={false}>
          <AEmpty text={problem === "forbidden" ? t("whs.st.forbidden") : t("ws.loadFailed")} />
        </ACard>
      )}

      {tot && (
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <AStat label={t("whs.st.soldInPeriod")} value={tot.soldInPeriod} />
          <AStat label={t("whs.st.offered")} value={tot.offered} />
          <AStat
            label={t("whs.st.soldFromOffered")}
            value={tot.soldFromOffered}
            sub={offeredPct === null ? undefined : `${offeredPct}% ${t("whs.st.ofOffered")}`}
          />
          <AStat label={t("whs.st.revenue")} value={formatEur(tot.revenueCents)} />
        </div>
      )}

      {data && <CategoryBars rows={catRows} label={catLabel} />}

      {!problem && (
        <ACard title={t("whs.st.byCategory")} pad={false}>
          {catRows.length === 0 ? (
            <AEmpty text={data ? t("whs.st.catEmpty") : t("c.loading")} />
          ) : (
            <ATable
              head={[
                t("inv.category"), t("whs.st.offered"), t("whs.st.thSold"), t("whs.st.thSellThrough"),
                t("whs.st.thAvgDays"), t("whs.st.thAvgPrice"), ...(showProfit ? [t("whs.st.thProfit")] : []),
              ]}
            >
              {catRows.map((r) => (
                <ATr key={r.category}>
                  <ATd><span style={{ fontWeight: 600 }}>{catLabel(r.category)}</span></ATd>
                  <ATd right mono>{r.offered}</ATd>
                  <ATd right mono>{r.soldInPeriod}</ATd>
                  <ATd right mono style={r.sellThroughPct === null ? { color: AT.inkSoft } : { color: toneColors[healthTone(r.sellThroughPct)].fg, fontWeight: 700 }}>
                    {r.sellThroughPct === null ? "—" : `${r.sellThroughPct}%`}
                  </ATd>
                  <ATd right mono>{r.avgDaysToSell === null ? "—" : r.avgDaysToSell}</ATd>
                  <ATd right mono>{r.avgPriceCents === null ? "—" : formatEur(r.avgPriceCents)}</ATd>
                  {showProfit && (
                    <ATd right mono>
                      {r.profitCents == null ? (
                        <span style={{ color: AT.inkSoft, fontFamily: AT.body, fontSize: 11.5 }}>{t("whs.st.noCost")}</span>
                      ) : (
                        <span style={{ color: r.profitCents > 0 ? AT.ok : r.profitCents < 0 ? AT.danger : AT.ink, fontWeight: 600 }}>
                          {formatEur(r.profitCents)}
                        </span>
                      )}
                      {(r.noCostData ?? 0) > 0 && (
                        <span style={{ display: "block", fontFamily: AT.body, fontSize: 11, color: AT.inkSoft }}>
                          {t("whs.st.noCostNote").replace("{n}", String(r.noCostData))}
                        </span>
                      )}
                    </ATd>
                  )}
                </ATr>
              ))}
            </ATable>
          )}
        </ACard>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 14, alignItems: "start" }}>
        {data && <OutcomesCard outcomes={data.auctionOutcomes} />}
        {data && <AgingCard aging={data.aging} label={catLabel} />}
      </div>

      {!problem && (
        <ACard
          title={t("whs.st.sittingTitle")}
          pad={false}
          actions={<span style={{ fontFamily: AT.body, fontSize: 11.5, color: AT.inkSoft }}>{t("whs.st.sittingHint")}</span>}
        >
          {!data || data.sittingLongest.length === 0 ? (
            <AEmpty text={data ? t("whs.st.sittingEmpty") : t("c.loading")} />
          ) : (
            <ATable head={["SKU", t("c.title"), t("inv.category"), t("whs.st.thDaysOnShelf"), ""]}>
              {data.sittingLongest.map((r) => (
                <ATr key={r.id} onClick={() => nav.go("inventory", r.id)}>
                  <ATd mono>{r.sku}</ATd>
                  <ATd><span style={{ fontWeight: 600 }}>{r.title}</span></ATd>
                  <ATd>{catLabel(r.category)}</ATd>
                  <ATd right mono style={{ color: r.daysOnShelf >= 90 ? AT.danger : r.daysOnShelf >= 60 ? AT.warn : AT.ink, fontWeight: 700 }}>
                    {r.daysOnShelf}
                  </ATd>
                  <ATd right style={{ color: AT.inkSoft, fontSize: 11.5 }}>
                    {t("whs.st.timesListed").replace("{n}", String(r.timesListed))}
                  </ATd>
                </ATr>
              ))}
            </ATable>
          )}
        </ACard>
      )}

      {data && (
        <div style={{ fontFamily: AT.body, fontSize: 11.5, lineHeight: 1.5, color: AT.inkSoft }}>
          <div><strong style={{ fontWeight: 700 }}>{t("whs.st.basisCounted")}</strong> {data.basis.sellThrough}</div>
          <div><strong style={{ fontWeight: 700 }}>{t("whs.st.basisExcluded")}</strong> {data.basis.excluded}</div>
        </div>
      )}
    </div>
  );
}

// ── Sell-through per category (divs, same token palette as the SVG chart) ───

function CategoryBars({ rows, label }: { rows: CategoryRow[]; label: (code: string) => string }) {
  const { t } = useT();
  if (rows.length === 0) return null;
  return (
    <ACard title={t("whs.st.chartTitle")}>
      <div role="img" aria-label={t("whs.st.chartAria")} style={{ display: "grid", gap: 7 }}>
        {rows.map((r) => {
          const tone = r.sellThroughPct === null ? null : toneColors[healthTone(r.sellThroughPct)];
          return (
            <div key={r.category} style={{ display: "grid", gridTemplateColumns: "minmax(96px, 150px) 1fr 46px", gap: 10, alignItems: "center" }}>
              <span style={{ fontFamily: AT.body, fontSize: 12.5, color: AT.ink, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {label(r.category)}
              </span>
              {tone === null || r.sellThroughPct === null ? (
                // Nothing was offered — there is no rate. A 0% bar would read
                // as a failure, so the row says so in words instead.
                <span style={{ fontFamily: AT.body, fontSize: 11.5, color: AT.inkSoft }}>— {t("whs.st.noOffers")}</span>
              ) : (
                <span style={{ display: "block", height: 12, borderRadius: 999, background: AT.surfaceAlt, overflow: "hidden" }}>
                  <span style={{ display: "block", height: "100%", width: `${Math.max(2, r.sellThroughPct)}%`, background: tone.fg, borderRadius: 999 }} />
                </span>
              )}
              <span style={{
                fontFamily: AT.mono, fontSize: 12, fontWeight: 700, textAlign: "right",
                color: tone === null ? AT.inkSoft : tone.fg,
              }}>
                {r.sellThroughPct === null ? "—" : `${r.sellThroughPct}%`}
              </span>
            </div>
          );
        })}
      </div>
      <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginTop: 10, fontFamily: AT.body, fontSize: 11.5, color: AT.inkSoft }}>
        {([["whs.st.healthGood", AT.ok], ["whs.st.healthWarn", AT.warn], ["whs.st.healthBad", AT.danger]] as Array<[TKey, string]>).map(([k, c]) => (
          <span key={k} style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
            <span style={{ width: 9, height: 9, borderRadius: 2, background: c, display: "inline-block" }} />
            {t(k)}
          </span>
        ))}
      </div>
      <div style={{ marginTop: 6, fontFamily: AT.body, fontSize: 11.5, lineHeight: 1.45, color: AT.inkSoft }}>
        {t("whs.st.windowNote")}
      </div>
    </ACard>
  );
}

// ── How auction runs ended ──────────────────────────────────────────────────

function OutcomesCard({ outcomes }: { outcomes: SellThroughPayload["auctionOutcomes"] }) {
  const { t } = useT();
  const lines: Array<{ key: TKey; n: number; tone: Tone }> = [
    { key: "whs.st.outcomeWon", n: outcomes.won, tone: "ok" },
    { key: "whs.st.outcomeNoBids", n: outcomes.noBids, tone: "neutral" },
    { key: "whs.st.outcomeReserve", n: outcomes.reserveNotMet, tone: "warn" },
  ];
  return (
    <ACard title={t("whs.st.outcomesTitle")} pad={false}>
      {outcomes.ended === 0 ? (
        <AEmpty text={t("whs.st.outcomesEmpty")} />
      ) : (
        <div style={{ display: "grid" }}>
          {lines.map((l) => {
            const share = Math.round((l.n / outcomes.ended) * 100);
            return (
              <div key={l.key} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 16px", borderBottom: `1px solid ${AT.ruleSoft}` }}>
                <span style={{ width: 8, height: 8, borderRadius: 999, background: toneColors[l.tone].fg, flexShrink: 0 }} />
                <span style={{ fontFamily: AT.body, fontSize: 12.5, color: AT.ink }}>{t(l.key)}</span>
                <span style={{ marginLeft: "auto", fontFamily: AT.mono, fontSize: 11.5, color: AT.inkSoft }}>{share}%</span>
                <span style={{ fontFamily: AT.mono, fontSize: 12.5, fontWeight: 700, color: AT.ink, minWidth: 34, textAlign: "right" }}>{l.n}</span>
              </div>
            );
          })}
          <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 16px" }}>
            <span style={{ fontFamily: AT.body, fontSize: 12.5, fontWeight: 700, color: AT.ink }}>{t("whs.st.outcomeEnded")}</span>
            <span style={{ marginLeft: "auto", fontFamily: AT.mono, fontSize: 12.5, fontWeight: 700, color: AT.ink, minWidth: 34, textAlign: "right" }}>{outcomes.ended}</span>
          </div>
        </div>
      )}
      {outcomes.cancelledExcluded > 0 && (
        <div style={{ padding: "0 16px 12px", fontFamily: AT.body, fontSize: 11.5, color: AT.inkSoft }}>
          {t("whs.st.outcomeCancelled").replace("{n}", String(outcomes.cancelledExcluded))}
        </div>
      )}
    </ACard>
  );
}

// ── How long stock has been sitting (stacked age bands per category) ────────

function AgingCard({ aging, label }: { aging: AgingRow[]; label: (code: string) => string }) {
  const { t } = useT();
  const rows = [...aging].sort((a, b) => b.units - a.units);
  const max = Math.max(1, ...rows.map((r) => r.units));
  const total = rows.reduce(
    (acc, r) => ({
      units: acc.units + r.units,
      d0_30: acc.d0_30 + r.d0_30,
      d31_60: acc.d31_60 + r.d31_60,
      d61_90: acc.d61_90 + r.d61_90,
      d90plus: acc.d90plus + r.d90plus,
    }),
    { units: 0, d0_30: 0, d31_60: 0, d61_90: 0, d90plus: 0 },
  );

  const bar = (r: Omit<AgingRow, "category">, scale: number) => (
    <span style={{ display: "flex", height: 12, borderRadius: 999, overflow: "hidden", background: AT.surfaceAlt, width: `${scale}%` }}>
      {AGE_BANDS.map((b) => {
        const w = r.units > 0 ? (r[b.key] / r.units) * 100 : 0;
        return w > 0 ? <span key={b.key} style={{ width: `${w}%`, background: b.color }} /> : null;
      })}
    </span>
  );

  return (
    <ACard title={t("whs.st.agingTitle")} pad={false}>
      {rows.length === 0 ? (
        <AEmpty text={t("whs.st.agingEmpty")} />
      ) : (
        <div style={{ display: "grid" }}>
          {rows.map((r) => (
            <div key={r.category} style={{ display: "grid", gridTemplateColumns: "minmax(90px, 130px) 1fr 62px", gap: 10, alignItems: "center", padding: "9px 16px", borderBottom: `1px solid ${AT.ruleSoft}` }}>
              <span style={{ fontFamily: AT.body, fontSize: 12.5, color: AT.ink, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {label(r.category)}
              </span>
              {bar(r, (r.units / max) * 100)}
              <span style={{ fontFamily: AT.mono, fontSize: 12, color: AT.ink, textAlign: "right" }}>
                {r.units} <span style={{ fontFamily: AT.body, fontSize: 11, color: AT.inkSoft }}>{t("whs.st.units")}</span>
              </span>
            </div>
          ))}
          <div style={{ display: "grid", gridTemplateColumns: "minmax(90px, 130px) 1fr 62px", gap: 10, alignItems: "center", padding: "9px 16px" }}>
            <span style={{ fontFamily: AT.body, fontSize: 12.5, fontWeight: 700, color: AT.ink }}>{t("c.total")}</span>
            {bar(total, 100)}
            <span style={{ fontFamily: AT.mono, fontSize: 12, fontWeight: 700, color: AT.ink, textAlign: "right" }}>
              {total.units} <span style={{ fontFamily: AT.body, fontSize: 11, fontWeight: 400, color: AT.inkSoft }}>{t("whs.st.units")}</span>
            </span>
          </div>
        </div>
      )}
      <div style={{ padding: "0 16px 12px", display: "flex", gap: 14, flexWrap: "wrap", fontFamily: AT.body, fontSize: 11.5, color: AT.inkSoft }}>
        {AGE_BANDS.map((b) => (
          <span key={b.key} style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
            <span style={{ width: 9, height: 9, borderRadius: 2, background: b.color, display: "inline-block" }} />
            {t(b.labelKey)}
          </span>
        ))}
        <span style={{ width: "100%" }}>{t("whs.st.agingNote")}</span>
      </div>
    </ACard>
  );
}
