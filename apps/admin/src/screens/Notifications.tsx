import { useEffect, useMemo, useState } from "react";
import { api } from "../api.js";
import type { Nav } from "../App.js";
import { formatDate } from "../format.js";
import { useT, type TKey } from "../i18n.js";
import { AT } from "../theme.js";
import { ABadge, ABtn, ACard, AEmpty, AIcon, APills, ASelect, ATable, ATd, ATr } from "../ui.js";

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

/** Known notification types → translation keys; unknown types show raw. */
const TYPE_KEY: Record<string, TKey> = {
  outbid: "ms.nt.outbid",
  won: "ms.nt.won",
  payment_reminder: "ms.nt.payment_reminder",
  order_paid: "ms.nt.order_paid",
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
  const [rows, setRows] = useState<Notification[]>([]);
  const [status, setStatus] = useState("all");
  const [type, setType] = useState("");

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
