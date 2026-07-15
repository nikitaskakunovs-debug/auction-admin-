import { useEffect, useMemo, useState } from "react";
import { api, ApiError, type Market } from "../api.js";
import type { Nav } from "../App.js";
import { useAuth } from "../auth.js";
import { formatDay } from "../format.js";
import { AT } from "../theme.js";
import {
  AAvatar, ABadge, ABtn, ACard, ADrawer, AField, AIcon, AInput, ASelect,
  ATable, ATd, ATr, useToast,
} from "../ui.js";

interface TeamUser {
  id: string;
  email: string;
  name: string;
  roleId: string;
  active: boolean;
  createdAt: string;
}

interface Role {
  id: string;
  label: string;
  description: string;
  permissions: string[];
}

const TABS = [
  { id: "markets", label: "Markets" },
  { id: "team", label: "Team" },
  { id: "roles", label: "Roles" },
];

export function SettingsScreen({ nav: _nav }: { nav: Nav }) {
  const { can } = useAuth();
  const [tab, setTab] = useState("markets");

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <h1 style={{ fontFamily: AT.body, fontSize: 20, fontWeight: 700, color: AT.ink }}>Settings</h1>
      <div style={{ display: "flex", gap: 2, borderBottom: `1px solid ${AT.rule}` }}>
        {TABS.map((t) => (
          <button key={t.id} onClick={() => setTab(t.id)} style={{
            all: "unset", cursor: "pointer", padding: "9px 14px", fontFamily: AT.body,
            fontSize: 13, fontWeight: 600, color: tab === t.id ? AT.ink : AT.inkSoft,
            borderBottom: `2px solid ${tab === t.id ? AT.accent : "transparent"}`, marginBottom: -1,
          }}>{t.label}</button>
        ))}
      </div>
      {tab === "markets" && (can("markets.view") ? <MarketsTab /> : <NoAccess />)}
      {tab === "team" && (can("team.view") ? <TeamTab /> : <NoAccess />)}
      {tab === "roles" && (can("team.view") ? <RolesTab /> : <NoAccess />)}
    </div>
  );
}

function NoAccess() {
  return <div style={{ fontFamily: AT.body, fontSize: 13, color: AT.inkSoft, padding: 20 }}>Your role does not have access to this section.</div>;
}

// ── Markets ──────────────────────────────────────────────────────────────────

interface MarketDraft {
  vat: string;
  premium: string;
  antiSnipe: string;
  pickupDays: string;
  restockFee: string;
  omnivaPrice: string;
  handlingFee: string;
  active: boolean;
  tiers: Array<{ from: string; inc: string }>;
}

function MarketsTab() {
  const { can } = useAuth();
  const toast = useToast();
  const [markets, setMarkets] = useState<Market[]>([]);
  const [drafts, setDrafts] = useState<Record<string, MarketDraft>>({});
  const editable = can("markets.edit");

  const load = () => {
    void api.get<{ markets: Market[] }>("/api/markets").then((r) => {
      setMarkets(r.markets);
      setDrafts(
        Object.fromEntries(
          r.markets.map((m) => [
            m.code,
            {
              vat: (m.vatRateBp / 100).toFixed(1),
              premium: (m.buyerPremiumBp / 100).toFixed(1),
              antiSnipe: String(m.antiSnipeSec),
              pickupDays: String(m.pickupDeadlineDays),
              restockFee: (m.restockFeeBp / 100).toFixed(1),
              omnivaPrice: ((m.omnivaPmPriceCents ?? 399) / 100).toFixed(2),
              handlingFee: ((m.handlingFeeCents ?? 0) / 100).toFixed(2),
              active: m.active,
              tiers: m.incrementTable.map((t) => ({ from: (t.fromCents / 100).toFixed(2), inc: (t.incrementCents / 100).toFixed(2) })),
            },
          ]),
        ),
      );
    }).catch(() => undefined);
  };
  useEffect(load, []);

  const setDraft = (code: string, patch: Partial<MarketDraft>) =>
    setDrafts((d) => ({ ...d, [code]: { ...d[code]!, ...patch } }));

  const save = async (m: Market) => {
    const d = drafts[m.code];
    if (!d) return;
    const tiers = d.tiers.map((t) => ({
      fromCents: Math.round(parseFloat(t.from.replace(",", ".")) * 100),
      incrementCents: Math.round(parseFloat(t.inc.replace(",", ".")) * 100),
    }));
    if (tiers.some((t) => !Number.isFinite(t.fromCents) || !Number.isFinite(t.incrementCents) || t.incrementCents <= 0)) {
      toast("Increment table has invalid numbers", "danger");
      return;
    }
    if (tiers[0]?.fromCents !== 0) {
      toast("First increment tier must start at €0.00", "danger");
      return;
    }
    for (let i = 1; i < tiers.length; i++) {
      if (tiers[i]!.fromCents <= tiers[i - 1]!.fromCents) {
        toast("Increment tiers must be strictly ascending", "danger");
        return;
      }
    }
    try {
      await api.patch(`/api/markets/${m.code}`, {
        vatRateBp: Math.round(parseFloat(d.vat.replace(",", ".")) * 100),
        buyerPremiumBp: Math.round(parseFloat(d.premium.replace(",", ".")) * 100),
        antiSnipeSec: Number(d.antiSnipe),
        pickupDeadlineDays: Number(d.pickupDays),
        restockFeeBp: Math.round(parseFloat(d.restockFee.replace(",", ".")) * 100),
        omnivaPmPriceCents: Math.round(parseFloat(d.omnivaPrice.replace(",", ".")) * 100),
        handlingFeeCents: Math.round(parseFloat(d.handlingFee.replace(",", ".")) * 100),
        active: d.active,
        incrementTable: tiers,
      });
      toast(`${m.code} saved`, "ok");
      load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Save failed", "danger");
    }
  };

  return (
    <div style={{ display: "grid", gap: 14 }}>
      {markets.map((m) => {
        const d = drafts[m.code];
        if (!d) return null;
        return (
          <ACard
            key={m.code}
            title={
              <span style={{ display: "inline-flex", alignItems: "center", gap: 9 }}>
                {m.name}
                <span style={{ fontFamily: AT.mono, fontSize: 11, background: AT.surfaceAlt, borderRadius: 6, padding: "2px 7px" }}>{m.code}</span>
                {d.active ? <ABadge tone="ok">active</ABadge> : <ABadge tone="neutral">inactive</ABadge>}
              </span>
            }
            actions={editable ? <ABtn size="sm" onClick={() => void save(m)}>Save</ABtn> : undefined}
          >
            <div style={{ display: "grid", gap: 14 }}>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 12 }}>
                <AField label="VAT %" hint="Confirm with your accountant.">
                  <AInput value={d.vat} onChange={(v) => setDraft(m.code, { vat: v })} style={{ opacity: editable ? 1 : 0.6 }} />
                </AField>
                <AField label="Buyer premium %">
                  <AInput value={d.premium} onChange={(v) => setDraft(m.code, { premium: v })} style={{ opacity: editable ? 1 : 0.6 }} />
                </AField>
                <AField label="Anti-snipe (sec)">
                  <AInput value={d.antiSnipe} onChange={(v) => setDraft(m.code, { antiSnipe: v })} style={{ opacity: editable ? 1 : 0.6 }} />
                </AField>
                <AField label="Pickup window (days)" hint="After payment; then auto-cancel.">
                  <AInput value={d.pickupDays} onChange={(v) => setDraft(m.code, { pickupDays: v })} style={{ opacity: editable ? 1 : 0.6 }} />
                </AField>
                <AField label="Restock fee %" hint="Retained on no-show.">
                  <AInput value={d.restockFee} onChange={(v) => setDraft(m.code, { restockFee: v })} style={{ opacity: editable ? 1 : 0.6 }} />
                </AField>
                <AField label="Omniva parcel machine €" hint="Delivery price charged to the buyer.">
                  <AInput value={d.omnivaPrice} onChange={(v) => setDraft(m.code, { omnivaPrice: v })} style={{ opacity: editable ? 1 : 0.6 }} />
                </AField>
                <AField label="Handling fee €" hint="Packing fee on shipped orders. Never part of the 10% premium.">
                  <AInput value={d.handlingFee} onChange={(v) => setDraft(m.code, { handlingFee: v })} style={{ opacity: editable ? 1 : 0.6 }} />
                </AField>
                <AField label="Languages">
                  <div style={{ display: "flex", gap: 5, paddingTop: 8 }}>
                    {m.languages.map((l) => (
                      <span key={l} style={{ fontFamily: AT.mono, fontSize: 11, background: AT.surfaceAlt, borderRadius: 6, padding: "3px 8px" }}>{l}</span>
                    ))}
                  </div>
                </AField>
                {editable && (
                  <AField label="Status">
                    <ABtn size="sm" kind={d.active ? "ghost" : "dark"} onClick={() => setDraft(m.code, { active: !d.active })}>
                      {d.active ? "Deactivate" : "Activate"}
                    </ABtn>
                  </AField>
                )}
              </div>

              <div>
                <div style={{ fontFamily: AT.body, fontSize: 12, fontWeight: 700, color: AT.ink, marginBottom: 7 }}>
                  Bid increment table <span style={{ color: AT.inkSoft, fontWeight: 400 }}>(from price → increment)</span>
                </div>
                <div style={{ display: "grid", gap: 6, maxWidth: 420 }}>
                  {d.tiers.map((t, i) => (
                    <div key={i} style={{ display: "flex", gap: 8, alignItems: "center" }}>
                      <span style={{ fontFamily: AT.mono, fontSize: 11, color: AT.inkSoft, width: 30 }}>€</span>
                      <AInput value={t.from} onChange={(v) => {
                        const tiers = d.tiers.map((x, j) => (j === i ? { ...x, from: v } : x));
                        setDraft(m.code, { tiers });
                      }} style={{ height: 30, fontSize: 12 }} />
                      <span style={{ fontFamily: AT.body, fontSize: 12, color: AT.inkSoft }}>→ +€</span>
                      <AInput value={t.inc} onChange={(v) => {
                        const tiers = d.tiers.map((x, j) => (j === i ? { ...x, inc: v } : x));
                        setDraft(m.code, { tiers });
                      }} style={{ height: 30, fontSize: 12 }} />
                      {editable && d.tiers.length > 1 && (
                        <button onClick={() => setDraft(m.code, { tiers: d.tiers.filter((_, j) => j !== i) })}
                          style={{ all: "unset", cursor: "pointer", color: AT.inkSoft, padding: 3 }}>
                          <AIcon name="close" size={13} />
                        </button>
                      )}
                    </div>
                  ))}
                  {editable && (
                    <ABtn size="sm" kind="soft" onClick={() => {
                      const last = d.tiers[d.tiers.length - 1];
                      setDraft(m.code, { tiers: [...d.tiers, { from: last ? String(parseFloat(last.from) * 2 || 0) : "0", inc: last?.inc ?? "1.00" }] });
                    }}>
                      <AIcon name="plus" size={13} /> Add tier
                    </ABtn>
                  )}
                </div>
              </div>
            </div>
          </ACard>
        );
      })}
    </div>
  );
}

// ── Team ─────────────────────────────────────────────────────────────────────

function TeamTab() {
  const { can } = useAuth();
  const toast = useToast();
  const [users, setUsers] = useState<TeamUser[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [inviting, setInviting] = useState(false);
  const [form, setForm] = useState({ name: "", email: "", password: "", roleId: "support" });
  const manage = can("team.manage");

  const load = () => {
    void api.get<{ users: TeamUser[] }>("/api/team").then((r) => setUsers(r.users)).catch(() => undefined);
    void api.get<{ roles: Role[] }>("/api/roles").then((r) => setRoles(r.roles)).catch(() => undefined);
  };
  useEffect(load, []);

  const patchUser = async (u: TeamUser, patch: Record<string, unknown>) => {
    try {
      await api.patch(`/api/team/${u.id}`, patch);
      toast("Saved", "ok");
      load();
    } catch (err) {
      if (err instanceof ApiError && err.body.error === "cannot_demote_last_super_admin") {
        toast("You cannot demote or deactivate the last Super Admin", "danger");
      } else {
        toast(err instanceof ApiError ? err.message : "Save failed", "danger");
      }
    }
  };

  const invite = async () => {
    try {
      await api.post("/api/team", form);
      toast("User invited", "ok");
      setInviting(false);
      load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Invite failed", "danger");
    }
  };

  return (
    <div style={{ display: "grid", gap: 14 }}>
      {manage && (
        <div>
          <ABtn onClick={() => { setForm({ name: "", email: "", password: "", roleId: "support" }); setInviting(true); }}>
            <AIcon name="plus" size={15} color="#fff" /> Invite user
          </ABtn>
        </div>
      )}
      <ACard pad={false}>
        <ATable head={["User", "Email", "Role", "Status", "Joined", ""]}>
          {users.map((u) => (
            <ATr key={u.id}>
              <ATd>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                  <AAvatar name={u.name} size={24} />
                  <span style={{ fontWeight: 600 }}>{u.name}</span>
                </span>
              </ATd>
              <ATd>{u.email}</ATd>
              <ATd>
                {manage ? (
                  <ASelect
                    value={u.roleId}
                    onChange={(v) => void patchUser(u, { roleId: v })}
                    options={roles.map((r) => ({ value: r.id, label: r.label }))}
                  />
                ) : (
                  roles.find((r) => r.id === u.roleId)?.label ?? u.roleId
                )}
              </ATd>
              <ATd>{u.active ? <ABadge tone="ok">active</ABadge> : <ABadge tone="neutral">disabled</ABadge>}</ATd>
              <ATd>{formatDay(u.createdAt)}</ATd>
              <ATd right>
                {manage && (
                  <ABtn size="sm" kind="ghost" onClick={() => void patchUser(u, { active: !u.active })}>
                    {u.active ? "Disable" : "Enable"}
                  </ABtn>
                )}
              </ATd>
            </ATr>
          ))}
        </ATable>
      </ACard>

      {inviting && (
        <ADrawer
          title="Invite team member"
          onClose={() => setInviting(false)}
          footer={
            <>
              <ABtn kind="ghost" onClick={() => setInviting(false)}>Cancel</ABtn>
              <ABtn onClick={() => void invite()} disabled={!form.name || !form.email || form.password.length < 8}>Invite</ABtn>
            </>
          }
        >
          <div style={{ display: "grid", gap: 14 }}>
            <AField label="Name"><AInput value={form.name} onChange={(v) => setForm({ ...form, name: v })} /></AField>
            <AField label="Email"><AInput value={form.email} onChange={(v) => setForm({ ...form, email: v })} type="email" /></AField>
            <AField label="Password" hint="Min 8 characters; they should change it after first sign-in.">
              <AInput value={form.password} onChange={(v) => setForm({ ...form, password: v })} type="password" />
            </AField>
            <AField label="Role">
              <ASelect value={form.roleId} onChange={(v) => setForm({ ...form, roleId: v })} options={roles.map((r) => ({ value: r.id, label: r.label }))} />
            </AField>
          </div>
        </ADrawer>
      )}
    </div>
  );
}

// ── Roles matrix ─────────────────────────────────────────────────────────────

function RolesTab() {
  const { can } = useAuth();
  const toast = useToast();
  const [roles, setRoles] = useState<Role[]>([]);
  const [allPermissions, setAllPermissions] = useState<string[]>([]);
  const [grants, setGrants] = useState<Record<string, Set<string>>>({});
  const [dirty, setDirty] = useState<Set<string>>(new Set());
  const editable = can("roles.manage");

  const load = () => {
    void api.get<{ roles: Role[]; allPermissions: string[] }>("/api/roles").then((r) => {
      setRoles(r.roles);
      setAllPermissions(r.allPermissions);
      setGrants(Object.fromEntries(r.roles.map((role) => [role.id, new Set(role.permissions)])));
      setDirty(new Set());
    }).catch(() => undefined);
  };
  useEffect(load, []);

  const groups = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const p of allPermissions) {
      const prefix = p.split(".")[0]!;
      (map.get(prefix) ?? map.set(prefix, []).get(prefix)!).push(p);
    }
    return [...map.entries()];
  }, [allPermissions]);

  const toggle = (roleId: string, permission: string) => {
    if (!editable || roleId === "super_admin") return;
    setGrants((g) => {
      const set = new Set(g[roleId]);
      if (set.has(permission)) set.delete(permission);
      else set.add(permission);
      return { ...g, [roleId]: set };
    });
    setDirty((d) => new Set(d).add(roleId));
  };

  const saveAll = async () => {
    try {
      for (const roleId of dirty) {
        await api.put(`/api/roles/${roleId}/permissions`, { permissions: [...(grants[roleId] ?? [])] });
      }
      toast(`Saved ${dirty.size} role${dirty.size === 1 ? "" : "s"}`, "ok");
      load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Save failed", "danger");
    }
  };

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ fontFamily: AT.body, fontSize: 12.5, color: AT.inkSoft }}>
          Action-level permissions per role. <strong>Super Admin is locked</strong> to the full set.
        </div>
        {editable && dirty.size > 0 && <ABtn onClick={() => void saveAll()}>Save changes ({dirty.size})</ABtn>}
      </div>
      <ACard pad={false} style={{ overflowX: "auto" }}>
        <table style={{ borderCollapse: "collapse", width: "100%" }}>
          <thead>
            <tr>
              <th style={thStyle}>Permission</th>
              {roles.map((r) => (
                <th key={r.id} style={{ ...thStyle, textAlign: "center" }}>
                  {r.label}
                  {r.id === "super_admin" && <span title="locked"> 🔒</span>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {groups.map(([group, perms]) => (
              <GroupRows key={group} group={group} perms={perms} roles={roles} grants={grants} toggle={toggle} editable={editable} />
            ))}
          </tbody>
        </table>
      </ACard>
    </div>
  );
}

const thStyle: React.CSSProperties = {
  textAlign: "left", padding: "9px 12px", fontFamily: AT.body, fontSize: 11, fontWeight: 700,
  color: AT.inkSoft, textTransform: "uppercase", letterSpacing: "0.06em",
  borderBottom: `1px solid ${AT.rule}`, background: AT.surfaceAlt, whiteSpace: "nowrap",
  position: "sticky", top: 0,
};

function GroupRows({ group, perms, roles, grants, toggle, editable }: {
  group: string;
  perms: string[];
  roles: Role[];
  grants: Record<string, Set<string>>;
  toggle: (roleId: string, permission: string) => void;
  editable: boolean;
}) {
  return (
    <>
      <tr>
        <td colSpan={roles.length + 1} style={{
          padding: "8px 12px 4px", fontFamily: AT.body, fontSize: 11, fontWeight: 700,
          color: AT.ink, textTransform: "uppercase", letterSpacing: "0.07em", background: "#FAFAF8",
        }}>{group}</td>
      </tr>
      {perms.map((p) => (
        <tr key={p}>
          <td style={{ padding: "6px 12px", fontFamily: AT.mono, fontSize: 11.5, color: AT.ink, borderBottom: `1px solid ${AT.ruleSoft}` }}>{p}</td>
          {roles.map((r) => {
            const checked = grants[r.id]?.has(p) ?? false;
            const locked = r.id === "super_admin" || !editable;
            return (
              <td key={r.id} style={{ textAlign: "center", borderBottom: `1px solid ${AT.ruleSoft}` }}>
                <input
                  type="checkbox"
                  checked={r.id === "super_admin" ? true : checked}
                  disabled={locked}
                  onChange={() => toggle(r.id, p)}
                  style={{ accentColor: AT.accent, cursor: locked ? "not-allowed" : "pointer" }}
                />
              </td>
            );
          })}
        </tr>
      ))}
    </>
  );
}
