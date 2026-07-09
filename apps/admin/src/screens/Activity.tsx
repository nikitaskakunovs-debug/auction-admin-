import { useEffect, useState } from "react";
import { api, type AuditEntry } from "../api.js";
import type { Nav } from "../App.js";
import { formatDate } from "../format.js";
import { AT } from "../theme.js";
import { AAvatar, ABadge, ABtn, ACard, AEmpty, AIcon, AInput, ASelect, ATable, ATd, ATr } from "../ui.js";

const TYPES = ["", "auction", "listing", "item", "order", "customer", "settings", "team", "finance"];

export function ActivityScreen({ nav: _nav }: { nav: Nav }) {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [type, setType] = useState("");
  const [query, setQuery] = useState("");

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
        <ABtn kind="ghost" size="sm" onClick={() => load(type)}>
          <AIcon name="refund" size={13} /> Refresh
        </ABtn>
      </div>

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
    </div>
  );
}
