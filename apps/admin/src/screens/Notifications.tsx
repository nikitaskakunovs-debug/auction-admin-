import { useEffect, useMemo, useState } from "react";
import { api } from "../api.js";
import type { Nav } from "../App.js";
import { formatDate } from "../format.js";
import { useT, type TKey } from "../i18n.js";
import { AT } from "../theme.js";
import { ABadge, ABtn, ACard, AEmpty, AIcon, APills, ASelect, ATable, ATd, ATr, useToast } from "../ui.js";

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

const TYPES = ["", "outbid", "won", "payment_reminder", "order_paid"];

/** Every designed email, in the order a customer would meet them. */
const PREVIEW_TYPES = [
  "won", "purchased", "payment_reminder", "order_paid", "pickup_ready", "pickup_reminder",
  "shipped", "outbid", "unpaid_cancelled", "no_pickup_cancelled", "refunded",
] as const;

const PREVIEW_LANGS = ["lv", "ru", "en"] as const;

/** Known notification types → translation keys; unknown types show raw. */
const TYPE_KEY: Record<string, TKey> = {
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
};

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
  const toast = useToast();
  const [rows, setRows] = useState<Notification[]>([]);
  const [status, setStatus] = useState("all");
  const [type, setType] = useState("");

  // ── Design preview: what the customer actually receives ───────────────────
  const [pvType, setPvType] = useState<string>("won");
  const [pvLang, setPvLang] = useState<string>("lv");
  const [pv, setPv] = useState<{ subject: string; html: string; text: string } | null>(null);
  const [pvText, setPvText] = useState(false);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    void api
      .get<{ subject: string; html: string; text: string }>(`/api/notifications/preview?type=${pvType}&lang=${pvLang}`)
      .then(setPv)
      .catch(() => setPv(null));
  }, [pvType, pvLang]);

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
          <ASelect label={t("ms.type")} value={type} onChange={setType} options={TYPES.map((v) => ({ value: v, label: v === "" ? t("c.all") : typeLabel(v) }))} />
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
              options={PREVIEW_TYPES.map((v) => ({ value: v, label: typeLabel(v) }))}
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
            <div style={{ fontSize: 13, color: AT.inkSoft, fontFamily: AT.body }}>
              <b style={{ color: AT.ink }}>{t("ms.subject")}:</b> {pv.subject}
            </div>
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
