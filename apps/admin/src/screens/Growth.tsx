import { CATEGORIES } from "@auction/domain/categories";
import { useCallback, useEffect, useState } from "react";
import { api } from "../api.js";
import { useAuth } from "../auth.js";
import { formatDate, formatEur } from "../format.js";
import { useT, type TKey } from "../i18n.js";
import { AT } from "../theme.js";
import {
  ABadge, ABtn, ACard, ADrawer, AEmpty, AField, AInput, APills, ASelect, ATable, ATd, ATr,
  useConfirm, useToast,
} from "../ui.js";

/**
 * Mārketinga rīki (план v15): кампании, сегменты, промокоды, рефералы,
 * настройки-числа и редактируемые тексты писем и витрины. Один экран с
 * вкладками — этим всем занимается один и тот же человек.
 */

/* Админский t() не подставляет параметры — подставляем сами. */
const sub = (s: string, vars: Record<string, string | number>) =>
  s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));

const textarea = (rows: number) => ({
  width: "100%", padding: "8px 10px", borderRadius: 8, resize: "vertical" as const,
  border: `1px solid ${AT.rule}`, fontFamily: AT.body, fontSize: 13, boxSizing: "border-box" as const,
});

const dateStyle = { width: "100%", padding: "8px 10px", borderRadius: 8, border: `1px solid ${AT.rule}`, fontFamily: AT.body };

// ── Сегменты ────────────────────────────────────────────────────────────────

const RULE_FIELDS = [
  "purchase_count", "total_spent", "category_purchase_count", "category_total_spent",
  "wishlist_count", "lost_bid_count", "recency_days", "last_purchase_within_days",
  "r_score", "f_score", "m_score",
] as const;
type RuleField = (typeof RULE_FIELDS)[number];
/** Поля, где движок сравнивает центы, а человеку удобнее вводить евро. */
const EUR_FIELDS = new Set<RuleField>(["total_spent", "category_total_spent"]);
const CAT_FIELDS = new Set<RuleField>(["category_purchase_count", "category_total_spent"]);
const OPS = [">=", "<=", ">", "<", "=="] as const;

interface RuleCond { field: RuleField; op: (typeof OPS)[number]; value: number; category?: string }
interface Rule { match: "all" | "any"; conditions: RuleCond[] }
interface Segment { id: string; name: string; rule: Rule; isActive: boolean; memberCount: number; createdAt: string }

function SegmentsTab() {
  const { t } = useT();
  const { can } = useAuth();
  const toast = useToast();
  const confirm = useConfirm();
  const [rows, setRows] = useState<Segment[]>([]);
  const [editing, setEditing] = useState<Segment | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [match, setMatch] = useState<"all" | "any">("all");
  const [conds, setConds] = useState<Array<{ field: RuleField; op: string; value: string; category: string }>>([]);
  const [preview, setPreview] = useState<{ count: number; sample: Array<{ alias: string; email: string }> } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    void api.get<{ segments: Segment[] }>("/api/marketing/segments").then((r) => setRows(r.segments)).catch(() => undefined);
  }, []);
  useEffect(() => { load(); }, [load]);

  const openNew = () => {
    setName(""); setMatch("all");
    setConds([{ field: "purchase_count", op: ">=", value: "1", category: "" }]);
    setPreview(null); setEditing(null); setCreating(true);
  };
  const openEdit = (s: Segment) => {
    setName(s.name); setMatch(s.rule.match);
    setConds(s.rule.conditions.map((c) => ({
      field: c.field, op: c.op,
      value: String(EUR_FIELDS.has(c.field) ? c.value / 100 : c.value),
      category: c.category ?? "",
    })));
    setPreview(null); setEditing(s); setCreating(false);
  };
  const close = () => { setCreating(false); setEditing(null); };

  const buildRule = (): Rule | null => {
    const conditions: RuleCond[] = [];
    for (const c of conds) {
      const n = Number(c.value);
      if (!Number.isFinite(n) || n < 0) return null;
      conditions.push({
        field: c.field, op: c.op as RuleCond["op"],
        value: EUR_FIELDS.has(c.field) ? Math.round(n * 100) : n,
        ...(CAT_FIELDS.has(c.field) && c.category ? { category: c.category } : {}),
      });
    }
    return conditions.length ? { match, conditions } : null;
  };

  const doPreview = async () => {
    const rule = buildRule();
    if (!rule) { toast(t("gr.failed"), "warn"); return; }
    try { setPreview(await api.post("/api/marketing/segments/preview", { rule })); }
    catch { toast(t("gr.failed"), "danger"); }
  };

  const save = async () => {
    const rule = buildRule();
    if (!rule || name.trim().length < 2) { toast(t("gr.failed"), "warn"); return; }
    setBusy(true);
    try {
      if (editing) await api.patch(`/api/marketing/segments/${editing.id}`, { name: name.trim(), rule });
      else await api.post("/api/marketing/segments", { name: name.trim(), rule, isActive: true });
      toast(t("gr.saved"), "ok"); close(); load();
    } catch { toast(t("gr.failed"), "danger"); }
    finally { setBusy(false); }
  };

  const remove = async (s: Segment) => {
    if (!(await confirm({ title: t("gr.delete"), body: s.name, danger: true }))) return;
    try { await api.delete(`/api/marketing/segments/${s.id}`); toast(t("gr.saved"), "ok"); close(); load(); }
    catch { toast(t("gr.failed"), "danger"); }
  };

  const recompute = async () => {
    setBusy(true);
    try { await api.post("/api/marketing/segments/recompute", {}); toast(t("gr.saved"), "ok"); load(); }
    catch { toast(t("gr.failed"), "danger"); }
    finally { setBusy(false); }
  };

  const edit = can("content.edit");
  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        {edit && <ABtn kind="ghost" disabled={busy} onClick={() => void recompute()}>{t("gr.recompute")}</ABtn>}
        {edit && <ABtn onClick={openNew}>{t("gr.create")}</ABtn>}
      </div>
      <ACard>
        {rows.length === 0 ? <AEmpty text={t("gr.empty")} /> : (
          <ATable head={[t("gr.name"), t("gr.members"), t("gr.status")]}>
            {rows.map((s) => (
              <ATr key={s.id} onClick={() => openEdit(s)}>
                <ATd><strong style={{ fontWeight: 600 }}>{s.name}</strong></ATd>
                <ATd mono right>{s.memberCount}</ATd>
                <ATd>{s.isActive ? <ABadge tone="ok">{t("gr.active")}</ABadge> : <ABadge tone="neutral">{t("gr.inactive")}</ABadge>}</ATd>
              </ATr>
            ))}
          </ATable>
        )}
      </ACard>
      {(creating || editing) && (
        <ADrawer
          title={editing ? editing.name : t("gr.create")} onClose={close}
          footer={
            <>
              {editing && edit && <ABtn kind="danger" onClick={() => void remove(editing)}>{t("gr.delete")}</ABtn>}
              <ABtn kind="ghost" onClick={close}>{t("c.close")}</ABtn>
              {edit && <ABtn disabled={busy} onClick={() => void save()}>{t("gr.save")}</ABtn>}
            </>
          }
        >
          <div style={{ display: "grid", gap: 12 }}>
            <AField label={t("gr.name")}><AInput value={name} onChange={setName} /></AField>
            <ASelect value={match} onChange={(v) => setMatch(v as "all" | "any")}
                     options={[{ value: "all", label: t("gr.matchAll") }, { value: "any", label: t("gr.matchAny") }]} />
            {conds.map((c, i) => (
              <div key={i} style={{ display: "grid", gap: 8, padding: 10, border: `1px solid ${AT.rule}`, borderRadius: 10 }}>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <span style={{ fontFamily: AT.body, fontSize: 12.5, color: AT.inkSoft, flex: 1 }}>
                    {t("gr.condition")} {i + 1}
                  </span>
                  {conds.length > 1 && (
                    <ABtn kind="ghost" size="sm" onClick={() => setConds(conds.filter((_, j) => j !== i))}>×</ABtn>
                  )}
                </div>
                <ASelect value={c.field}
                         onChange={(v) => setConds(conds.map((x, j) => (j === i ? { ...x, field: v as RuleField } : x)))}
                         options={RULE_FIELDS.map((f) => ({ value: f, label: t(`gr.f.${f}` as TKey) }))} />
                <div style={{ display: "grid", gridTemplateColumns: "auto minmax(0,1fr)", gap: 8 }}>
                  <ASelect value={c.op}
                           onChange={(v) => setConds(conds.map((x, j) => (j === i ? { ...x, op: v } : x)))}
                           options={OPS.map((o) => ({ value: o, label: o }))} />
                  <AInput value={c.value}
                          onChange={(v) => setConds(conds.map((x, j) => (j === i ? { ...x, value: v } : x)))} />
                </div>
                {CAT_FIELDS.has(c.field) && (
                  <ASelect value={c.category}
                           onChange={(v) => setConds(conds.map((x, j) => (j === i ? { ...x, category: v } : x)))}
                           options={[{ value: "", label: t("gr.category") }, ...CATEGORIES.map((x) => ({ value: x.code, label: x.label }))]} />
                )}
              </div>
            ))}
            {conds.length < 10 && (
              <ABtn kind="ghost" onClick={() => setConds([...conds, { field: "purchase_count", op: ">=", value: "1", category: "" }])}>
                {t("gr.addCondition")}
              </ABtn>
            )}
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <ABtn kind="ghost" onClick={() => void doPreview()}>{t("gr.preview")}</ABtn>
              {preview && (
                <span style={{ fontFamily: AT.body, fontSize: 13 }}>{sub(t("gr.matches"), { n: preview.count })}</span>
              )}
            </div>
            {preview && preview.sample.length > 0 && (
              <p style={{ fontFamily: AT.body, fontSize: 12.5, color: AT.inkSoft, margin: 0 }}>
                {t("gr.sample")}: {preview.sample.map((p) => p.alias).join(", ")}
              </p>
            )}
          </div>
        </ADrawer>
      )}
    </div>
  );
}

// ── Кампании ────────────────────────────────────────────────────────────────

type CampaignLangContent = { subject: string; body: string };
interface Campaign {
  id: string; name: string; segmentId: string | null;
  content: Partial<Record<"lv" | "ru" | "en", CampaignLangContent>>;
  contentB: Partial<Record<"lv" | "ru" | "en", CampaignLangContent>> | null;
  status: "draft" | "scheduled" | "sending" | "sent" | "archived";
  scheduledAt: string | null;
  stats: { queued?: number; skipped?: number } | null;
  tracking: Array<{ variant: string | null; sent: number; opened: number; clicked: number }>;
  createdAt: string;
}
const CAMPAIGN_LANGS = ["lv", "ru", "en"] as const;

function CampaignsTab() {
  const { t } = useT();
  const { can } = useAuth();
  const toast = useToast();
  const [rows, setRows] = useState<Campaign[]>([]);
  const [segs, setSegs] = useState<Segment[]>([]);
  const [editing, setEditing] = useState<Campaign | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [segmentId, setSegmentId] = useState("");
  const [content, setContent] = useState<Record<string, CampaignLangContent>>({});
  const [contentB, setContentB] = useState<Record<string, CampaignLangContent>>({});
  const [showB, setShowB] = useState(false);
  const [when, setWhen] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    void api.get<{ campaigns: Campaign[] }>("/api/marketing/campaigns").then((r) => setRows(r.campaigns)).catch(() => undefined);
    void api.get<{ segments: Segment[] }>("/api/marketing/segments").then((r) => setSegs(r.segments)).catch(() => undefined);
  }, []);
  useEffect(() => { load(); }, [load]);

  const stLabel = (s: Campaign["status"]) => t(`gr.${s}` as TKey);

  const openNew = () => {
    setName(""); setSegmentId(""); setWhen("");
    setContent({ lv: { subject: "", body: "" }, ru: { subject: "", body: "" }, en: { subject: "", body: "" } });
    setContentB({}); setShowB(false);
    setEditing(null); setCreating(true);
  };
  const openEdit = (c: Campaign) => {
    setName(c.name); setSegmentId(c.segmentId ?? "");
    setWhen(c.scheduledAt ? c.scheduledAt.slice(0, 16) : "");
    setContent({
      lv: c.content.lv ?? { subject: "", body: "" },
      ru: c.content.ru ?? { subject: "", body: "" },
      en: c.content.en ?? { subject: "", body: "" },
    });
    const b = c.contentB ?? {};
    setContentB({
      lv: b.lv ?? { subject: "", body: "" },
      ru: b.ru ?? { subject: "", body: "" },
      en: b.en ?? { subject: "", body: "" },
    });
    setShowB(!!c.contentB && Object.keys(c.contentB).length > 0);
    setEditing(c); setCreating(false);
  };
  const close = () => { setCreating(false); setEditing(null); };

  const pack = (src: Record<string, CampaignLangContent>) => {
    const out: Record<string, CampaignLangContent> = {};
    for (const l of CAMPAIGN_LANGS) {
      const c = src[l];
      if (c && c.subject.trim().length >= 2 && c.body.trim().length >= 2) {
        out[l] = { subject: c.subject.trim(), body: c.body.trim() };
      }
    }
    return out;
  };

  const save = async () => {
    const body = pack(content);
    if (name.trim().length < 2 || Object.keys(body).length === 0) { toast(t("gr.failed"), "warn"); return; }
    const b = showB ? pack(contentB) : {};
    setBusy(true);
    try {
      const payload = {
        name: name.trim(), segmentId: segmentId || null, content: body,
        contentB: Object.keys(b).length > 0 ? b : null,
      };
      if (editing) await api.patch(`/api/marketing/campaigns/${editing.id}`, payload);
      else await api.post("/api/marketing/campaigns", payload);
      toast(t("gr.saved"), "ok"); close(); load();
    } catch { toast(t("gr.failed"), "danger"); }
    finally { setBusy(false); }
  };

  const action = async (c: Campaign, act: "schedule" | "unschedule" | "archive") => {
    if (act === "schedule" && !when) { toast(t("gr.failed"), "warn"); return; }
    setBusy(true);
    try {
      await api.patch(`/api/marketing/campaigns/${c.id}`, {
        action: act,
        ...(act === "schedule" ? { scheduledAt: new Date(when).toISOString() } : {}),
      });
      toast(t("gr.saved"), "ok"); close(); load();
    } catch { toast(t("gr.failed"), "danger"); }
    finally { setBusy(false); }
  };

  const segName = (id: string | null) => (id ? segs.find((s) => s.id === id)?.name ?? "—" : t("gr.allConsented"));
  const edit = can("content.edit");
  const locked = editing !== null && (editing.status === "sent" || editing.status === "sending");

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        {edit && <ABtn onClick={openNew}>{t("gr.create")}</ABtn>}
      </div>
      <ACard>
        {rows.length === 0 ? <AEmpty text={t("gr.empty")} /> : (
          <ATable head={[t("gr.name"), t("gr.segment"), t("gr.status"), ""]}>
            {rows.map((c) => (
              <ATr key={c.id} onClick={() => openEdit(c)}>
                <ATd><strong style={{ fontWeight: 600 }}>{c.name}</strong></ATd>
                <ATd>{segName(c.segmentId)}</ATd>
                <ATd>
                  <ABadge tone={c.status === "sent" ? "ok" : c.status === "scheduled" || c.status === "sending" ? "warn" : "neutral"}>
                    {stLabel(c.status)}
                  </ABadge>
                  {c.status === "scheduled" && c.scheduledAt ? ` ${formatDate(c.scheduledAt)}` : ""}
                </ATd>
                <ATd>
                  {c.status === "sent" && c.stats
                    ? sub(t("gr.queued"), { n: c.stats.queued ?? 0, m: c.stats.skipped ?? 0 })
                    : <span style={{ color: AT.inkSoft }}>—</span>}
                </ATd>
              </ATr>
            ))}
          </ATable>
        )}
      </ACard>
      {(creating || editing) && (
        <ADrawer
          title={editing ? editing.name : t("gr.create")} onClose={close} width={620}
          footer={
            <>
              <ABtn kind="ghost" onClick={close}>{t("c.close")}</ABtn>
              {edit && !locked && <ABtn disabled={busy} onClick={() => void save()}>{t("gr.save")}</ABtn>}
            </>
          }
        >
          <div style={{ display: "grid", gap: 12 }}>
            <AField label={t("gr.name")}><AInput value={name} onChange={setName} /></AField>
            <AField label={t("gr.segment")}>
              <ASelect value={segmentId} onChange={setSegmentId}
                       options={[{ value: "", label: t("gr.allConsented") },
                                 ...segs.map((s) => ({ value: s.id, label: `${s.name} (${s.memberCount})` }))]} />
            </AField>
            {CAMPAIGN_LANGS.map((l) => (
              <div key={l} style={{ display: "grid", gap: 8, padding: 10, border: `1px solid ${AT.rule}`, borderRadius: 10 }}>
                <span style={{ fontFamily: AT.body, fontSize: 12.5, fontWeight: 700, textTransform: "uppercase" }}>{l}</span>
                <AField label={t("gr.subject")}>
                  <AInput value={content[l]?.subject ?? ""} onChange={(v) => setContent((s) => ({ ...s, [l]: { subject: v, body: s[l]?.body ?? "" } }))} />
                </AField>
                <AField label={t("gr.body")}>
                  <textarea rows={5} value={content[l]?.body ?? ""}
                            onChange={(e) => setContent((s) => ({ ...s, [l]: { subject: s[l]?.subject ?? "", body: e.target.value } }))}
                            style={textarea(5)} />
                </AField>
              </div>
            ))}

            {/* A/B (MD §6.6): вариант B — по желанию; сплит пополам по id. */}
            {!showB ? (
              <ABtn kind="ghost" onClick={() => {
                setContentB({ lv: { subject: "", body: "" }, ru: { subject: "", body: "" }, en: { subject: "", body: "" } });
                setShowB(true);
              }}>{t("gr.variantB")}</ABtn>
            ) : (
              <div style={{ display: "grid", gap: 10 }}>
                <p style={{ fontFamily: AT.body, fontSize: 12.5, color: AT.inkSoft, margin: 0 }}>{t("gr.abHint")}</p>
                {CAMPAIGN_LANGS.map((l) => (
                  <div key={`b-${l}`} style={{ display: "grid", gap: 8, padding: 10, border: `1px dashed ${AT.rule}`, borderRadius: 10 }}>
                    <span style={{ fontFamily: AT.body, fontSize: 12.5, fontWeight: 700, textTransform: "uppercase" }}>B · {l}</span>
                    <AField label={t("gr.subject")}>
                      <AInput value={contentB[l]?.subject ?? ""} onChange={(v) => setContentB((s) => ({ ...s, [l]: { subject: v, body: s[l]?.body ?? "" } }))} />
                    </AField>
                    <AField label={t("gr.body")}>
                      <textarea rows={5} value={contentB[l]?.body ?? ""}
                                onChange={(e) => setContentB((s) => ({ ...s, [l]: { subject: s[l]?.subject ?? "", body: e.target.value } }))}
                                style={textarea(5)} />
                    </AField>
                  </div>
                ))}
                <ABtn kind="ghost" onClick={() => { setShowB(false); setContentB({}); }}>×</ABtn>
              </div>
            )}

            {/* Открытия/клики по вариантам — когда есть что показать. */}
            {editing && editing.tracking.length > 0 && (
              <ATable head={["", t("gr.sentN"), t("gr.opens"), t("gr.clicks")]}>
                {editing.tracking.map((tr) => (
                  <ATr key={tr.variant ?? "all"}>
                    <ATd>{tr.variant ? tr.variant.toUpperCase() : "—"}</ATd>
                    <ATd mono right>{tr.sent}</ATd>
                    <ATd mono right>{tr.opened}</ATd>
                    <ATd mono right>{tr.clicked}</ATd>
                  </ATr>
                ))}
              </ATable>
            )}
            {editing && edit && !locked && (
              <div style={{ display: "grid", gap: 8, padding: 10, border: `1px solid ${AT.rule}`, borderRadius: 10 }}>
                {editing.status !== "scheduled" ? (
                  <>
                    <AField label={t("gr.schedule")}>
                      <input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} style={dateStyle} />
                    </AField>
                    <div style={{ display: "flex", gap: 8 }}>
                      <ABtn disabled={busy} onClick={() => void action(editing, "schedule")}>{t("gr.schedule")}</ABtn>
                      <ABtn kind="ghost" disabled={busy} onClick={() => void action(editing, "archive")}>{t("gr.archive")}</ABtn>
                    </div>
                  </>
                ) : (
                  <ABtn kind="ghost" disabled={busy} onClick={() => void action(editing, "unschedule")}>{t("gr.unschedule")}</ABtn>
                )}
              </div>
            )}
          </div>
        </ADrawer>
      )}
    </div>
  );
}

// ── Промокоды ───────────────────────────────────────────────────────────────

interface Promo {
  id: string; code: string; type: "percent" | "fixed"; value: number;
  minOrderCents: number | null; category: string | null; usageLimitTotal: number | null;
  usageLimitPerUser: number | null; validTo: string | null; isActive: boolean;
  source: string; customerId: string | null; createdAt: string;
  usage: { redemptions: number; discountCents: number };
}

function PromoTab() {
  const { t } = useT();
  const { can } = useAuth();
  const toast = useToast();
  const [rows, setRows] = useState<Promo[]>([]);
  const [editing, setEditing] = useState<Promo | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ code: "", type: "percent", value: "10", minOrder: "", category: "", limitTotal: "", limitUser: "", validTo: "" });
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    void api.get<{ codes: Promo[] }>("/api/marketing/promo-codes").then((r) => setRows(r.codes)).catch(() => undefined);
  }, []);
  useEffect(() => { load(); }, [load]);

  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));

  const save = async () => {
    const value = Number(form.value);
    const code = form.code.trim().toUpperCase();
    if (!/^[A-Z0-9-]{3,40}$/.test(code) || !Number.isFinite(value) || value < 1) { toast(t("gr.failed"), "warn"); return; }
    setBusy(true);
    try {
      await api.post("/api/marketing/promo-codes", {
        code,
        type: form.type,
        value: form.type === "fixed" ? Math.round(value * 100) : Math.round(value),
        minOrderCents: form.minOrder ? Math.round(Number(form.minOrder) * 100) : null,
        category: form.category || null,
        usageLimitTotal: form.limitTotal ? Number(form.limitTotal) : null,
        usageLimitPerUser: form.limitUser ? Number(form.limitUser) : null,
        validTo: form.validTo ? new Date(`${form.validTo}T23:59:59Z`).toISOString() : null,
      });
      toast(t("gr.saved"), "ok"); setCreating(false); load();
    } catch { toast(t("gr.failed"), "danger"); }
    finally { setBusy(false); }
  };

  const toggle = async (p: Promo) => {
    setBusy(true);
    try { await api.patch(`/api/marketing/promo-codes/${p.id}`, { isActive: !p.isActive }); toast(t("gr.saved"), "ok"); setEditing(null); load(); }
    catch { toast(t("gr.failed"), "danger"); }
    finally { setBusy(false); }
  };

  const edit = can("content.edit");
  const valLabel = (p: Promo) => (p.type === "percent" ? `−${p.value}%` : `−${formatEur(p.value)}`);

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        {edit && <ABtn onClick={() => { setForm({ code: "", type: "percent", value: "10", minOrder: "", category: "", limitTotal: "", limitUser: "", validTo: "" }); setCreating(true); }}>{t("gr.create")}</ABtn>}
      </div>
      <ACard>
        {rows.length === 0 ? <AEmpty text={t("gr.empty")} /> : (
          <ATable head={[t("gr.code"), t("gr.type"), t("gr.usage"), t("gr.validTo"), t("gr.status")]}>
            {rows.map((p) => (
              <ATr key={p.id} onClick={() => setEditing(p)}>
                <ATd mono><strong style={{ fontWeight: 600 }}>{p.code}</strong></ATd>
                <ATd>{valLabel(p)}</ATd>
                <ATd mono right>{p.usage.redemptions}{p.usage.discountCents > 0 ? ` · ${formatEur(p.usage.discountCents)}` : ""}</ATd>
                <ATd>{p.validTo ? formatDate(p.validTo).slice(0, 10) : <span style={{ color: AT.inkSoft }}>—</span>}</ATd>
                <ATd>{p.isActive ? <ABadge tone="ok">{t("gr.active")}</ABadge> : <ABadge tone="neutral">{t("gr.inactive")}</ABadge>}</ATd>
              </ATr>
            ))}
          </ATable>
        )}
      </ACard>
      {creating && (
        <ADrawer title={t("gr.create")} onClose={() => setCreating(false)}
                 footer={
                   <>
                     <ABtn kind="ghost" onClick={() => setCreating(false)}>{t("c.close")}</ABtn>
                     {edit && <ABtn disabled={busy} onClick={() => void save()}>{t("gr.save")}</ABtn>}
                   </>
                 }>
          <div style={{ display: "grid", gap: 12 }}>
            <AField label={t("gr.code")}><AInput value={form.code} onChange={(v) => set({ code: v.toUpperCase() })} placeholder="VASARA25" /></AField>
            <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)", gap: 12 }}>
              <AField label={t("gr.type")}>
                <ASelect value={form.type} onChange={(v) => set({ type: v })}
                         options={[{ value: "percent", label: t("gr.percent") }, { value: "fixed", label: t("gr.fixed") }]} />
              </AField>
              <AField label={form.type === "percent" ? t("gr.percent") : t("gr.fixed")}>
                <AInput value={form.value} onChange={(v) => set({ value: v })} />
              </AField>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)", gap: 12 }}>
              <AField label={t("gr.minOrder")}><AInput value={form.minOrder} onChange={(v) => set({ minOrder: v })} /></AField>
              <AField label={t("gr.validTo")}>
                <input type="date" value={form.validTo} onChange={(e) => set({ validTo: e.target.value })} style={dateStyle} />
              </AField>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)", gap: 12 }}>
              <AField label={t("gr.limitTotal")}><AInput value={form.limitTotal} onChange={(v) => set({ limitTotal: v })} /></AField>
              <AField label={t("gr.limitUser")}><AInput value={form.limitUser} onChange={(v) => set({ limitUser: v })} /></AField>
            </div>
            <AField label={t("gr.category")}>
              <ASelect value={form.category} onChange={(v) => set({ category: v })}
                       options={[{ value: "", label: "—" }, ...CATEGORIES.map((c) => ({ value: c.code, label: c.label }))]} />
            </AField>
          </div>
        </ADrawer>
      )}
      {editing && (
        <ADrawer title={editing.code} onClose={() => setEditing(null)}
                 footer={
                   <>
                     <ABtn kind="ghost" onClick={() => setEditing(null)}>{t("c.close")}</ABtn>
                     {edit && (
                       <ABtn kind={editing.isActive ? "danger" : "primary"} disabled={busy} onClick={() => void toggle(editing)}>
                         {editing.isActive ? t("gr.inactive") : t("gr.active")}
                       </ABtn>
                     )}
                   </>
                 }>
          <div style={{ display: "grid", gap: 8, fontFamily: AT.body, fontSize: 13.5 }}>
            <div>{t("gr.type")}: <strong>{valLabel(editing)}</strong></div>
            <div>{t("gr.usage")}: <strong>{editing.usage.redemptions}</strong>{editing.usage.discountCents > 0 ? ` (−${formatEur(editing.usage.discountCents)})` : ""}</div>
            {editing.minOrderCents !== null && <div>{t("gr.minOrder")}: {formatEur(editing.minOrderCents)}</div>}
            {editing.usageLimitTotal !== null && <div>{t("gr.limitTotal")}: {editing.usageLimitTotal}</div>}
            {editing.usageLimitPerUser !== null && <div>{t("gr.limitUser")}: {editing.usageLimitPerUser}</div>}
            {editing.validTo && <div>{t("gr.validTo")}: {formatDate(editing.validTo)}</div>}
            <div style={{ color: AT.inkSoft }}>{editing.source}{editing.category ? ` · ${editing.category}` : ""}</div>
          </div>
        </ADrawer>
      )}
    </div>
  );
}

// ── Рефералы ────────────────────────────────────────────────────────────────

interface Referral {
  id: string; referrerAlias: string; referredAlias: string;
  status: "pending" | "signup_rewarded" | "order_rewarded"; fraudFlag: boolean; createdAt: string;
}

function ReferralsTab() {
  const { t } = useT();
  const { can } = useAuth();
  const toast = useToast();
  const confirm = useConfirm();
  const [rows, setRows] = useState<Referral[]>([]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    void api.get<{ referrals: Referral[] }>("/api/marketing/referrals").then((r) => setRows(r.referrals)).catch(() => undefined);
  }, []);
  useEffect(() => { load(); }, [load]);

  const act = async (r: Referral, what: "approve" | "reject") => {
    if (what === "reject" && !(await confirm({ title: t("gr.reject"), body: r.referredAlias, danger: true }))) return;
    setBusy(true);
    try { await api.post(`/api/marketing/referrals/${r.id}/${what}`, {}); toast(t("gr.saved"), "ok"); load(); }
    catch { toast(t("gr.failed"), "danger"); }
    finally { setBusy(false); }
  };

  const edit = can("content.edit");
  return (
    <ACard>
      {rows.length === 0 ? <AEmpty text={t("gr.empty")} /> : (
        <ATable head={[t("gr.referrer"), t("gr.referred"), t("gr.status"), ""]}>
          {rows.map((r) => (
            <ATr key={r.id}>
              <ATd>{r.referrerAlias}</ATd>
              <ATd>{r.referredAlias}</ATd>
              <ATd>
                {r.fraudFlag && <ABadge tone="warn">{t("gr.fraud")}</ABadge>}{" "}
                <ABadge tone={r.status === "order_rewarded" ? "ok" : "neutral"}>{r.status.replace(/_/g, " ")}</ABadge>
              </ATd>
              <ATd>
                {edit && r.fraudFlag && (
                  <span style={{ display: "inline-flex", gap: 6 }}>
                    <ABtn size="sm" disabled={busy} onClick={() => void act(r, "approve")}>{t("gr.approve")}</ABtn>
                    <ABtn size="sm" kind="ghost" disabled={busy} onClick={() => void act(r, "reject")}>{t("gr.reject")}</ABtn>
                  </span>
                )}
              </ATd>
            </ATr>
          ))}
        </ATable>
      )}
    </ACard>
  );
}

// ── Настройки-числа ─────────────────────────────────────────────────────────

const SETTING_LABELS = [
  "welcome_percent", "welcome_valid_days", "welcome_reminder_day",
  "referral_percent", "referral_signup_points_cents", "referral_order_points_cents",
  "winback_days", "winback_percent", "winback_percent_high", "winback_valid_days",
  "points_per_eur_cents", "points_redeem_max_bp", "inactive_nudge_days", "review_request_days",
  "abandoned_bid_hours", "abandoned_view_days", "second_purchase_days",
  "tier_silver_cents", "tier_gold_cents", "tier_silver_earn_bp", "tier_gold_earn_bp",
  "gift_card_valid_days",
  "cart_reminder_first_hours", "cart_reminder_second_hours",
  "price_drop_min_bp", "price_drop_delay_min",
] as const;

function SettingsTab() {
  const { t } = useT();
  const { can } = useAuth();
  const toast = useToast();
  const [values, setValues] = useState<Record<string, string>>({});
  const [defaults, setDefaults] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    void api.get<{ settings: Record<string, number>; defaults: Record<string, number> }>("/api/cms/marketing-settings")
      .then((r) => {
        setDefaults(r.defaults);
        setValues(Object.fromEntries(Object.entries(r.settings).map(([k, v]) => [k, String(v)])));
      })
      .catch(() => undefined);
  }, []);
  useEffect(() => { load(); }, [load]);

  const save = async () => {
    const body: Record<string, number> = {};
    for (const [k, v] of Object.entries(values)) {
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) { toast(t("gr.failed"), "warn"); return; }
      body[k] = n;
    }
    setBusy(true);
    try { await api.put("/api/cms/marketing-settings", body); toast(t("gr.saved"), "ok"); load(); }
    catch { toast(t("gr.failed"), "danger"); }
    finally { setBusy(false); }
  };

  const keys = SETTING_LABELS.filter((k) => k in values);
  return (
    <div style={{ display: "grid", gap: 12 }}>
      <p style={{ fontFamily: AT.body, fontSize: 13, color: AT.inkSoft, margin: 0, maxWidth: "70ch" }}>{t("gr.settingsHint")}</p>
      <ACard>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 12 }}>
          {keys.map((k) => (
            <AField key={k} label={t(`s.${k}` as TKey)} hint={`↺ ${defaults[k] ?? ""}`}>
              <AInput value={values[k] ?? ""} onChange={(v) => setValues((s) => ({ ...s, [k]: v }))} />
            </AField>
          ))}
        </div>
        {can("settings.edit") && (
          <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 12 }}>
            <ABtn disabled={busy} onClick={() => void save()}>{t("gr.save")}</ABtn>
          </div>
        )}
      </ACard>
    </div>
  );
}

// ── Тексты витрины ──────────────────────────────────────────────────────────

interface UiOverride { key: string; lang: string; text: string }
const UI_LANGS = ["lv", "ru", "en", "et", "lt"];

function StringsTab() {
  const { t } = useT();
  const { can } = useAuth();
  const toast = useToast();
  const confirm = useConfirm();
  const [rows, setRows] = useState<UiOverride[]>([]);
  const [key, setKey] = useState("");
  const [lang, setLang] = useState("lv");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    void api.get<{ overrides: UiOverride[] }>("/api/cms/ui-strings").then((r) => setRows(r.overrides)).catch(() => undefined);
  }, []);
  useEffect(() => { load(); }, [load]);

  const save = async () => {
    if (!key.trim() || !text.trim()) { toast(t("gr.failed"), "warn"); return; }
    setBusy(true);
    try {
      await api.put("/api/cms/ui-strings", { key: key.trim(), lang, text });
      toast(t("gr.saved"), "ok"); setKey(""); setText(""); load();
    } catch { toast(t("gr.failed"), "danger"); }
    finally { setBusy(false); }
  };

  const remove = async (r: UiOverride) => {
    if (!(await confirm({ title: t("gr.reset"), body: `${r.key}/${r.lang}`, danger: true }))) return;
    try { await api.delete("/api/cms/ui-strings", { key: r.key, lang: r.lang }); toast(t("gr.saved"), "ok"); load(); }
    catch { toast(t("gr.failed"), "danger"); }
  };

  const edit = can("content.edit");
  return (
    <div style={{ display: "grid", gap: 12 }}>
      <p style={{ fontFamily: AT.body, fontSize: 13, color: AT.inkSoft, margin: 0, maxWidth: "70ch" }}>{t("gr.stringsHint")}</p>
      {edit && (
        <ACard>
          <div style={{ display: "grid", gap: 12 }}>
            <div style={{ display: "grid", gridTemplateColumns: "minmax(0,2fr) minmax(0,1fr)", gap: 12 }}>
              <AField label={t("gr.stringKey")}><AInput value={key} onChange={setKey} placeholder="cart.add" /></AField>
              <AField label={t("gr.lang")}>
                <ASelect value={lang} onChange={setLang} options={UI_LANGS.map((x) => ({ value: x, label: x.toUpperCase() }))} />
              </AField>
            </div>
            <AField label={t("gr.stringText")}>
              <textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} style={textarea(3)} />
            </AField>
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <ABtn disabled={busy} onClick={() => void save()}>{t("gr.save")}</ABtn>
            </div>
          </div>
        </ACard>
      )}
      <ACard>
        {rows.length === 0 ? <AEmpty text={t("gr.empty")} /> : (
          <ATable head={[t("gr.stringKey"), t("gr.lang"), t("gr.stringText"), ""]}>
            {rows.map((r) => (
              <ATr key={`${r.key}/${r.lang}`} onClick={() => { setKey(r.key); setLang(r.lang); setText(r.text); }}>
                <ATd mono>{r.key}</ATd>
                <ATd>{r.lang.toUpperCase()}</ATd>
                <ATd>{r.text.length > 80 ? `${r.text.slice(0, 80)}…` : r.text}</ATd>
                <ATd>
                  {edit && <ABtn size="sm" kind="ghost" onClick={() => void remove(r)}>{t("gr.reset")}</ABtn>}
                </ATd>
              </ATr>
            ))}
          </ATable>
        )}
      </ACard>
    </div>
  );
}

// ── Dāvanu kartes (MD §3) ───────────────────────────────────────────────────

interface GiftCard {
  id: string; code: string; initialCents: number; balanceCents: number;
  customerId: string | null; redeemedAt: string | null; expiresAt: string | null;
  isActive: boolean; note: string | null; issuedBy: string | null; createdAt: string;
}

function GiftTab() {
  const { t } = useT();
  const { can } = useAuth();
  const toast = useToast();
  const [rows, setRows] = useState<GiftCard[]>([]);
  const [amount, setAmount] = useState("50");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    void api.get<{ cards: GiftCard[] }>("/api/marketing/gift-cards").then((r) => setRows(r.cards)).catch(() => undefined);
  }, []);
  useEffect(() => { load(); }, [load]);

  const issue = async () => {
    const eur = Number(amount);
    if (!Number.isFinite(eur) || eur < 1) { toast(t("gr.failed"), "warn"); return; }
    setBusy(true);
    try {
      await api.post("/api/marketing/gift-cards", { initialCents: Math.round(eur * 100), ...(note.trim() ? { note: note.trim() } : {}) });
      toast(t("gr.saved"), "ok"); setNote(""); load();
    } catch { toast(t("gr.failed"), "danger"); }
    finally { setBusy(false); }
  };

  const toggle = async (g: GiftCard) => {
    try { await api.patch(`/api/marketing/gift-cards/${g.id}`, { isActive: !g.isActive }); load(); }
    catch { toast(t("gr.failed"), "danger"); }
  };

  const edit = can("content.edit");
  return (
    <div style={{ display: "grid", gap: 12 }}>
      <p style={{ fontFamily: AT.body, fontSize: 13, color: AT.inkSoft, margin: 0, maxWidth: "70ch" }}>{t("gr.giftHint")}</p>
      {edit && (
        <ACard>
          <div style={{ display: "flex", gap: 12, alignItems: "flex-end", flexWrap: "wrap" }}>
            <AField label={t("gr.giftAmount")}><AInput value={amount} onChange={setAmount} /></AField>
            <AField label={t("gr.giftNote")}><AInput value={note} onChange={setNote} /></AField>
            <ABtn disabled={busy} onClick={() => void issue()}>{t("gr.giftIssue")}</ABtn>
          </div>
        </ACard>
      )}
      <ACard>
        {rows.length === 0 ? <AEmpty text={t("gr.empty")} /> : (
          <ATable head={[t("gr.code"), t("gr.giftAmount"), t("gr.status"), t("gr.giftNote"), t("gr.validTo")]}>
            {rows.map((g) => (
              <ATr key={g.id} onClick={() => { if (edit && !g.redeemedAt) void toggle(g); }}>
                <ATd mono><strong style={{ fontWeight: 600 }}>{g.code}</strong></ATd>
                <ATd mono right>{(g.initialCents / 100).toFixed(2)}</ATd>
                <ATd>
                  {g.redeemedAt ? <ABadge tone="ok">{t("gr.giftRedeemed")}</ABadge>
                    : g.isActive ? <ABadge tone="neutral">{t("gr.giftOpen")}</ABadge>
                    : <ABadge tone="warn">{t("gr.inactive")}</ABadge>}
                </ATd>
                <ATd>{g.note ?? <span style={{ color: AT.inkSoft }}>—</span>}</ATd>
                <ATd>{g.expiresAt ? formatDate(g.expiresAt).slice(0, 10) : "—"}</ATd>
              </ATr>
            ))}
          </ATable>
        )}
      </ACard>
    </div>
  );
}

// ── Partneri (affiliate, MD §6.7) ───────────────────────────────────────────

interface Affiliate {
  id: string; name: string; code: string; contact: string | null; commissionBp: number;
  isActive: boolean; createdAt: string;
  stats: { signups: number; paidOrders: number; goodsCents: number; commissionCents: number };
}

function AffiliatesTab() {
  const { t } = useT();
  const { can } = useAuth();
  const toast = useToast();
  const [rows, setRows] = useState<Affiliate[]>([]);
  const [form, setForm] = useState({ name: "", code: "", contact: "", commission: "5" });
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    void api.get<{ affiliates: Affiliate[] }>("/api/marketing/affiliates").then((r) => setRows(r.affiliates)).catch(() => undefined);
  }, []);
  useEffect(() => { load(); }, [load]);

  const create = async () => {
    const pct = Number(form.commission);
    if (form.name.trim().length < 2 || !/^[A-Z0-9-]{3,24}$/i.test(form.code.trim()) || !Number.isFinite(pct)) {
      toast(t("gr.failed"), "warn"); return;
    }
    setBusy(true);
    try {
      await api.post("/api/marketing/affiliates", {
        name: form.name.trim(), code: form.code.trim().toUpperCase(),
        ...(form.contact.trim() ? { contact: form.contact.trim() } : {}),
        commissionBp: Math.round(pct * 100),
      });
      toast(t("gr.saved"), "ok"); setForm({ name: "", code: "", contact: "", commission: "5" }); load();
    } catch { toast(t("gr.failed"), "danger"); }
    finally { setBusy(false); }
  };

  const toggle = async (a: Affiliate) => {
    try { await api.patch(`/api/marketing/affiliates/${a.id}`, { isActive: !a.isActive }); load(); }
    catch { toast(t("gr.failed"), "danger"); }
  };

  const eur = (c: number) => `${(c / 100).toFixed(2)} €`;
  const edit = can("content.edit");
  return (
    <div style={{ display: "grid", gap: 12 }}>
      <p style={{ fontFamily: AT.body, fontSize: 13, color: AT.inkSoft, margin: 0, maxWidth: "70ch" }}>{t("gr.affHint")}</p>
      {edit && (
        <ACard>
          <div style={{ display: "flex", gap: 12, alignItems: "flex-end", flexWrap: "wrap" }}>
            <AField label={t("gr.name")}><AInput value={form.name} onChange={(v) => setForm((f) => ({ ...f, name: v }))} /></AField>
            <AField label={t("gr.code")}><AInput value={form.code} onChange={(v) => setForm((f) => ({ ...f, code: v.toUpperCase() }))} placeholder="JANIS" /></AField>
            <AField label={t("gr.affContact")}><AInput value={form.contact} onChange={(v) => setForm((f) => ({ ...f, contact: v }))} /></AField>
            <AField label={t("gr.affCommission")}><AInput value={form.commission} onChange={(v) => setForm((f) => ({ ...f, commission: v }))} /></AField>
            <ABtn disabled={busy} onClick={() => void create()}>{t("gr.create")}</ABtn>
          </div>
        </ACard>
      )}
      <ACard>
        {rows.length === 0 ? <AEmpty text={t("gr.empty")} /> : (
          <ATable head={[t("gr.name"), t("gr.affLink"), t("gr.affCommission"), t("gr.affSignups"), t("gr.affOrders"), t("gr.affRevenue"), t("gr.affOwed"), t("gr.status")]}>
            {rows.map((a) => (
              <ATr key={a.id} onClick={() => { if (edit) void toggle(a); }}>
                <ATd><strong style={{ fontWeight: 600 }}>{a.name}</strong>{a.contact ? <span style={{ color: AT.inkSoft }}> · {a.contact}</span> : null}</ATd>
                <ATd mono>?aff={a.code}</ATd>
                <ATd mono right>{(a.commissionBp / 100).toFixed(1)}%</ATd>
                <ATd mono right>{a.stats.signups}</ATd>
                <ATd mono right>{a.stats.paidOrders}</ATd>
                <ATd mono right>{eur(a.stats.goodsCents)}</ATd>
                <ATd mono right><strong>{eur(a.stats.commissionCents)}</strong></ATd>
                <ATd>{a.isActive ? <ABadge tone="ok">{t("gr.active")}</ABadge> : <ABadge tone="neutral">{t("gr.inactive")}</ABadge>}</ATd>
              </ATr>
            ))}
          </ATable>
        )}
      </ACard>
    </div>
  );
}

// ── Klientu pulss (churn, MD §6.3) ──────────────────────────────────────────

interface Churn {
  buckets: Record<"active" | "at_risk" | "lapsed", { n: number; valueCents: number }>;
  atRiskTop: Array<{ customerId: string; alias: string; email: string; rScore: number | null; monetaryCents: number; recencyDays: number | null }>;
}

function ChurnTab() {
  const { t } = useT();
  const [data, setData] = useState<Churn | null>(null);

  useEffect(() => {
    void api.get<Churn>("/api/marketing/churn").then(setData).catch(() => undefined);
  }, []);

  if (!data) return <ACard><AEmpty text="…" /></ACard>;
  const eur = (c: number) => `${Math.round(c / 100)} €`;
  const cell = (label: string, b: { n: number; valueCents: number }, tone: "ok" | "warn" | "danger") => (
    <div style={{ padding: 14, border: `1px solid ${AT.rule}`, borderRadius: 10, display: "grid", gap: 4 }}>
      <ABadge tone={tone}>{label}</ABadge>
      <span style={{ fontFamily: AT.body, fontSize: 26, fontWeight: 700 }}>{b.n}</span>
      <span style={{ fontFamily: AT.body, fontSize: 12.5, color: AT.inkSoft }}>{t("gr.churnValue")}: {eur(b.valueCents)}</span>
    </div>
  );
  return (
    <div style={{ display: "grid", gap: 12 }}>
      <p style={{ fontFamily: AT.body, fontSize: 13, color: AT.inkSoft, margin: 0, maxWidth: "70ch" }}>{t("gr.churnHint")}</p>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 }}>
        {cell(t("gr.churnActive"), data.buckets.active, "ok")}
        {cell(t("gr.churnAtRisk"), data.buckets.at_risk, "warn")}
        {cell(t("gr.churnLapsed"), data.buckets.lapsed, "danger")}
      </div>
      <ACard title={t("gr.churnTop")}>
        {data.atRiskTop.length === 0 ? <AEmpty text={t("gr.empty")} /> : (
          <ATable head={[t("gr.name"), "R", t("gr.churnValue"), t("gr.churnDays")]}>
            {data.atRiskTop.map((c) => (
              <ATr key={c.customerId}>
                <ATd><strong style={{ fontWeight: 600 }}>{c.alias}</strong> <span style={{ color: AT.inkSoft }}>{c.email}</span></ATd>
                <ATd mono right>{c.rScore ?? "—"}</ATd>
                <ATd mono right>{eur(c.monetaryCents)}</ATd>
                <ATd mono right>{c.recencyDays ?? "—"}</ATd>
              </ATr>
            ))}
          </ATable>
        )}
      </ACard>
    </div>
  );
}

// ── Klients 360 (MD §7.6) — профиль + баллы + ручная корректировка ─────────

interface C360 {
  customer: { id: string; alias: string; email: string; country: string | null; createdAt: string; marketingOptIn: boolean; unsubscribedAt: string | null; blocked: boolean };
  orders: { paid: number; totalCents: number; lastPaidAt: string | null };
  loyalty: { tier: string; lifetimeEarnedCents: number; toNextCents: number | null; earnBp: number };
  rfm: { rScore: number | null; fScore: number | null; mScore: number | null; recencyDays: number | null } | null;
  categories: Array<{ category: string; purchase_count: number; total_spent_cents: number; view_count: number }>;
  referrals: Record<string, number>;
  promoCodes: Array<{ code: string; type: string; value: number; usedCount: number; validTo: string | null; isActive: boolean }>;
}

function Customer360Tab() {
  const { t } = useT();
  const { can } = useAuth();
  const toast = useToast();
  const [q, setQ] = useState("");
  const [data, setData] = useState<C360 | null>(null);
  const [missing, setMissing] = useState(false);
  const [balance, setBalance] = useState<number | null>(null);
  const [adj, setAdj] = useState({ amount: "", note: "" });
  const [busy, setBusy] = useState(false);

  const search = async () => {
    if (q.trim().length < 3) return;
    setMissing(false); setData(null); setBalance(null);
    try {
      const r = await api.get<C360>(`/api/marketing/customer360?q=${encodeURIComponent(q.trim().toLowerCase())}`);
      setData(r);
      const l = await api.get<{ balanceCents: number }>(`/api/marketing/loyalty/${r.customer.id}`);
      setBalance(l.balanceCents);
    } catch { setMissing(true); }
  };

  const adjust = async () => {
    if (!data) return;
    const eur = Number(adj.amount);
    if (!Number.isFinite(eur) || eur === 0 || adj.note.trim().length < 3) { toast(t("gr.failed"), "warn"); return; }
    setBusy(true);
    try {
      const r = await api.post<{ balanceCents: number }>(`/api/marketing/loyalty/${data.customer.id}/adjust`, {
        amountCents: Math.round(eur * 100), note: adj.note.trim(),
      });
      setBalance(r.balanceCents); setAdj({ amount: "", note: "" });
      toast(t("gr.saved"), "ok");
    } catch { toast(t("gr.failed"), "danger"); }
    finally { setBusy(false); }
  };

  const eur = (c: number) => `${(c / 100).toFixed(2)} €`;
  const tierLabel = (x: string) => t(x === "gold" ? "gr.tierGold" : x === "silver" ? "gr.tierSilver" : "gr.tierBronze");
  const line = (k: string, v: string) => (
    <div style={{ display: "flex", gap: 8, fontFamily: AT.body, fontSize: 13.5 }}>
      <span style={{ color: AT.inkSoft, minWidth: 180 }}>{k}</span><strong style={{ fontWeight: 600 }}>{v}</strong>
    </div>
  );

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div style={{ display: "flex", gap: 8 }}>
        <AInput value={q} onChange={setQ} placeholder={t("gr.q360")} style={{ maxWidth: 340 }} />
        <ABtn onClick={() => void search()}>{t("gr.search")}</ABtn>
      </div>
      {missing && <ACard><AEmpty text={t("gr.notFound")} /></ACard>}
      {data && (
        <>
          <ACard title={`${data.customer.alias} · ${data.customer.email}`}>
            <div style={{ display: "grid", gap: 6 }}>
              {line(t("gr.o360Orders"), `${data.orders.paid} · ${eur(data.orders.totalCents)}`)}
              {line(t("gr.o360LastPaid"), data.orders.lastPaidAt ? formatDate(data.orders.lastPaidAt) : "—")}
              {line(t("gr.o360Points"), `${balance !== null ? eur(balance) : "…"} · ${tierLabel(data.loyalty.tier)} (${eur(data.loyalty.lifetimeEarnedCents)})`)}
              {line("RFM", data.rfm ? `R${data.rfm.rScore ?? "—"} F${data.rfm.fScore ?? "—"} M${data.rfm.mScore ?? "—"}` : "—")}
              {line(t("gr.o360Consent"), data.customer.unsubscribedAt ? "✕" : data.customer.marketingOptIn ? "✓" : "—")}
              {line(t("gr.o360Refs"), Object.entries(data.referrals).map(([k, v]) => `${k}: ${v}`).join(" · ") || "—")}
              {line(t("gr.o360Cats"), data.categories.map((c) => c.category).slice(0, 4).join(", ") || "—")}
              {line(t("gr.o360Codes"), data.promoCodes.map((c) => `${c.code}${c.usedCount > 0 ? " ✓" : ""}`).join(", ") || "—")}
            </div>
          </ACard>
          {can("content.edit") && (
            <ACard title={t("gr.adjust")}>
              <div style={{ display: "flex", gap: 12, alignItems: "flex-end", flexWrap: "wrap" }}>
                <AField label={t("gr.amountCents")}><AInput value={adj.amount} onChange={(v) => setAdj((s) => ({ ...s, amount: v }))} placeholder="10 / -5" /></AField>
                <AField label={t("gr.adjustNote")}><AInput value={adj.note} onChange={(v) => setAdj((s) => ({ ...s, note: v }))} /></AField>
                <ABtn disabled={busy} onClick={() => void adjust()}>{t("gr.save")}</ABtn>
              </div>
            </ACard>
          )}
        </>
      )}
    </div>
  );
}

// ── Экран ───────────────────────────────────────────────────────────────────

type Tab = "campaigns" | "segments" | "promo" | "referrals" | "gift" | "affiliates" | "churn" | "c360" | "settings" | "strings";

export function GrowthScreen() {
  const { t } = useT();
  const { can } = useAuth();
  const [tab, setTab] = useState<Tab>("campaigns");

  const tabs: Array<{ id: Tab; label: string }> = [
    { id: "campaigns", label: t("gr.tabCampaigns") },
    { id: "segments", label: t("gr.tabSegments") },
    { id: "promo", label: t("gr.tabPromo") },
    { id: "referrals", label: t("gr.tabReferrals") },
    { id: "gift", label: t("gr.tabGift") },
    { id: "affiliates", label: t("gr.tabAffiliates") },
    { id: "churn", label: t("gr.tabChurn") },
    ...(can("customers.view") ? [{ id: "c360" as Tab, label: t("gr.tab360") }] : []),
    ...(can("settings.view") ? [{ id: "settings" as Tab, label: t("gr.tabSettings") }] : []),
    { id: "strings", label: t("gr.tabStrings") },
  ];

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <h1 style={{ fontFamily: AT.body, fontSize: 20, fontWeight: 700, color: AT.ink, margin: 0 }}>{t("gr.title")}</h1>
      <APills options={tabs.map((x) => ({ id: x.id, label: x.label }))} value={tab} onChange={setTab} />
      {tab === "campaigns" && <CampaignsTab />}
      {tab === "segments" && <SegmentsTab />}
      {tab === "promo" && <PromoTab />}
      {tab === "referrals" && <ReferralsTab />}
      {tab === "gift" && <GiftTab />}
      {tab === "affiliates" && <AffiliatesTab />}
      {tab === "churn" && <ChurnTab />}
      {tab === "c360" && <Customer360Tab />}
      {tab === "settings" && <SettingsTab />}
      {tab === "strings" && <StringsTab />}
    </div>
  );
}
