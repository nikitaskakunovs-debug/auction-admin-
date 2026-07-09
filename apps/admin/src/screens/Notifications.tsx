import { useEffect, useMemo, useState } from "react";
import { api } from "../api.js";
import type { Nav } from "../App.js";
import { formatDate } from "../format.js";
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

const STATUS_TONE: Record<string, "ok" | "warn" | "danger" | "neutral"> = {
  sent: "ok",
  pending: "warn",
  failed: "danger",
};

export function NotificationsScreen({ nav: _nav }: { nav: Nav }) {
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

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <h1 style={{ fontFamily: AT.body, fontSize: 20, fontWeight: 700, color: AT.ink }}>Notifications</h1>
        <ABtn kind="ghost" size="sm" onClick={load}><AIcon name="refund" size={13} /> Refresh</ABtn>
      </div>

      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <APills
          options={[
            { id: "all", label: "All", count: counts.all },
            { id: "sent", label: "Sent", count: counts.sent },
            { id: "pending", label: "Pending", count: counts.pending },
            { id: "failed", label: "Failed", count: counts.failed },
          ]}
          value={status}
          onChange={setStatus}
        />
        <div style={{ marginLeft: "auto" }}>
          <ASelect label="Type" value={type} onChange={setType} options={TYPES.map((t) => ({ value: t, label: t === "" ? "All" : t.replace(/_/g, " ") }))} />
        </div>
      </div>

      <ACard pad={false}>
        {visible.length === 0 ? (
          <AEmpty text="No notifications match." />
        ) : (
          <ATable head={["When", "Type", "Recipient", "Lang", "Subject", "Status", "Sent"]}>
            {visible.map((n) => (
              <ATr key={n.id}>
                <ATd mono>{formatDate(n.createdAt)}</ATd>
                <ATd><ABadge tone="accent">{n.type.replace(/_/g, " ")}</ABadge></ATd>
                <ATd>{n.toEmail}</ATd>
                <ATd>{n.lang}</ATd>
                <ATd><span style={{ maxWidth: 320, display: "inline-block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", verticalAlign: "bottom" }}>{n.subject}</span></ATd>
                <ATd>
                  <span title={n.lastError ?? ""}>
                    <ABadge tone={STATUS_TONE[n.status] ?? "neutral"}>
                      {n.status}{n.attempts > 1 ? ` ·${n.attempts}` : ""}
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
