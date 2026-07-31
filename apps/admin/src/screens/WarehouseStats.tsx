import { useEffect, useMemo, useState } from "react";
import { api } from "../api.js";
import type { Nav } from "../App.js";
import { exportCSV } from "../exporters.js";
import { useT, type TKey } from "../i18n.js";
import { AT, toneColors, type Tone } from "../theme.js";
import { AAvatar, ABtn, ACard, ADrawer, AEmpty, APills, AStat, ATable, ATd, ATr } from "../ui.js";

/**
 * W3 — Warehouse stats: team totals for a period, per-day activity chart,
 * sortable per-worker table, and a who-did-what day timeline per worker.
 * Everything is read from records the system already keeps.
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

export function WarehouseStatsScreen({ nav: _nav }: { nav: Nav }) {
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
        <h1 style={{ fontFamily: AT.body, fontSize: 20, fontWeight: 700, color: AT.ink }}>{t("ws.title")}</h1>
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
