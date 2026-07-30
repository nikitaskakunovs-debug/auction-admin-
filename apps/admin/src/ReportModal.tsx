import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "./api.js";
import { useAuth } from "./auth.js";
import { consoleTail } from "./bugCapture.js";
import { useT } from "./i18n.js";
import { AT, toneColors, type Tone } from "./theme.js";

/**
 * Phase E — "Report a problem": the modal with New report / My reports tabs
 * and the per-ticket chat with IT (mirrored to Jira). Used by the admin shell
 * and the warehouse PWA; primary labels go through i18n for the phones.
 */

export interface BugReport {
  id: string;
  reporterLabel: string;
  screen: string;
  body: string;
  steps: string;
  type: string;
  severity: string;
  attachments: string[];
  jiraKey: string | null;
  status: string;
  resolutionNote: string | null;
  noticePending: boolean;
  createdAt: string;
  updatedAt: string;
  commentCount?: number;
  unread?: number;
}

export interface BugComment {
  id: string;
  authorLabel: string;
  side: string; // panel | it
  body: string;
  createdAt: string;
}

const TYPES = [
  { id: "bug", label: "Bug" },
  { id: "visual", label: "Visual glitch" },
  { id: "data", label: "Wrong data" },
  { id: "slow", label: "Slow" },
  { id: "idea", label: "Idea" },
];

const SEVERITIES = ["low", "normal", "high", "blocker"] as const;

const SEV_TONE: Record<string, Tone> = { low: "neutral", normal: "neutral", high: "warn", blocker: "danger" };
const STATUS_META: Record<string, { label: string; tone: Tone }> = {
  open: { label: "Queued", tone: "neutral" },
  sent: { label: "Received by IT", tone: "neutral" },
  in_progress: { label: "In progress", tone: "accent" },
  done: { label: "Fixed", tone: "ok" },
  dismissed: { label: "Dismissed", tone: "neutral" },
};

const fmtWhen = (iso: string) => {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getDate())}/${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

const APP_VERSION = (import.meta.env.VITE_SENTRY_RELEASE as string | undefined) || "dev";

function Chip({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  const c = toneColors[tone];
  return (
    <span style={{ background: c.bg, color: c.fg, borderRadius: 999, padding: "1px 9px", fontSize: 11, fontWeight: 700, whiteSpace: "nowrap" }}>
      {children}
    </span>
  );
}

export function ReportModal({ screen, onClose }: { screen: string; onClose: () => void }) {
  const { user } = useAuth();
  const { t } = useT();
  const [tab, setTab] = useState<"new" | "mine">("new");
  const [mine, setMine] = useState<BugReport[]>([]);
  const [openReport, setOpenReport] = useState<BugReport | null>(null);

  const loadMine = useCallback(() => {
    void api.get<{ reports: BugReport[] }>("/api/bugs/mine").then((r) => setMine(r.reports)).catch(() => undefined);
  }, []);
  useEffect(loadMine, [loadMine]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const unreadTotal = mine.reduce((a, r) => a + (r.unread ?? 0), 0) + mine.filter((r) => r.noticePending).length;

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 90, display: "grid", placeItems: "center", background: "rgba(10,10,10,0.45)", padding: 14 }} onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 520, maxWidth: "96vw", maxHeight: "92vh", overflowY: "auto", background: AT.panel,
          borderRadius: 16, fontFamily: AT.body, color: AT.ink, boxShadow: "0 22px 70px rgba(0,0,0,0.3)",
        }}
      >
        <div style={{ display: "flex", gap: 12, alignItems: "center", padding: "16px 18px 12px", borderBottom: `1px solid ${AT.ruleSoft}` }}>
          <span style={{ width: 38, height: 38, borderRadius: 11, background: AT.side, color: "#fff", display: "grid", placeItems: "center", fontSize: 17, flexShrink: 0 }}>🐞</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 16, fontWeight: 800 }}>{t("bug.title")}</div>
            <div style={{ fontSize: 12, color: AT.inkSoft }}>{t("bug.subtitle")}</div>
          </div>
          <button onClick={onClose} style={{ all: "unset", cursor: "pointer", color: AT.inkSoft, fontSize: 15, padding: 4 }}>✕</button>
        </div>

        <div style={{ display: "flex", gap: 6, padding: "12px 18px 0" }}>
          {(["new", "mine"] as const).map((id) => (
            <button key={id} onClick={() => { setTab(id); setOpenReport(null); if (id === "mine") loadMine(); }} style={{
              all: "unset", cursor: "pointer", padding: "6px 13px", borderRadius: 999, fontSize: 12.5, fontWeight: 700,
              background: tab === id ? AT.surfaceAlt : "transparent", color: tab === id ? AT.ink : AT.inkSoft,
              display: "inline-flex", alignItems: "center", gap: 6,
            }}>
              {id === "new" ? t("bug.tabNew") : `${t("bug.tabMine")} (${mine.length})`}
              {id === "mine" && unreadTotal > 0 && <span style={{ width: 7, height: 7, borderRadius: 99, background: AT.accent, display: "inline-block" }} />}
            </button>
          ))}
        </div>

        <div style={{ padding: "14px 18px 18px" }}>
          {tab === "new" ? (
            <NewReportForm
              screen={screen}
              role={user?.role ?? "?"}
              onSent={() => {
                loadMine();
                setTab("mine");
              }}
            />
          ) : openReport ? (
            <ReportDetail report={openReport} onBack={() => { setOpenReport(null); loadMine(); }} />
          ) : (
            <MyReports reports={mine} onOpen={setOpenReport} />
          )}
        </div>
      </div>
    </div>
  );
}

// ── New report ───────────────────────────────────────────────────────────────

function NewReportForm({ screen, role, onSent }: { screen: string; role: string; onSent: () => void }) {
  const { t } = useT();
  const [body, setBody] = useState("");
  const [steps, setSteps] = useState("");
  const [type, setType] = useState("bug");
  const [severity, setSeverity] = useState("normal");
  const [attachments, setAttachments] = useState<string[]>([]);
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const consoleLines = consoleTail();

  const uploadBlobs = async (files: Array<{ blob: Blob; name: string }>) => {
    const fd = new FormData();
    for (const f of files) fd.append("files", f.blob, f.name);
    const r = await api.postForm<{ urls: string[] }>("/api/bugs/uploads", fd);
    setAttachments((a) => [...a, ...r.urls].slice(0, 10));
  };

  const attachFiles = async (list: FileList | null) => {
    if (!list || list.length === 0) return;
    setBusy(true);
    try {
      await uploadBlobs(Array.from(list).map((f) => ({ blob: f, name: f.name })));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("bug.uploadFailed"));
    } finally {
      setBusy(false);
    }
  };

  /** One frame via the browser's screen-share picker. */
  const screenshot = async () => {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
      const track = stream.getVideoTracks()[0]!;
      const video = document.createElement("video");
      video.srcObject = stream;
      await video.play();
      await new Promise((r) => setTimeout(r, 150)); // let the frame settle
      const canvas = document.createElement("canvas");
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      canvas.getContext("2d")!.drawImage(video, 0, 0);
      track.stop();
      const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/png"));
      if (blob) await uploadBlobs([{ blob, name: "screenshot.png" }]);
    } catch {
      /* user cancelled the picker — not an error */
    }
  };

  /** Up to 60s of screen recording (desktop browsers). */
  const record = async () => {
    if (recording) {
      recorder.current?.stop();
      return;
    }
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
      const rec = new MediaRecorder(stream, { mimeType: "video/webm", videoBitsPerSecond: 1_500_000 });
      const chunks: Blob[] = [];
      rec.ondataavailable = (e) => e.data.size > 0 && chunks.push(e.data);
      rec.onstop = () => {
        stream.getTracks().forEach((tr) => tr.stop());
        setRecording(false);
        void uploadBlobs([{ blob: new Blob(chunks, { type: "video/webm" }), name: "recording.webm" }]).catch(() => setError(t("bug.uploadFailed")));
      };
      recorder.current = rec;
      rec.start();
      setRecording(true);
      setTimeout(() => rec.state === "recording" && rec.stop(), 60_000);
    } catch {
      /* cancelled */
    }
  };

  const send = async () => {
    if (body.trim().length < 5 || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.post("/api/bugs", {
        body: body.trim(),
        steps: steps.trim(),
        type,
        severity,
        screen,
        context: {
          role,
          market: "LV",
          viewport: `${window.innerWidth}×${window.innerHeight}`,
          version: APP_VERSION,
          url: location.hash || "#/",
          browser: navigator.userAgent.split(") ").pop()?.slice(0, 80) ?? "",
        },
        consoleLog: consoleLines,
        attachments,
      });
      onSent();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("bug.sendFailed"));
    } finally {
      setBusy(false);
    }
  };

  const canRecord = typeof navigator.mediaDevices?.getDisplayMedia === "function" && typeof MediaRecorder !== "undefined";
  const label = { fontSize: 10.5, textTransform: "uppercase" as const, letterSpacing: "0.08em", color: AT.inkSoft, fontWeight: 700, marginBottom: 5 };
  const input = { width: "100%", borderRadius: 9, border: `1px solid ${AT.rule}`, fontFamily: AT.body, fontSize: 13, color: AT.ink, padding: 10, resize: "vertical" as const, background: AT.panel };

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={3} placeholder={t("bug.bodyPlaceholder")} style={input} autoFocus />
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1.3fr", gap: 12 }}>
        <div>
          <div style={label}>{t("bug.type")}</div>
          <select value={type} onChange={(e) => setType(e.target.value)} style={{ ...input, resize: "none", padding: "9px 10px" }}>
            {TYPES.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
          </select>
        </div>
        <div>
          <div style={label}>{t("bug.severity")}</div>
          <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
            {SEVERITIES.map((s) => (
              <button key={s} onClick={() => setSeverity(s)} style={{
                all: "unset", cursor: "pointer", padding: "6px 11px", borderRadius: 999, fontSize: 12, fontWeight: 700,
                background: severity === s ? AT.ink : AT.panel, color: severity === s ? "#fff" : AT.ink,
                border: `1px solid ${severity === s ? AT.ink : AT.rule}`,
              }}>{t(`bug.sev.${s}` as Parameters<typeof t>[0])}</button>
            ))}
          </div>
        </div>
      </div>
      <div>
        <div style={label}>{t("bug.steps")}</div>
        <textarea value={steps} onChange={(e) => setSteps(e.target.value)} rows={2} placeholder={"1. …\n2. …"} style={input} />
      </div>
      <div>
        <div style={label}>{t("bug.attachments")}</div>
        <div style={{ display: "flex", gap: 7, flexWrap: "wrap", alignItems: "center" }}>
          <label style={{ cursor: "pointer", border: `1px solid ${AT.rule}`, borderRadius: 9, padding: "8px 12px", fontSize: 12.5, fontWeight: 700 }}>
            📎 {t("bug.attach")}
            <input type="file" accept="image/jpeg,image/png,image/webp,video/webm,video/mp4" multiple style={{ display: "none" }} onChange={(e) => { void attachFiles(e.target.files); e.currentTarget.value = ""; }} />
          </label>
          {canRecord && (
            <>
              <button onClick={() => void screenshot()} style={{ all: "unset", cursor: "pointer", border: `1px solid ${AT.rule}`, borderRadius: 9, padding: "8px 12px", fontSize: 12.5, fontWeight: 700 }}>
                📸 {t("bug.screenshot")}
              </button>
              <button onClick={() => void record()} style={{
                all: "unset", cursor: "pointer", borderRadius: 9, padding: "8px 12px", fontSize: 12.5, fontWeight: 700,
                border: `1px solid ${recording ? AT.danger : AT.rule}`, color: recording ? AT.danger : AT.ink,
              }}>
                {recording ? `⏹ ${t("bug.stopRec")}` : `🎥 ${t("bug.record")}`}
              </button>
            </>
          )}
          {attachments.map((u, i) => (
            <span key={u} style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11.5, color: AT.inkSoft }}>
              {/\.(webm|mp4)$/.test(u) ? "🎞" : "🖼"} #{i + 1}
              <button onClick={() => setAttachments((a) => a.filter((x) => x !== u))} style={{ all: "unset", cursor: "pointer", fontWeight: 700 }}>×</button>
            </span>
          ))}
        </div>
      </div>
      <div style={{ background: AT.surfaceAlt, borderRadius: 10, padding: "10px 12px" }}>
        <span style={{ fontSize: 12, fontWeight: 700 }}>⚡ {t("bug.autoAttached")}</span>{" "}
        <span style={{ fontSize: 11, color: AT.inkSoft }}>{t("bug.autoAttachedHint")}</span>
        <div style={{ display: "grid", gridTemplateColumns: "70px 1fr 70px 1fr", gap: "3px 8px", marginTop: 7, fontSize: 12 }}>
          <span style={{ color: AT.inkSoft }}>{t("bug.ctxScreen")}</span><b>{screen || "—"}</b>
          <span style={{ color: AT.inkSoft }}>{t("bug.ctxRole")}</span><b>{role.replace(/_/g, " ")}</b>
          <span style={{ color: AT.inkSoft }}>Viewport</span><b>{window.innerWidth}×{window.innerHeight}</b>
          <span style={{ color: AT.inkSoft }}>{t("bug.ctxVersion")}</span><b>{APP_VERSION}</b>
          <span style={{ color: AT.inkSoft }}>{t("bug.ctxConsole")}</span><b style={{ gridColumn: "span 3" }}>{consoleLines.length} {t("bug.ctxLines")}</b>
        </div>
      </div>
      {error && <div style={{ fontSize: 12.5, color: AT.danger, fontWeight: 600 }}>{error}</div>}
      <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
        <button onClick={() => void send()} disabled={body.trim().length < 5 || busy} style={{
          all: "unset", cursor: body.trim().length < 5 || busy ? "default" : "pointer", background: AT.accent, color: "#fff",
          borderRadius: 9, padding: "10px 16px", fontSize: 13, fontWeight: 700, opacity: body.trim().length < 5 || busy ? 0.5 : 1,
        }}>
          🐞 {busy ? "…" : t("bug.send")}
        </button>
        <span style={{ fontSize: 11.5, color: AT.inkSoft }}>{t("bug.sendHint")}</span>
      </div>
    </div>
  );
}

// ── My reports ───────────────────────────────────────────────────────────────

function timeline(r: BugReport): Array<{ label: string; color: string; at: string }> {
  const out: Array<{ label: string; color: string; at: string }> = [
    { label: "Received by IT", color: AT.inkSoft, at: fmtWhen(r.createdAt) },
  ];
  if (r.status === "in_progress" || r.status === "done") out.push({ label: "IT is working on it", color: AT.accent, at: fmtWhen(r.updatedAt) });
  if (r.status === "done") out.push({ label: "Resolved & deployed", color: AT.ok, at: fmtWhen(r.updatedAt) });
  return out;
}

function MyReports({ reports, onOpen }: { reports: BugReport[]; onOpen: (r: BugReport) => void }) {
  const { t } = useT();
  if (reports.length === 0) {
    return <div style={{ fontSize: 13, color: AT.inkSoft, padding: "14px 0" }}>{t("bug.noReports")}</div>;
  }
  return (
    <div style={{ display: "grid", gap: 10 }}>
      {reports.map((r) => {
        const st = STATUS_META[r.status] ?? { label: r.status, tone: "neutral" as Tone };
        const hasUnread = (r.unread ?? 0) > 0 || r.noticePending;
        return (
          <button key={r.id} onClick={() => onOpen(r)} style={{
            all: "unset", cursor: "pointer", border: `1.5px solid ${hasUnread ? AT.accent : AT.ruleSoft}`,
            borderRadius: 12, padding: "11px 13px", display: "grid", gap: 7,
          }}>
            <span style={{ display: "flex", gap: 7, alignItems: "center", flexWrap: "wrap" }}>
              <span style={{ fontFamily: AT.mono, fontWeight: 800, color: AT.accent, fontSize: 12.5 }}>{r.jiraKey ?? "—"}</span>
              <Chip tone={SEV_TONE[r.severity] ?? "neutral"}>{t(`bug.sev.${r.severity}` as Parameters<typeof t>[0])}</Chip>
              <Chip tone="neutral">{TYPES.find((x) => x.id === r.type)?.label ?? r.type}</Chip>
              <Chip tone={st.tone}>{st.label}</Chip>
              {(r.commentCount ?? 0) > 0 && (
                <Chip tone="accent">💬 {r.commentCount}{hasUnread ? " ●" : ""}</Chip>
              )}
              <span style={{ marginLeft: "auto", fontFamily: AT.mono, fontSize: 11, color: AT.inkSoft }}>{fmtWhen(r.createdAt)}</span>
            </span>
            <span style={{ fontSize: 13.5, fontWeight: 700 }}>{r.body}</span>
            {(r.unread ?? 0) > 0 && <span style={{ fontSize: 12, fontWeight: 700, color: AT.accent }}>{t("bug.itAsked")}</span>}
            {r.status === "done" && r.resolutionNote && (
              <span style={{ background: toneColors.ok.bg, color: toneColors.ok.fg, borderRadius: 8, padding: "7px 10px", fontSize: 12 }}>
                ✓ {r.resolutionNote}
              </span>
            )}
            <span style={{ display: "flex", gap: 12, flexWrap: "wrap", fontSize: 11, color: AT.inkSoft }}>
              {timeline(r).map((s) => (
                <span key={s.label}>
                  <span style={{ display: "inline-block", width: 7, height: 7, borderRadius: 99, background: s.color, marginRight: 4 }} />
                  {s.label} {s.at}
                </span>
              ))}
            </span>
            <span style={{ fontSize: 11, color: AT.inkSoft }}>{r.screen || "—"}</span>
          </button>
        );
      })}
    </div>
  );
}

// ── Detail + chat ────────────────────────────────────────────────────────────

export function ReportDetail({ report, onBack }: { report: BugReport; onBack: () => void }) {
  const { t } = useT();
  const [detail, setDetail] = useState<{ report: BugReport; comments: BugComment[] } | null>(null);
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    void api.get<{ report: BugReport; comments: BugComment[] }>(`/api/bugs/${report.id}`).then((d) => {
      setDetail(d);
      void api.post(`/api/bugs/${report.id}/read`).catch(() => undefined);
      if (d.report.noticePending) void api.post(`/api/bugs/${report.id}/ack`).catch(() => undefined);
    }).catch(() => undefined);
  }, [report.id]);
  useEffect(load, [load]);

  const send = async () => {
    if (reply.trim().length === 0 || busy) return;
    setBusy(true);
    try {
      await api.post(`/api/bugs/${report.id}/comments`, { body: reply.trim() });
      setReply("");
      load();
    } finally {
      setBusy(false);
    }
  };

  const r = detail?.report ?? report;
  const st = STATUS_META[r.status] ?? { label: r.status, tone: "neutral" as Tone };
  return (
    <div style={{ display: "grid", gap: 10 }}>
      <button onClick={onBack} style={{ all: "unset", cursor: "pointer", fontSize: 12, color: AT.inkSoft, width: "fit-content" }}>‹ {t("bug.allReports")}</button>
      <div style={{ display: "flex", gap: 7, alignItems: "center", flexWrap: "wrap" }}>
        <span style={{ fontFamily: AT.mono, fontWeight: 800, color: AT.accent, fontSize: 13 }}>{r.jiraKey ?? "—"}</span>
        <Chip tone={SEV_TONE[r.severity] ?? "neutral"}>{t(`bug.sev.${r.severity}` as Parameters<typeof t>[0])}</Chip>
        <Chip tone={st.tone}>{st.label}</Chip>
      </div>
      <div style={{ fontSize: 14, fontWeight: 700 }}>{r.body}</div>
      {r.status === "done" && r.resolutionNote && (
        <div style={{ background: toneColors.ok.bg, color: toneColors.ok.fg, borderRadius: 8, padding: "8px 11px", fontSize: 12.5 }}>
          ✓ {r.resolutionNote}
        </div>
      )}
      {r.attachments.length > 0 && (
        <div style={{ display: "flex", gap: 7, flexWrap: "wrap" }}>
          {r.attachments.map((u) => (
            <a key={u} href={u} target="_blank" rel="noreferrer" style={{ fontSize: 12, color: AT.accent, fontWeight: 700 }}>
              {/\.(webm|mp4)$/.test(u) ? "🎞 video" : "🖼 image"}
            </a>
          ))}
        </div>
      )}
      <div style={{ background: AT.surfaceAlt, borderRadius: 12, padding: "10px 12px", display: "grid", gap: 8 }}>
        <div style={{ textAlign: "center", fontSize: 11, color: AT.inkSoft }}>
          {t("bug.chatWith")} · {detail?.comments.length ?? 0} · {t("bug.chatSynced")}
        </div>
        {(detail?.comments ?? []).map((c) => {
          const mine = c.side === "panel";
          return (
            <div key={c.id} style={{ maxWidth: "85%", marginLeft: mine ? "auto" : 0, textAlign: mine ? "right" : "left" }}>
              <div style={{ fontSize: 10.5, color: AT.inkSoft, marginBottom: 2 }}>
                <span style={{ color: mine ? AT.inkSoft : AT.accent, fontWeight: 700 }}>{mine ? c.authorLabel : `IT · ${c.authorLabel}`}</span>{" "}
                {fmtWhen(c.createdAt)}
              </div>
              <div style={{
                display: "inline-block", textAlign: "left", borderRadius: 11, padding: "8px 12px", fontSize: 12.5,
                background: mine ? AT.accent : AT.panel, color: mine ? "#fff" : AT.ink,
                border: mine ? "none" : `1px solid ${AT.ruleSoft}`,
              }}>{c.body}</div>
            </div>
          );
        })}
        {(detail?.comments.length ?? 0) === 0 && (
          <div style={{ fontSize: 12, color: AT.inkSoft, textAlign: "center" }}>{t("bug.noMessages")}</div>
        )}
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <input
          value={reply}
          onChange={(e) => setReply(e.target.value)}
          onKeyDown={(e) => (e.metaKey || e.ctrlKey) && e.key === "Enter" && void send()}
          placeholder={t("bug.replyPlaceholder")}
          style={{ flex: 1, borderRadius: 9, border: `1px solid ${AT.rule}`, fontFamily: AT.body, fontSize: 13, padding: "9px 12px", background: AT.panel, color: AT.ink }}
        />
        <button onClick={() => void send()} disabled={reply.trim().length === 0 || busy} style={{
          all: "unset", cursor: "pointer", border: `1px solid ${AT.rule}`, borderRadius: 9, padding: "9px 14px",
          fontSize: 12.5, fontWeight: 700, opacity: reply.trim().length === 0 || busy ? 0.5 : 1,
        }}>
          {t("bug.sendReply")}
        </button>
      </div>
    </div>
  );
}
