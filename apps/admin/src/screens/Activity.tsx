import { useCallback, useEffect, useState } from "react";
import { api, ApiError, type AuditEntry } from "../api.js";
import type { Nav } from "../App.js";
import { formatDate } from "../format.js";
import { ReportDetail, type BugReport } from "../ReportModal.js";
import { AT, toneColors, type Tone } from "../theme.js";
import { AAvatar, ABadge, ABtn, ACard, ADrawer, AEmpty, AIcon, AInput, APills, ASelect, ATable, ATd, ATr, useToast } from "../ui.js";

const TYPES = ["", "auction", "listing", "item", "order", "customer", "settings", "team", "finance"];

export function ActivityScreen({ nav: _nav }: { nav: Nav }) {
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

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <h1 style={{ fontFamily: AT.body, fontSize: 20, fontWeight: 700, color: AT.ink }}>Activity</h1>
        {tab === "audit" && (
          <ABtn kind="ghost" size="sm" onClick={() => load(type)}>
            <AIcon name="refund" size={13} /> Refresh
          </ABtn>
        )}
      </div>

      <APills
        options={[
          { id: "audit" as const, label: "Audit log" },
          { id: "bugs" as const, label: "Bug reports", count: bugCount },
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
              label="Area"
              value={type}
              onChange={setType}
              options={TYPES.map((t) => ({ value: t, label: t === "" ? "All" : t }))}
            />
            <div style={{ width: 260 }}>
              <AInput value={query} onChange={setQuery} placeholder="Filter actor, action, target…" />
            </div>
            <span style={{ fontFamily: AT.body, fontSize: 12, color: AT.inkSoft }}>{visible.length} entries</span>
          </div>

          <ACard pad={false}>
            {visible.length === 0 ? (
              <AEmpty text="No audit entries match." />
            ) : (
              <ATable head={["Time", "Actor", "Area", "Action", "Target", "Detail"]}>
                {visible.map((e) => (
                  <ATr key={e.id}>
                    <ATd mono>{formatDate(e.createdAt)}</ATd>
                    <ATd>
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 7 }}>
                        <AAvatar name={e.actorLabel} size={20} />
                        {e.actorLabel}
                      </span>
                    </ATd>
                    <ATd><ABadge tone="neutral">{e.type}</ABadge></ATd>
                    <ATd><span style={{ fontWeight: 600 }}>{e.action.replace(/_/g, " ")}</span></ATd>
                    <ATd><span style={{ fontSize: 12.5 }}>{e.target || "—"}</span></ATd>
                    <ATd>
                      {e.detail ? (
                        <span
                          title={JSON.stringify(e.detail, null, 2)}
                          style={{
                            fontFamily: AT.mono, fontSize: 11, color: AT.inkSoft, display: "inline-block",
                            maxWidth: 360, overflow: "hidden", textOverflow: "ellipsis", verticalAlign: "bottom",
                          }}
                        >
                          {JSON.stringify(e.detail)}
                        </span>
                      ) : (
                        <span style={{ color: AT.inkSoft }}>—</span>
                      )}
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

const BUG_STATUS: Record<string, { label: string; tone: Tone }> = {
  open: { label: "Queued", tone: "neutral" },
  sent: { label: "Received", tone: "neutral" },
  in_progress: { label: "In progress", tone: "accent" },
  done: { label: "Fixed", tone: "ok" },
  dismissed: { label: "Dismissed", tone: "neutral" },
};
const BUG_SEV_TONE: Record<string, Tone> = { low: "neutral", normal: "neutral", high: "warn", blocker: "danger" };

function BugsTab({ onCount }: { onCount: (n: number) => void }) {
  const toast = useToast();
  const [reports, setReports] = useState<BugReport[]>([]);
  const [open, setOpen] = useState<BugReport | null>(null);

  const load = useCallback(() => {
    void api.get<{ reports: BugReport[] }>("/api/bugs").then((r) => {
      setReports(r.reports);
      onCount(r.reports.filter((x) => x.status !== "done" && x.status !== "dismissed").length);
    }).catch(() => undefined);
  }, [onCount]);
  useEffect(load, [load]);

  const dismiss = async (r: BugReport) => {
    try {
      await api.post(`/api/bugs/${r.id}/dismiss`);
      toast("Report dismissed — nothing sent to Jira", "ok");
      setOpen(null);
      load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Dismiss failed", "danger");
    }
  };

  return (
    <>
      <ACard pad={false}>
        {reports.length === 0 ? (
          <AEmpty text="No problem reports yet — the 🐞 button in the sidebar files them (phones too)." />
        ) : (
          <ATable head={["When", "Reporter", "Report", "Severity", "Jira", "Status", "💬"]}>
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
                    {r.severity}
                  </span>
                </ATd>
                <ATd mono>
                  {r.jiraKey ? <span style={{ fontWeight: 700, color: AT.accent }}>{r.jiraKey}</span> : <span style={{ color: AT.inkSoft }}>—</span>}
                </ATd>
                <ATd>
                  <ABadge tone={BUG_STATUS[r.status]?.tone ?? "neutral"}>{BUG_STATUS[r.status]?.label ?? r.status}</ABadge>
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
          title={<span>Report {open.jiraKey ? <span style={{ fontFamily: AT.mono, color: AT.accent }}>{open.jiraKey}</span> : ""} · {open.reporterLabel}</span>}
          onClose={() => { setOpen(null); load(); }}
          width={520}
          footer={
            open.status !== "dismissed" && open.status !== "done" ? (
              <ABtn kind="ghost" onClick={() => void dismiss(open)}>Dismiss (no Jira)</ABtn>
            ) : undefined
          }
        >
          <ReportDetail report={open} onBack={() => { setOpen(null); load(); }} />
        </ADrawer>
      )}
    </>
  );
}
