import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../api.js";
import type { Nav } from "../App.js";
import { useAuth } from "../auth.js";
import { formatDate } from "../format.js";
import { useT, type TKey } from "../i18n.js";
import { AT } from "../theme.js";
import { ABadge, ABtn, ACard, AEmpty, AField, AIcon, APills, ASelect, ATable, ATd, ATr, useConfirm, useToast } from "../ui.js";

interface Notification {
  id: string;
  type: string;
  toEmail: string;
  lang: string;
  subject: string;
  status: string;
  attempts: number;
  lastError: string | null;
  sentAt: string | null;
  createdAt: string;
}

const PREVIEW_LANGS = ["lv", "ru", "en"] as const;

/** Known notification types → translation keys; unknown types show raw. */
const TYPE_KEY: Record<string, TKey> = {
  verify_email: "ms.nt.verify_email",
  outbid: "ms.nt.outbid",
  won: "ms.nt.won",
  purchased: "ms.nt.purchased",
  payment_reminder: "ms.nt.payment_reminder",
  order_paid: "ms.nt.order_paid",
  pickup_ready: "ms.nt.pickup_ready",
  pickup_reminder: "ms.nt.pickup_reminder",
  shipped: "ms.nt.shipped",
  unpaid_cancelled: "ms.nt.unpaid_cancelled",
  no_pickup_cancelled: "ms.nt.no_pickup_cancelled",
  refunded: "ms.nt.refunded",
  checked_in: "ms.nt.checked_in",
  saved_search_hits: "ms.nt.saved_search_hits",
  watchlist_ending: "ms.nt.watchlist_ending",
  welcome_reminder: "ms.nt.welcome_reminder",
  inactive_nudge: "ms.nt.inactive_nudge",
  winback_offer: "ms.nt.winback_offer",
  lost_bid_similar: "ms.nt.lost_bid_similar",
  review_request: "ms.nt.review_request",
  referral_invite: "ms.nt.referral_invite",
  abandoned_bid: "ms.nt.abandoned_bid",
  second_purchase: "ms.nt.second_purchase",
  gift_card_received: "ms.nt.gift_card_received",
};

/** Правка поверх кодового шаблона (одна на тип × язык). */
interface TplOverride {
  type: string; lang: string;
  subject: string | null; body: string | null; html: string | null;
  ctaLabel: string | null; ctaUrl: string | null;
}
interface TplMeta { types: string[]; langs: string[]; placeholders: string[]; overrides: TplOverride[] }

const STATUS_TONE: Record<string, "ok" | "warn" | "danger" | "neutral"> = {
  sent: "ok",
  pending: "warn",
  failed: "danger",
};

const STATUS_KEY: Record<string, TKey> = {
  sent: "ms.st.sent",
  pending: "ms.st.pending",
  failed: "ms.st.failed",
};

export function NotificationsScreen({ nav: _nav }: { nav: Nav }) {
  const { t } = useT();
  const { can } = useAuth();
  const toast = useToast();
  const confirm = useConfirm();
  const [rows, setRows] = useState<Notification[]>([]);
  const [status, setStatus] = useState("all");
  const [type, setType] = useState("");

  // ── Единый центр писем: список типов и правки приходят с сервера ──────────
  const [meta, setMeta] = useState<TplMeta | null>(null);
  const loadMeta = useCallback(() => {
    void api.get<TplMeta>("/api/cms/email-templates").then(setMeta).catch(() => undefined);
  }, []);
  useEffect(() => { loadMeta(); }, [loadMeta]);

  // ── Design preview: what the customer actually receives ───────────────────
  const [pvType, setPvType] = useState<string>("won");
  const [pvLang, setPvLang] = useState<string>("lv");
  const [pv, setPv] = useState<{ subject: string; html: string; text: string } | null>(null);
  const [pvText, setPvText] = useState(false);
  const [sending, setSending] = useState(false);
  const [pvTick, setPvTick] = useState(0); // сохранение правки перечитывает превью

  useEffect(() => {
    void api
      .get<{ subject: string; html: string; text: string }>(`/api/notifications/preview?type=${pvType}&lang=${pvLang}`)
      .then(setPv)
      .catch(() => setPv(null));
  }, [pvType, pvLang, pvTick]);

  // ── Редактор текста (MD §9): правка живёт поверх кодового шаблона ─────────
  const [editOpen, setEditOpen] = useState(false);
  const [edSubject, setEdSubject] = useState("");
  const [edBody, setEdBody] = useState("");
  const [edHtml, setEdHtml] = useState("");
  const [edCtaLabel, setEdCtaLabel] = useState("");
  const [edCtaUrl, setEdCtaUrl] = useState("");
  const [edBusy, setEdBusy] = useState(false);
  const override = meta?.overrides.find((o) => o.type === pvType && o.lang === pvLang) ?? null;
  const hasOverride = !!override &&
    (override.subject !== null || override.body !== null || override.html !== null ||
     override.ctaLabel !== null || override.ctaUrl !== null);

  // Смена типа/языка подхватывает сохранённую правку в поля редактора.
  useEffect(() => {
    setEdSubject(override?.subject ?? "");
    setEdBody(override?.body ?? "");
    setEdHtml(override?.html ?? "");
    setEdCtaLabel(override?.ctaLabel ?? "");
    setEdCtaUrl(override?.ctaUrl ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pvType, pvLang, meta]);

  const saveEdit = async () => {
    setEdBusy(true);
    try {
      await api.put(`/api/cms/email-templates/${pvType}/${pvLang}`, {
        subject: edSubject.trim() || null,
        body: edBody.trim() || null,
        html: edHtml.trim() || null,
        ctaLabel: edCtaLabel.trim() || null,
        ctaUrl: edCtaUrl.trim() || null,
      });
      toast(t("ms.editSaved"), "ok");
      loadMeta();
      setPvTick((n) => n + 1);
    } catch { toast(t("ms.editFailed"), "danger"); }
    finally { setEdBusy(false); }
  };

  const resetEdit = async () => {
    if (!(await confirm({ title: t("ms.editReset"), body: `${typeLabel(pvType)} · ${pvLang.toUpperCase()}`, danger: true }))) return;
    setEdBusy(true);
    try {
      await api.delete(`/api/cms/email-templates/${pvType}/${pvLang}`);
      toast(t("ms.editSaved"), "ok");
      loadMeta();
      setPvTick((n) => n + 1);
    } catch { toast(t("ms.editFailed"), "danger"); }
    finally { setEdBusy(false); }
  };

  const sendSample = async () => {
    setSending(true);
    try {
      const r = await api.post<{ to: string }>("/api/notifications/preview/send", { type: pvType, lang: pvLang });
      toast(`${t("ms.sampleSent")} ${r.to}`, "ok");
    } catch (err) {
      toast((err as Error).message || t("ms.sampleFailed"), "danger");
    } finally {
      setSending(false);
    }
  };

  const load = () => {
    const params = new URLSearchParams({ limit: "500" });
    if (type) params.set("type", type);
    void api.get<{ notifications: Notification[] }>(`/api/notifications?${params}`).then((r) => setRows(r.notifications)).catch(() => undefined);
  };
  useEffect(load, [type]);

  const counts = useMemo(
    () => ({
      all: rows.length,
      sent: rows.filter((n) => n.status === "sent").length,
      pending: rows.filter((n) => n.status === "pending").length,
      failed: rows.filter((n) => n.status === "failed").length,
    }),
    [rows],
  );
  const visible = status === "all" ? rows : rows.filter((n) => n.status === status);

  const typeLabel = (v: string) => {
    const key = TYPE_KEY[v];
    return key ? t(key) : v.replace(/_/g, " ");
  };
  const statusLabel = (v: string) => {
    const key = STATUS_KEY[v];
    return key ? t(key) : v;
  };

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <h1 style={{ fontFamily: AT.body, fontSize: 20, fontWeight: 700, color: AT.ink }}>{t("ms.notifTitle")}</h1>
        <ABtn kind="ghost" size="sm" onClick={load}><AIcon name="refund" size={13} /> {t("c.refresh")}</ABtn>
      </div>

      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <APills
          options={[
            { id: "all", label: t("c.all"), count: counts.all },
            { id: "sent", label: t("ms.st.sent"), count: counts.sent },
            { id: "pending", label: t("ms.st.pending"), count: counts.pending },
            { id: "failed", label: t("ms.st.failed"), count: counts.failed },
          ]}
          value={status}
          onChange={setStatus}
        />
        <div style={{ marginLeft: "auto" }}>
          <ASelect label={t("ms.type")} value={type} onChange={setType}
                   options={["", ...(meta?.types ?? [])].map((v) => ({ value: v, label: v === "" ? t("c.all") : typeLabel(v) }))} />
        </div>
      </div>

      <ACard
        title={t("ms.previewTitle")}
        actions={
          <div style={{ display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}>
            <ASelect
              label={t("ms.type")}
              value={pvType}
              onChange={setPvType}
              options={(meta?.types ?? ["won"]).map((v) => ({ value: v, label: typeLabel(v) }))}
            />
            <ASelect
              label={t("ms.lang")}
              value={pvLang}
              onChange={setPvLang}
              options={PREVIEW_LANGS.map((v) => ({ value: v, label: v.toUpperCase() }))}
            />
            <ABtn kind="ghost" size="sm" onClick={() => setPvText((v) => !v)}>
              {pvText ? t("ms.showHtml") : t("ms.showText")}
            </ABtn>
            {can("content.edit") && (
              <ABtn kind={editOpen ? "dark" : "ghost"} size="sm" onClick={() => setEditOpen((v) => !v)}>
                {editOpen ? t("ms.editClose") : t("ms.edit")}
              </ABtn>
            )}
            <ABtn size="sm" disabled={sending} onClick={() => void sendSample()}>
              <AIcon name="activity" size={13} /> {t("ms.sendSample")}
            </ABtn>
          </div>
        }
      >
        {pv === null ? (
          <AEmpty text={t("ms.previewFailed")} />
        ) : (
          <div style={{ display: "grid", gap: 10 }}>
            <div style={{ fontSize: 13, color: AT.inkSoft, fontFamily: AT.body, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              <span><b style={{ color: AT.ink }}>{t("ms.subject")}:</b> {pv.subject}</span>
              {hasOverride ? <ABadge tone="warn">{t("ms.editOverrideOn")}</ABadge> : <ABadge tone="neutral">{t("ms.editOverrideOff")}</ABadge>}
            </div>

            {/* Редактор (MD §9): правка любой вēstules — тут же, рядом с
                предпросмотром; превью после сохранения показывает результат. */}
            {editOpen && can("content.edit") && (
              <div style={{ display: "grid", gap: 10, padding: 12, border: `1px solid ${AT.rule}`, borderRadius: 10 }}>
                <p style={{ fontFamily: AT.body, fontSize: 12.5, color: AT.inkSoft, margin: 0 }}>{t("ms.editHint")}</p>
                <AField label={t("ms.editSubject")}>
                  <input value={edSubject} onChange={(e) => setEdSubject(e.target.value)}
                         style={{ width: "100%", padding: "8px 10px", borderRadius: 8, border: `1px solid ${AT.rule}`, fontFamily: AT.body, fontSize: 13, boxSizing: "border-box" }} />
                </AField>
                <AField label={t("ms.editBody")}>
                  <textarea rows={7} value={edBody} onChange={(e) => setEdBody(e.target.value)}
                            style={{ width: "100%", padding: "8px 10px", borderRadius: 8, resize: "vertical", border: `1px solid ${AT.rule}`, fontFamily: AT.body, fontSize: 13, boxSizing: "border-box" }} />
                </AField>
                <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,2fr)", gap: 12 }}>
                  <AField label={t("ms.editCtaLabel")}>
                    <input value={edCtaLabel} onChange={(e) => setEdCtaLabel(e.target.value)}
                           style={{ width: "100%", padding: "8px 10px", borderRadius: 8, border: `1px solid ${AT.rule}`, fontFamily: AT.body, fontSize: 13, boxSizing: "border-box" }} />
                  </AField>
                  <AField label={t("ms.editCtaUrl")}>
                    <input value={edCtaUrl} onChange={(e) => setEdCtaUrl(e.target.value)} placeholder="https://… vai {payUrl}"
                           style={{ width: "100%", padding: "8px 10px", borderRadius: 8, border: `1px solid ${AT.rule}`, fontFamily: AT.mono, fontSize: 12, boxSizing: "border-box" }} />
                  </AField>
                </div>
                <AField label={t("ms.editHtml")}>
                  <textarea rows={5} value={edHtml} onChange={(e) => setEdHtml(e.target.value)}
                            style={{ width: "100%", padding: "8px 10px", borderRadius: 8, resize: "vertical", border: `1px solid ${AT.rule}`, fontFamily: AT.mono, fontSize: 12, boxSizing: "border-box" }} />
                </AField>
                <p style={{ fontFamily: AT.mono, fontSize: 11.5, color: AT.inkSoft, margin: 0, wordBreak: "break-word" }}>
                  {t("ms.editPlaceholders")}: {(meta?.placeholders ?? []).map((p) => `{${p}}`).join(" ")}
                </p>
                <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                  {hasOverride && <ABtn kind="danger" disabled={edBusy} onClick={() => void resetEdit()}>{t("ms.editReset")}</ABtn>}
                  <ABtn disabled={edBusy} onClick={() => void saveEdit()}>{t("ms.editSave")}</ABtn>
                </div>
              </div>
            )}
            {pvText ? (
              <pre style={{
                margin: 0, padding: 14, background: AT.surfaceAlt, borderRadius: 10, fontFamily: AT.mono,
                fontSize: 12.5, lineHeight: 1.6, color: AT.ink, whiteSpace: "pre-wrap", overflowX: "auto",
              }}>{pv.text}</pre>
            ) : (
              // Rendered in a sandboxed frame: it is the real email markup and
              // must not touch the panel's own styles or scripts.
              <iframe
                title={t("ms.previewTitle")}
                sandbox=""
                srcDoc={pv.html}
                style={{ width: "100%", height: 640, border: `1px solid ${AT.rule}`, borderRadius: 10, background: "#FFFFFF" }}
              />
            )}
            <div style={{ fontSize: 12.5, color: AT.inkSoft, fontFamily: AT.body }}>{t("ms.previewNote")}</div>
          </div>
        )}
      </ACard>

      <ACard pad={false}>
        {visible.length === 0 ? (
          <AEmpty text={t("ms.noNotifs")} />
        ) : (
          <ATable head={[t("ms.when"), t("ms.type"), t("ms.recipient"), t("ms.lang"), t("ms.subject"), t("c.status"), t("ms.sentAt")]}>
            {visible.map((n) => (
              <ATr key={n.id}>
                <ATd mono>{formatDate(n.createdAt)}</ATd>
                <ATd><ABadge tone="accent">{typeLabel(n.type)}</ABadge></ATd>
                <ATd>{n.toEmail}</ATd>
                <ATd>{n.lang}</ATd>
                <ATd><span style={{ maxWidth: 320, display: "inline-block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", verticalAlign: "bottom" }}>{n.subject}</span></ATd>
                <ATd>
                  <span title={n.lastError ?? ""}>
                    <ABadge tone={STATUS_TONE[n.status] ?? "neutral"}>
                      {statusLabel(n.status)}{n.attempts > 1 ? ` ·${n.attempts}` : ""}
                    </ABadge>
                  </span>
                </ATd>
                <ATd mono>{n.sentAt ? formatDate(n.sentAt) : "—"}</ATd>
              </ATr>
            ))}
          </ATable>
        )}
      </ACard>
    </div>
  );
}
