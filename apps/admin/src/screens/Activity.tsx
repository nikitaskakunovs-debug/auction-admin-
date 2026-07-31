import { useCallback, useEffect, useState } from "react";
import { api, ApiError, type AuditEntry } from "../api.js";
import type { Nav } from "../App.js";
import { formatDate, formatEur } from "../format.js";
import { auctionStatusLabel, auditActionLabel, itemStatusLabel, orderStatusLabel, useT, type TKey } from "../i18n.js";
import { ReportDetail, type BugReport } from "../ReportModal.js";
import { AT, toneColors, type Tone } from "../theme.js";
import { AAvatar, ABadge, ABtn, ACard, ADrawer, AEmpty, AIcon, AInput, APills, ASelect, ATable, ATd, ATr, useToast } from "../ui.js";

const TYPES = ["", "auction", "listing", "item", "order", "customer", "settings", "team", "finance"];

/** Audit-area filter values → translation keys; unknown areas show raw. */
const AREA_KEY: Record<string, TKey> = {
  auction: "ms.ty.auction",
  listing: "ms.ty.listing",
  item: "ms.ty.item",
  order: "ms.ty.order",
  customer: "ms.ty.customer",
  settings: "ms.ty.settings",
  team: "ms.ty.team",
  finance: "ms.ty.finance",
};

// ── Human-readable audit rendering — no raw codes in the table ──────────────

/** Screen ids inside bug-report details → the sidebar's translated names. */
const SCREEN_KEY: Record<string, TKey> = {
  dashboard: "sh.nav.dashboard", auctions: "sh.nav.auctions", listings: "sh.nav.listings",
  inventory: "sh.nav.inventory", receiving: "sh.nav.receiving", orders: "sh.nav.orders",
  pickup: "sh.nav.pickup", whstats: "sh.nav.whstats", customers: "sh.nav.customers",
  finance: "sh.nav.finance", content: "sh.nav.content", settings: "sh.nav.settings",
  notifications: "sh.nav.notifications", activity: "sh.nav.activity", security: "sh.nav.security",
  wh: "wh.title",
};

const BUG_TYPE_KEY: Record<string, TKey> = {
  bug: "ms.bt.bug", visual: "ms.bt.visual", data: "ms.bt.data", slow: "ms.bt.slow", idea: "ms.bt.idea",
};

const SEV_KEY: Record<string, TKey> = {
  low: "bug.sev.low", normal: "bug.sev.normal", high: "bug.sev.high", blocker: "bug.sev.blocker",
};

/** Statuses appear in details as from/to/status — try every vocabulary. */
const anyStatusLabel = (v: string): string => {
  for (const fn of [itemStatusLabel, orderStatusLabel, auctionStatusLabel]) {
    const label = fn(v);
    if (label !== v) return label;
  }
  return v;
};

const KEY_LABEL: Record<string, TKey> = {
  reason: "ms.k.reason", note: "ms.k.note", type: "ms.k.type", screen: "ms.k.screen",
  severity: "ms.k.severity", from: "ms.k.from", to: "ms.k.to", status: "ms.k.status",
  amount: "ms.k.amount", count: "ms.k.count", email: "ms.k.email", role: "ms.k.role",
  name: "ms.k.name", title: "ms.k.title", sku: "ms.k.sku", ref: "ms.k.ref",
  number: "ms.k.number", ticket: "ms.k.ticket", code: "ms.k.code", provider: "ms.k.provider",
  condition: "ms.k.condition", location: "ms.k.location", bin: "ms.k.bin",
  supplier: "ms.k.supplier", market: "ms.k.market", fee: "ms.k.fee", deadline: "ms.k.deadline",
  tags: "ms.k.tags", permissions: "ms.k.permissions", barcode: "ms.k.barcode",
  invoice: "ms.k.invoice", order: "ms.k.order", photos: "ms.k.photos",
  endsAt: "ms.k.endsAt", startsAt: "ms.k.startsAt",
};

/** camelCase / snake_case → plain words, for keys the map doesn't know. */
const prettifyKey = (k: string): string =>
  k.replace(/Cents$/, "").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/_/g, " ").toLowerCase();

const looksLikeIso = (v: string): boolean => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v);
const isUuid = (v: string): boolean => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
/** Uuids and similar opaque ids add nothing for a human — drop them. */
const looksLikeId = (k: string, v: string): boolean => /(^|[a-z])(id|uuid)$/i.test(k) || isUuid(v);

function detailValue(key: string, value: unknown, t: (k: TKey) => string): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "boolean") return t(value ? "c.yes" : "c.no");
  if (typeof value === "number") return /cents$/i.test(key) ? formatEur(value) : String(value);
  if (Array.isArray(value)) {
    const parts = value.map((v) => detailValue(key.replace(/s$/, ""), v, t)).filter(Boolean);
    return parts.length ? parts.join(", ") : null;
  }
  if (typeof value === "object") return null; // nested blobs stay in the tooltip
  const s = String(value);
  if (looksLikeId(key, s)) return null;
  if (looksLikeIso(s)) return formatDate(s);
  if (key === "screen") { const k = SCREEN_KEY[s]; return k ? t(k) : s; }
  if (key === "type") { const k = BUG_TYPE_KEY[s]; if (k) return t(k); }
  if (key === "severity") { const k = SEV_KEY[s]; return k ? t(k) : s; }
  if (key === "from" || key === "to" || key === "status") return anyStatusLabel(s);
  return s;
}

/** `{"type":"bug","screen":"whstats"}` → `Tips: kļūda · Ekrāns: Statistika`. */
function humanizeDetail(detail: Record<string, unknown>, t: (k: TKey) => string): string {
  const parts: string[] = [];
  for (const [key, raw] of Object.entries(detail)) {
    const value = detailValue(key, raw, t);
    if (value === null) continue;
    const labelKey = KEY_LABEL[key];
    parts.push(`${labelKey ? t(labelKey) : prettifyKey(key)}: ${value}`);
  }
  return parts.join(" · ");
}

export function ActivityScreen({ nav: _nav }: { nav: Nav }) {
  const { t } = useT();
  const [tab, setTab] = useState<"audit" | "bugs">("audit");
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [type, setType] = useState("");
  const [query, setQuery] = useState("");
  const [bugCount, setBugCount] = useState(0);

  const load = (t: string) => {
    void api
      .get<{ entries: AuditEntry[] }>(`/api/audit?limit=500${t ? `&type=${t}` : ""}`)
      .then((r) => setEntries(r.entries))
      .catch(() => undefined);
  };
  useEffect(() => load(type), [type]);

  const q = query.trim().toLowerCase();
  const visible = q
    ? entries.filter((e) =>
        e.actorLabel.toLowerCase().includes(q) || e.action.toLowerCase().includes(q) || e.target.toLowerCase().includes(q),
      )
    : entries;

  const areaLabel = (v: string) => {
    const key = AREA_KEY[v];
    return key ? t(key) : v;
  };

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <h1 style={{ fontFamily: AT.body, fontSize: 20, fontWeight: 700, color: AT.ink }}>{t("ms.actTitle")}</h1>
        {tab === "audit" && (
          <ABtn kind="ghost" size="sm" onClick={() => load(type)}>
            <AIcon name="refund" size={13} /> {t("c.refresh")}
          </ABtn>
        )}
      </div>

      <APills
        options={[
          { id: "audit" as const, label: t("ms.auditLog") },
          { id: "bugs" as const, label: t("ms.bugReports"), count: bugCount },
        ]}
        value={tab}
        onChange={setTab}
      />

      {tab === "bugs" ? (
        <BugsTab onCount={setBugCount} />
      ) : (
        <>
          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <ASelect
              label={t("ms.area")}
              value={type}
              onChange={setType}
              options={TYPES.map((v) => ({ value: v, label: v === "" ? t("c.all") : areaLabel(v) }))}
            />
            <div style={{ width: 260 }}>
              <AInput value={query} onChange={setQuery} placeholder={t("ms.filterPlaceholder")} />
            </div>
            <span style={{ fontFamily: AT.body, fontSize: 12, color: AT.inkSoft }}>{visible.length} {t("ms.entries")}</span>
          </div>

          <ACard pad={false}>
            {visible.length === 0 ? (
              <AEmpty text={t("ms.noAudit")} />
            ) : (
              <ATable head={[t("ms.time"), t("ms.actor"), t("ms.area"), t("ms.action"), t("ms.target"), t("ms.detail")]}>
                {visible.map((e) => (
                  <ATr key={e.id}>
                    <ATd mono>{formatDate(e.createdAt)}</ATd>
                    <ATd>
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 7 }}>
                        <AAvatar name={e.actorLabel} size={20} />
                        {e.actorLabel}
                      </span>
                    </ATd>
                    <ATd><ABadge tone="neutral">{areaLabel(e.type)}</ABadge></ATd>
                    <ATd><span style={{ fontWeight: 600 }}>{auditActionLabel(e.action)}</span></ATd>
                    {/* Raw uuids mean nothing to a human — hide them (details/tooltip keep the trail). */}
                    <ATd><span style={{ fontSize: 12.5 }}>{e.target && !isUuid(e.target) ? e.target : "—"}</span></ATd>
                    <ATd>
                      {((text) =>
                        text ? (
                          <span
                            title={e.detail ? JSON.stringify(e.detail, null, 2) : undefined}
                            style={{
                              fontSize: 12, color: AT.inkSoft, display: "inline-block", whiteSpace: "normal",
                              maxWidth: 360, overflow: "hidden", textOverflow: "ellipsis", verticalAlign: "bottom",
                            }}
                          >
                            {text}
                          </span>
                        ) : (
                          <span style={{ color: AT.inkSoft }}>—</span>
                        ))(e.detail ? humanizeDetail(e.detail, t) : "")}
                    </ATd>
                  </ATr>
                ))}
              </ATable>
            )}
          </ACard>
        </>
      )}
    </div>
  );
}

// ── Phase E: team-wide bug reports with the same per-ticket chat ─────────────

const BUG_STATUS: Record<string, { label: TKey; tone: Tone }> = {
  open: { label: "ms.bs.open", tone: "neutral" },
  sent: { label: "ms.bs.sent", tone: "neutral" },
  in_progress: { label: "ms.bs.in_progress", tone: "accent" },
  done: { label: "ms.bs.done", tone: "ok" },
  dismissed: { label: "ms.bs.dismissed", tone: "neutral" },
};
const BUG_SEV_TONE: Record<string, Tone> = { low: "neutral", normal: "neutral", high: "warn", blocker: "danger" };
/** Severity words reuse the bug.* vocabulary from the report modal. */
const BUG_SEV_KEY: Record<string, TKey> = {
  low: "bug.sev.low",
  normal: "bug.sev.normal",
  high: "bug.sev.high",
  blocker: "bug.sev.blocker",
};

interface JiraStatus {
  mode: string;
  project?: string;
  webhook?: boolean;
  ok?: boolean;
  user?: string;
  error?: string;
  /** S1 — where business events are mirrored (null/off when not configured). */
  slack?: { mode: string; channels?: string[] };
}

/** Connection-health strip: is the Jira bridge alive, and how fast is inbound sync? */
function JiraStatusCard({ status }: { status: JiraStatus }) {
  const { t } = useT();
  const off = status.mode === "off";
  const tone: Tone = off ? "neutral" : status.ok ? "ok" : "danger";
  const dot = toneColors[tone].fg;
  return (
    <div
      style={{
        display: "flex", alignItems: "center", gap: 9, padding: "8px 14px",
        background: toneColors[tone].bg, border: `1px solid ${AT.rule}`, borderRadius: 10,
        fontFamily: AT.body, fontSize: 12.5, color: AT.ink,
      }}
    >
      <span style={{ width: 8, height: 8, borderRadius: 999, background: dot, flexShrink: 0 }} />
      {off ? (
        <span style={{ color: AT.inkSoft }}>{t("ms.jiraOff")}</span>
      ) : status.ok ? (
        <span>
          {t("ms.jiraConnectedAs")} <b>{status.user}</b> · {t("ms.jiraProject")} <b style={{ fontFamily: AT.mono }}>{status.project}</b>
          {status.mode === "simulate" ? ` · ${t("ms.jiraSimulated")}` : ""} ·{" "}
          {status.webhook ? t("ms.jiraWebhookOn") : t("ms.jiraWebhookOff")}
        </span>
      ) : (
        <span style={{ color: toneColors.danger.fg }}>
          {t("ms.jiraFailed")}{" "}
          <span style={{ fontFamily: AT.mono, fontSize: 11 }}>{status.error}</span>
        </span>
      )}
    </div>
  );
}

/** S1 — one line telling operators whether events reach Slack, and where. */
function SlackStatusCard({ slack }: { slack: { mode: string; channels?: string[] } }) {
  const { t } = useT();
  const off = slack.mode === "off";
  const tone: Tone = off ? "neutral" : "ok";
  return (
    <div
      style={{
        display: "flex", alignItems: "center", gap: 9, padding: "8px 14px",
        background: toneColors[tone].bg, border: `1px solid ${AT.rule}`, borderRadius: 10,
        fontFamily: AT.body, fontSize: 12.5, color: AT.ink,
      }}
    >
      <span style={{ width: 8, height: 8, borderRadius: 999, background: toneColors[tone].fg, flexShrink: 0 }} />
      {off ? (
        <span style={{ color: AT.inkSoft }}>{t("ms.slackOff")}</span>
      ) : (
        <span>
          {t("ms.slackOn")}{" "}
          <b style={{ fontFamily: AT.mono }}>{(slack.channels ?? []).join(" · ")}</b>
          {slack.mode === "simulate" ? ` · ${t("ms.jiraSimulated")}` : ""}
        </span>
      )}
    </div>
  );
}

function BugsTab({ onCount }: { onCount: (n: number) => void }) {
  const { t } = useT();
  const toast = useToast();
  const [reports, setReports] = useState<BugReport[]>([]);
  const [open, setOpen] = useState<BugReport | null>(null);
  const [jira, setJira] = useState<JiraStatus | null>(null);

  const load = useCallback(() => {
    void api.get<{ reports: BugReport[] }>("/api/bugs").then((r) => {
      setReports(r.reports);
      onCount(r.reports.filter((x) => x.status !== "done" && x.status !== "dismissed").length);
    }).catch(() => undefined);
  }, [onCount]);
  useEffect(load, [load]);
  useEffect(() => {
    void api.get<JiraStatus>("/api/bugs/jira-status").then(setJira).catch(() => undefined);
  }, []);

  const dismiss = async (r: BugReport) => {
    try {
      await api.post(`/api/bugs/${r.id}/dismiss`);
      toast(t("ms.dismissedToast"), "ok");
      setOpen(null);
      load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : t("ms.dismissFailed"), "danger");
    }
  };

  return (
    <>
      {jira && <JiraStatusCard status={jira} />}
      {jira?.slack && <SlackStatusCard slack={jira.slack} />}
      <ACard pad={false}>
        {reports.length === 0 ? (
          <AEmpty text={t("ms.noBugs")} />
        ) : (
          <ATable head={[t("ms.when"), t("ms.reporter"), t("ms.report"), t("ms.severity"), "Jira", t("c.status"), "💬"]}>
            {reports.map((r) => (
              <ATr key={r.id} onClick={() => setOpen(r)}>
                <ATd mono>{formatDate(r.createdAt)}</ATd>
                <ATd>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 7 }}>
                    <AAvatar name={r.reporterLabel} size={20} />
                    {r.reporterLabel}
                  </span>
                </ATd>
                <ATd>
                  <span style={{ fontWeight: 600, display: "inline-block", maxWidth: 320, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", verticalAlign: "bottom" }}>
                    {r.body}
                  </span>
                  <div style={{ fontSize: 10.5, color: AT.inkSoft }}>{r.screen || "—"}</div>
                </ATd>
                <ATd>
                  <span style={{ background: toneColors[BUG_SEV_TONE[r.severity] ?? "neutral"].bg, color: toneColors[BUG_SEV_TONE[r.severity] ?? "neutral"].fg, borderRadius: 999, padding: "1px 9px", fontSize: 11, fontWeight: 700 }}>
                    {((k) => (k ? t(k) : r.severity))(BUG_SEV_KEY[r.severity])}
                  </span>
                </ATd>
                <ATd mono>
                  {r.jiraKey ? <span style={{ fontWeight: 700, color: AT.accent }}>{r.jiraKey}</span> : <span style={{ color: AT.inkSoft }}>—</span>}
                </ATd>
                <ATd>
                  <ABadge tone={BUG_STATUS[r.status]?.tone ?? "neutral"}>{((s) => (s ? t(s.label) : r.status))(BUG_STATUS[r.status])}</ABadge>
                </ATd>
                <ATd right>
                  {(r.commentCount ?? 0) > 0 ? `${r.commentCount}${(r.unread ?? 0) > 0 ? " ●" : ""}` : "—"}
                </ATd>
              </ATr>
            ))}
          </ATable>
        )}
      </ACard>

      {open && (
        <ADrawer
          title={<span>{t("ms.reportTitle")} {open.jiraKey ? <span style={{ fontFamily: AT.mono, color: AT.accent }}>{open.jiraKey}</span> : ""} · {open.reporterLabel}</span>}
          onClose={() => { setOpen(null); load(); }}
          width={520}
          footer={
            open.status !== "dismissed" && open.status !== "done" ? (
              <ABtn kind="ghost" onClick={() => void dismiss(open)}>{t("ms.dismissNoJira")}</ABtn>
            ) : undefined
          }
        >
          <ReportDetail report={open} onBack={() => { setOpen(null); load(); }} />
        </ADrawer>
      )}
    </>
  );
}
