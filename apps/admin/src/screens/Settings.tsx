import { CONDITIONS } from "@auction/domain/conditions";
import { useEffect, useMemo, useState } from "react";
import { api, ApiError, type ConditionPreset, type Market } from "../api.js";
import type { Nav } from "../App.js";
import { useAuth } from "../auth.js";
import { formatDay } from "../format.js";
import { useT, type TKey } from "../i18n.js";
import { TAG_STYLES, TagChip, type TagDef } from "../powerkit.js";
import { AT } from "../theme.js";
import {
  AAvatar, ABadge, ABtn, ACard, ADrawer, AField, AIcon, AInput, ASelect,
  ATable, ATd, ATr, useConfirm, useToast,
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

const TABS: Array<{ id: string; labelKey: TKey }> = [
  { id: "markets", labelKey: "set.tabMarkets" },
  { id: "team", labelKey: "set.tabTeam" },
  { id: "roles", labelKey: "set.tabRoles" },
  { id: "conditions", labelKey: "set.tabConditions" },
  { id: "tags", labelKey: "set.tabTags" },
];

export function SettingsScreen({ nav: _nav }: { nav: Nav }) {
  const { can } = useAuth();
  const { t } = useT();
  const [tab, setTab] = useState("markets");

  // The Conditions editor is reviewer-only; Tags need settings.edit.
  const tabs = TABS.filter((tb) =>
    (tb.id !== "conditions" || can("grading.review")) && (tb.id !== "tags" || can("settings.edit")),
  );

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <h1 style={{ fontFamily: AT.body, fontSize: 20, fontWeight: 700, color: AT.ink }}>{t("set.title")}</h1>
      <div style={{ display: "flex", gap: 2, borderBottom: `1px solid ${AT.rule}` }}>
        {tabs.map((tb) => (
          <button key={tb.id} onClick={() => setTab(tb.id)} style={{
            all: "unset", cursor: "pointer", padding: "9px 14px", fontFamily: AT.body,
            fontSize: 13, fontWeight: 600, color: tab === tb.id ? AT.ink : AT.inkSoft,
            borderBottom: `2px solid ${tab === tb.id ? AT.accent : "transparent"}`, marginBottom: -1,
          }}>{t(tb.labelKey)}</button>
        ))}
      </div>
      {tab === "markets" && (can("markets.view") ? <MarketsTab /> : <NoAccess />)}
      {tab === "team" && (can("team.view") ? <TeamTab /> : <NoAccess />)}
      {tab === "roles" && (can("team.view") ? <RolesTab /> : <NoAccess />)}
      {tab === "conditions" && (can("grading.review") ? <ConditionsTab /> : <NoAccess />)}
      {tab === "tags" && (can("settings.edit") ? <TagsTab /> : <NoAccess />)}
    </div>
  );
}

// ── A3: bidder-tag vocabulary ────────────────────────────────────────────────

const COLOR_KEYS: Record<string, TKey> = {
  gold: "set.col.gold",
  green: "set.col.green",
  blue: "set.col.blue",
  red: "set.col.red",
  orange: "set.col.orange",
  grey: "set.col.grey",
};

function TagsTab() {
  const { t } = useT();
  const toast = useToast();
  const [tags, setTags] = useState<TagDef[]>([]);
  const [name, setName] = useState("");
  const [color, setColor] = useState("grey");

  const colorLabel = (c: string) => {
    const key = COLOR_KEYS[c];
    return key ? t(key) : c;
  };

  const load = () => {
    void api.get<{ tags: TagDef[] }>("/api/customer-tags").then((r) => setTags(r.tags)).catch(() => undefined);
  };
  useEffect(load, []);

  const create = async () => {
    try {
      await api.post("/api/customer-tags", { name: name.trim(), color });
      toast(`${t("set.tagCreatedA")} "${name.trim()}" ${t("set.tagCreatedB")}`, "ok");
      setName("");
      load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : t("set.createFailed"), "danger");
    }
  };

  const patch = async (tag: TagDef, body: Record<string, unknown>, okMsg: string) => {
    try {
      await api.patch(`/api/customer-tags/${tag.id}`, body);
      toast(okMsg, "ok");
      load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : t("set.saveFailed"), "danger");
    }
  };

  const rename = (tag: TagDef) => {
    const next = window.prompt(t("set.renamePrompt"), tag.name);
    if (!next || !next.trim() || next.trim() === tag.name) return;
    void patch(tag, { name: next.trim() }, t("set.tagRenamed"));
  };

  const COLORS = Object.keys(TAG_STYLES);

  return (
    <div style={{ display: "grid", gap: 14, maxWidth: 640 }}>
      <div style={{ fontFamily: AT.body, fontSize: 13, color: AT.inkSoft }}>
        {t("set.tagsIntro")}
      </div>
      <ACard pad={false}>
        <ATable head={[t("set.thTag"), t("set.thColor"), t("c.status"), ""]}>
          {tags.map((tag) => (
            <ATr key={tag.id}>
              <ATd><TagChip tag={tag} /></ATd>
              <ATd>
                <span style={{ display: "inline-flex", gap: 4 }}>
                  {COLORS.map((c) => (
                    <button
                      key={c}
                      title={colorLabel(c)}
                      onClick={() => void patch(tag, { color: c }, t("set.colorSaved"))}
                      style={{
                        all: "unset", cursor: "pointer", width: 18, height: 18, borderRadius: 5,
                        background: TAG_STYLES[c]!.bg, border: `2px solid ${tag.color === c ? TAG_STYLES[c]!.fg : "transparent"}`,
                      }}
                    />
                  ))}
                </span>
              </ATd>
              <ATd>{tag.active ? <ABadge tone="ok">{t("set.active")}</ABadge> : <ABadge tone="neutral">{t("set.retired")}</ABadge>}</ATd>
              <ATd right>
                <span style={{ display: "inline-flex", gap: 6 }}>
                  <ABtn size="sm" kind="ghost" onClick={() => rename(tag)}>{t("set.rename")}</ABtn>
                  <ABtn size="sm" kind="ghost" onClick={() => void patch(tag, { active: !tag.active }, tag.active ? t("set.tagRetired") : t("set.tagReactivated"))}>
                    {tag.active ? t("set.retire") : t("set.reactivate")}
                  </ABtn>
                </span>
              </ATd>
            </ATr>
          ))}
        </ATable>
      </ACard>
      <div style={{ display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}>
        <AField label={t("set.newTag")}><AInput value={name} onChange={setName} placeholder={t("set.tagPlaceholder")} style={{ width: 200 }} /></AField>
        <AField label={t("set.color")}>
          <ASelect value={color} onChange={setColor} options={COLORS.map((c) => ({ value: c, label: colorLabel(c) }))} />
        </AField>
        <ABtn onClick={() => void create()} disabled={name.trim().length === 0}>{t("set.addTag")}</ABtn>
      </div>
    </div>
  );
}

function NoAccess() {
  const { t } = useT();
  return <div style={{ fontFamily: AT.body, fontSize: 13, color: AT.inkSoft, padding: 20 }}>{t("set.noAccess")}</div>;
}

// ── Markets ──────────────────────────────────────────────────────────────────

interface MarketDraft {
  vat: string;
  premium: string;
  antiSnipe: string;
  pickupDays: string;
  restockFee: string;
  omnivaPrice: string;
  dpdPrice: string;
  handlingFee: string;
  active: boolean;
  tiers: Array<{ from: string; inc: string }>;
}

function MarketsTab() {
  const { can } = useAuth();
  const { t } = useT();
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
              dpdPrice: ((m.dpdPmPriceCents ?? 399) / 100).toFixed(2),
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
    if (tiers.some((x) => !Number.isFinite(x.fromCents) || !Number.isFinite(x.incrementCents) || x.incrementCents <= 0)) {
      toast(t("set.incInvalid"), "danger");
      return;
    }
    if (tiers[0]?.fromCents !== 0) {
      toast(t("set.incFirstZero"), "danger");
      return;
    }
    for (let i = 1; i < tiers.length; i++) {
      if (tiers[i]!.fromCents <= tiers[i - 1]!.fromCents) {
        toast(t("set.incAscending"), "danger");
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
        dpdPmPriceCents: Math.round(parseFloat(d.dpdPrice.replace(",", ".")) * 100),
        handlingFeeCents: Math.round(parseFloat(d.handlingFee.replace(",", ".")) * 100),
        active: d.active,
        incrementTable: tiers,
      });
      toast(`${m.code} — ${t("c.saved")}`, "ok");
      load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : t("set.saveFailed"), "danger");
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
                {d.active ? <ABadge tone="ok">{t("set.active")}</ABadge> : <ABadge tone="neutral">{t("set.inactive")}</ABadge>}
              </span>
            }
            actions={editable ? <ABtn size="sm" onClick={() => void save(m)}>{t("c.save")}</ABtn> : undefined}
          >
            <div style={{ display: "grid", gap: 14 }}>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 12 }}>
                <AField label={t("set.vat")} hint={t("set.vatHint")}>
                  <AInput value={d.vat} onChange={(v) => setDraft(m.code, { vat: v })} style={{ opacity: editable ? 1 : 0.6 }} />
                </AField>
                <AField label={t("set.premium")}>
                  <AInput value={d.premium} onChange={(v) => setDraft(m.code, { premium: v })} style={{ opacity: editable ? 1 : 0.6 }} />
                </AField>
                <AField label={t("set.antiSnipe")}>
                  <AInput value={d.antiSnipe} onChange={(v) => setDraft(m.code, { antiSnipe: v })} style={{ opacity: editable ? 1 : 0.6 }} />
                </AField>
                <AField label={t("set.pickupWindow")} hint={t("set.pickupHint")}>
                  <AInput value={d.pickupDays} onChange={(v) => setDraft(m.code, { pickupDays: v })} style={{ opacity: editable ? 1 : 0.6 }} />
                </AField>
                <AField label={t("set.restockFee")} hint={t("set.restockHint")}>
                  <AInput value={d.restockFee} onChange={(v) => setDraft(m.code, { restockFee: v })} style={{ opacity: editable ? 1 : 0.6 }} />
                </AField>
                <AField label={t("set.omniva")} hint={t("set.deliveryHint")}>
                  <AInput value={d.omnivaPrice} onChange={(v) => setDraft(m.code, { omnivaPrice: v })} style={{ opacity: editable ? 1 : 0.6 }} />
                </AField>
                <AField label={t("set.dpd")} hint={t("set.deliveryHint")}>
                  <AInput value={d.dpdPrice} onChange={(v) => setDraft(m.code, { dpdPrice: v })} style={{ opacity: editable ? 1 : 0.6 }} />
                </AField>
                <AField label={t("set.handling")} hint={t("set.handlingHint")}>
                  <AInput value={d.handlingFee} onChange={(v) => setDraft(m.code, { handlingFee: v })} style={{ opacity: editable ? 1 : 0.6 }} />
                </AField>
                <AField label={t("set.languages")}>
                  <div style={{ display: "flex", gap: 5, paddingTop: 8 }}>
                    {m.languages.map((l) => (
                      <span key={l} style={{ fontFamily: AT.mono, fontSize: 11, background: AT.surfaceAlt, borderRadius: 6, padding: "3px 8px" }}>{l}</span>
                    ))}
                  </div>
                </AField>
                {editable && (
                  <AField label={t("c.status")}>
                    <ABtn size="sm" kind={d.active ? "ghost" : "dark"} onClick={() => setDraft(m.code, { active: !d.active })}>
                      {d.active ? t("set.deactivate") : t("set.activate")}
                    </ABtn>
                  </AField>
                )}
              </div>

              <div>
                <div style={{ fontFamily: AT.body, fontSize: 12, fontWeight: 700, color: AT.ink, marginBottom: 7 }}>
                  {t("set.incTable")} <span style={{ color: AT.inkSoft, fontWeight: 400 }}>{t("set.incTableHint")}</span>
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
                      <AIcon name="plus" size={13} /> {t("set.addTier")}
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
  const { t } = useT();
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
      toast(t("c.saved"), "ok");
      load();
    } catch (err) {
      if (err instanceof ApiError && err.body.error === "cannot_demote_last_super_admin") {
        toast(t("set.lastSuperAdmin"), "danger");
      } else {
        toast(err instanceof ApiError ? err.message : t("set.saveFailed"), "danger");
      }
    }
  };

  const invite = async () => {
    try {
      await api.post("/api/team", form);
      toast(t("set.userInvited"), "ok");
      setInviting(false);
      load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : t("set.inviteFailed"), "danger");
    }
  };

  return (
    <div style={{ display: "grid", gap: 14 }}>
      {manage && (
        <div>
          <ABtn onClick={() => { setForm({ name: "", email: "", password: "", roleId: "support" }); setInviting(true); }}>
            <AIcon name="plus" size={15} color="#fff" /> {t("set.inviteUser")}
          </ABtn>
        </div>
      )}
      <ACard pad={false}>
        <ATable head={[t("set.thUser"), t("set.thEmail"), t("set.thRole"), t("c.status"), t("set.thJoined"), ""]}>
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
              <ATd>{u.active ? <ABadge tone="ok">{t("set.active")}</ABadge> : <ABadge tone="neutral">{t("set.disabled")}</ABadge>}</ATd>
              <ATd>{formatDay(u.createdAt)}</ATd>
              <ATd right>
                {manage && (
                  <ABtn size="sm" kind="ghost" onClick={() => void patchUser(u, { active: !u.active })}>
                    {u.active ? t("set.disable") : t("set.enable")}
                  </ABtn>
                )}
              </ATd>
            </ATr>
          ))}
        </ATable>
      </ACard>

      {inviting && (
        <ADrawer
          title={t("set.inviteMember")}
          onClose={() => setInviting(false)}
          footer={
            <>
              <ABtn kind="ghost" onClick={() => setInviting(false)}>{t("c.cancel")}</ABtn>
              <ABtn onClick={() => void invite()} disabled={!form.name || !form.email || form.password.length < 8}>{t("set.invite")}</ABtn>
            </>
          }
        >
          <div style={{ display: "grid", gap: 14 }}>
            <AField label={t("set.name")}><AInput value={form.name} onChange={(v) => setForm({ ...form, name: v })} /></AField>
            <AField label={t("set.email")}><AInput value={form.email} onChange={(v) => setForm({ ...form, email: v })} type="email" /></AField>
            <AField label={t("set.password")} hint={t("set.passwordHint")}>
              <AInput value={form.password} onChange={(v) => setForm({ ...form, password: v })} type="password" />
            </AField>
            <AField label={t("set.role")}>
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
  const { t } = useT();
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
      toast(`${t("set.rolesSaved")}: ${dirty.size}`, "ok");
      load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : t("set.saveFailed"), "danger");
    }
  };

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ fontFamily: AT.body, fontSize: 12.5, color: AT.inkSoft }}>
          {t("set.rolesIntro")} <strong>{t("set.rolesLocked")}</strong>
        </div>
        {editable && dirty.size > 0 && <ABtn onClick={() => void saveAll()}>{t("set.saveChanges")} ({dirty.size})</ABtn>}
      </div>
      <ACard pad={false} style={{ overflowX: "auto" }}>
        <table style={{ borderCollapse: "collapse", width: "100%" }}>
          <thead>
            <tr>
              <th style={thStyle}>{t("set.thPermission")}</th>
              {roles.map((r) => (
                <th key={r.id} style={{ ...thStyle, textAlign: "center" }}>
                  {r.label}
                  {r.id === "super_admin" && <span title={t("set.locked")}> 🔒</span>}
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

const PERM_GROUP_KEYS: Record<string, TKey> = {
  items: "set.pg.items",
  listings: "set.pg.listings",
  auctions: "set.pg.auctions",
  orders: "set.pg.orders",
  pickup: "set.pg.pickup",
  warehouse: "set.pg.warehouse",
  grading: "set.pg.grading",
  customers: "set.pg.customers",
  content: "set.pg.content",
  finance: "set.pg.finance",
  invoices: "set.pg.invoices",
  reports: "set.pg.reports",
  stats: "set.pg.stats",
  settings: "set.pg.settings",
  team: "set.pg.team",
  roles: "set.pg.roles",
  markets: "set.pg.markets",
  audit: "set.pg.audit",
};

function GroupRows({ group, perms, roles, grants, toggle, editable }: {
  group: string;
  perms: string[];
  roles: Role[];
  grants: Record<string, Set<string>>;
  toggle: (roleId: string, permission: string) => void;
  editable: boolean;
}) {
  const { t } = useT();
  const groupKey = PERM_GROUP_KEYS[group];
  return (
    <>
      <tr>
        <td colSpan={roles.length + 1} style={{
          padding: "8px 12px 4px", fontFamily: AT.body, fontSize: 11, fontWeight: 700,
          color: AT.ink, textTransform: "uppercase", letterSpacing: "0.07em", background: "#FAFAF8",
        }}>{groupKey ? t(groupKey) : group}</td>
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

// ── W2: Conditions (preset chips + review scope) ─────────────────────────────

interface PresetDraft {
  textLv: string;
  textRu: string;
  textEn: string;
  position: string;
}

const draftOf = (p: ConditionPreset): PresetDraft => ({
  textLv: p.textLv,
  textRu: p.textRu,
  textEn: p.textEn,
  position: String(p.position),
});

const emptyDraft: PresetDraft = { textLv: "", textRu: "", textEn: "", position: "0" };

const draftValid = (d: PresetDraft) =>
  d.textLv.trim().length > 0 && d.textRu.trim().length > 0 && d.textEn.trim().length > 0 &&
  Number.isInteger(Number(d.position)) && Number(d.position) >= 0;

function ConditionsTab() {
  const { can } = useAuth();
  const { t } = useT();
  const toast = useToast();
  const confirm = useConfirm();
  const [presets, setPresets] = useState<ConditionPreset[]>([]);
  const [drafts, setDrafts] = useState<Record<string, PresetDraft>>({});
  const [adding, setAdding] = useState<Record<string, PresetDraft>>({});
  const [reviewAll, setReviewAll] = useState<boolean | null>(null);
  const canToggleScope = can("settings.edit");

  const load = () => {
    void api.get<{ presets: ConditionPreset[] }>("/api/condition-presets?all=1").then((r) => {
      setPresets(r.presets);
      setDrafts(Object.fromEntries(r.presets.map((p) => [p.id, draftOf(p)])));
    }).catch(() => undefined);
    void api.get<{ reviewAll: boolean }>("/api/settings/grading").then((r) => setReviewAll(r.reviewAll)).catch(() => undefined);
  };
  useEffect(load, []);

  const setDraft = (id: string, patch: Partial<PresetDraft>) =>
    setDrafts((d) => ({ ...d, [id]: { ...d[id]!, ...patch } }));

  const isDirty = (p: ConditionPreset) => {
    const d = drafts[p.id];
    return !!d && (d.textLv !== p.textLv || d.textRu !== p.textRu || d.textEn !== p.textEn || d.position !== String(p.position));
  };

  const save = async (p: ConditionPreset) => {
    const d = drafts[p.id];
    if (!d || !draftValid(d)) return toast(t("set.presetInvalid"), "danger");
    try {
      await api.patch(`/api/condition-presets/${p.id}`, {
        textLv: d.textLv.trim(),
        textRu: d.textRu.trim(),
        textEn: d.textEn.trim(),
        position: Number(d.position),
      });
      toast(t("set.presetSaved"), "ok");
      load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : t("set.saveFailed"), "danger");
    }
  };

  const retire = async (p: ConditionPreset) => {
    const r = await confirm({
      title: `${t("set.retire")}: "${p.textEn}"?`,
      body: t("set.retireBody"),
      confirmLabel: t("set.retire"),
    });
    if (!r.ok) return;
    try {
      await api.delete(`/api/condition-presets/${p.id}`);
      toast(t("set.presetRetired"), "ok");
      load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : t("set.retireFailed"), "danger");
    }
  };

  const reactivate = async (p: ConditionPreset) => {
    try {
      await api.patch(`/api/condition-presets/${p.id}`, { active: true });
      toast(t("set.presetReactivated"), "ok");
      load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : t("set.saveFailed"), "danger");
    }
  };

  const create = async (code: string) => {
    const d = adding[code];
    if (!d || !draftValid(d)) return toast(t("set.presetInvalid"), "danger");
    try {
      await api.post("/api/condition-presets", {
        conditionCode: code,
        textLv: d.textLv.trim(),
        textRu: d.textRu.trim(),
        textEn: d.textEn.trim(),
        position: Number(d.position),
        active: true,
      });
      toast(t("set.presetAdded"), "ok");
      setAdding((a) => {
        const next = { ...a };
        delete next[code];
        return next;
      });
      load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : t("set.createFailed"), "danger");
    }
  };

  const putReviewAll = async (next: boolean) => {
    try {
      const r = await api.put<{ reviewAll: boolean }>("/api/settings/grading", { reviewAll: next });
      setReviewAll(r.reviewAll);
      toast(r.reviewAll ? t("set.reviewAllOn") : t("set.reviewAllOff"), "ok");
    } catch (err) {
      toast(err instanceof ApiError ? err.message : t("set.saveFailed"), "danger");
    }
  };

  const cell = { height: 30, fontSize: 12 } as const;

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <ACard title={t("set.reviewScope")}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <div style={{ fontFamily: AT.body, fontSize: 13, color: AT.ink }}>
            <strong>{t("set.reviewEvery")}</strong>
            <div style={{ fontSize: 12, color: AT.inkSoft, marginTop: 3 }}>
              {t("set.reviewHint")}
            </div>
          </div>
          <div style={{ marginLeft: "auto" }}>
            {reviewAll === null ? (
              <span style={{ fontFamily: AT.body, fontSize: 12, color: AT.inkSoft }}>…</span>
            ) : canToggleScope ? (
              <ABtn size="sm" kind={reviewAll ? "primary" : "ghost"} onClick={() => void putReviewAll(!reviewAll)}>
                {reviewAll ? t("set.reviewOn") : t("set.reviewOff")}
              </ABtn>
            ) : (
              <ABadge tone={reviewAll ? "accent" : "neutral"}>{reviewAll ? t("set.reviewAllBadge") : t("set.damagedOnlyBadge")}</ABadge>
            )}
          </div>
        </div>
      </ACard>

      {CONDITIONS.map((c) => {
        const rows = presets.filter((p) => p.conditionCode === c.code);
        const addDraft = adding[c.code];
        return (
          <ACard
            key={c.code}
            title={
              <span style={{ display: "inline-flex", alignItems: "center", gap: 9 }}>
                {c.label}
                <span style={{ fontFamily: AT.mono, fontSize: 11, background: AT.surfaceAlt, borderRadius: 6, padding: "2px 7px" }}>{c.code}</span>
              </span>
            }
            actions={
              !addDraft ? (
                <ABtn size="sm" kind="soft" onClick={() => setAdding((a) => ({ ...a, [c.code]: { ...emptyDraft, position: String(rows.length) } }))}>
                  <AIcon name="plus" size={13} /> {t("set.addPreset")}
                </ABtn>
              ) : undefined
            }
            pad={false}
          >
            {rows.length === 0 && !addDraft ? (
              <div style={{ padding: 14, fontFamily: AT.body, fontSize: 12.5, color: AT.inkSoft }}>
                {t("set.noPresets")}
              </div>
            ) : (
              <ATable head={["LV", "RU", "EN", t("set.thPos"), t("c.status"), ""]}>
                {rows.map((p) => {
                  const d = drafts[p.id] ?? draftOf(p);
                  return (
                    <ATr key={p.id}>
                      <ATd style={{ whiteSpace: "normal", minWidth: 140, opacity: p.active ? 1 : 0.55 }}>
                        <AInput value={d.textLv} onChange={(v) => setDraft(p.id, { textLv: v })} style={cell} />
                      </ATd>
                      <ATd style={{ whiteSpace: "normal", minWidth: 140, opacity: p.active ? 1 : 0.55 }}>
                        <AInput value={d.textRu} onChange={(v) => setDraft(p.id, { textRu: v })} style={cell} />
                      </ATd>
                      <ATd style={{ whiteSpace: "normal", minWidth: 140, opacity: p.active ? 1 : 0.55 }}>
                        <AInput value={d.textEn} onChange={(v) => setDraft(p.id, { textEn: v })} style={cell} />
                      </ATd>
                      <ATd style={{ width: 56, opacity: p.active ? 1 : 0.55 }}>
                        <AInput value={d.position} onChange={(v) => setDraft(p.id, { position: v })} style={cell} />
                      </ATd>
                      <ATd>{p.active ? <ABadge tone="ok">{t("set.active")}</ABadge> : <ABadge tone="neutral">{t("set.retired")}</ABadge>}</ATd>
                      <ATd right>
                        <span style={{ display: "inline-flex", gap: 6 }}>
                          {isDirty(p) && <ABtn size="sm" onClick={() => void save(p)}>{t("c.save")}</ABtn>}
                          {p.active ? (
                            <ABtn size="sm" kind="ghost" onClick={() => void retire(p)}>{t("set.retire")}</ABtn>
                          ) : (
                            <ABtn size="sm" kind="ghost" onClick={() => void reactivate(p)}>{t("set.reactivate")}</ABtn>
                          )}
                        </span>
                      </ATd>
                    </ATr>
                  );
                })}
                {addDraft && (
                  <ATr>
                    <ATd style={{ whiteSpace: "normal", minWidth: 140 }}>
                      <AInput value={addDraft.textLv} onChange={(v) => setAdding((a) => ({ ...a, [c.code]: { ...a[c.code]!, textLv: v } }))} placeholder="Teksts latviski" style={cell} autoFocus />
                    </ATd>
                    <ATd style={{ whiteSpace: "normal", minWidth: 140 }}>
                      <AInput value={addDraft.textRu} onChange={(v) => setAdding((a) => ({ ...a, [c.code]: { ...a[c.code]!, textRu: v } }))} placeholder="Текст по-русски" style={cell} />
                    </ATd>
                    <ATd style={{ whiteSpace: "normal", minWidth: 140 }}>
                      <AInput value={addDraft.textEn} onChange={(v) => setAdding((a) => ({ ...a, [c.code]: { ...a[c.code]!, textEn: v } }))} placeholder="Text in English" style={cell} />
                    </ATd>
                    <ATd style={{ width: 56 }}>
                      <AInput value={addDraft.position} onChange={(v) => setAdding((a) => ({ ...a, [c.code]: { ...a[c.code]!, position: v } }))} style={cell} />
                    </ATd>
                    <ATd><ABadge tone="accent">{t("set.new")}</ABadge></ATd>
                    <ATd right>
                      <span style={{ display: "inline-flex", gap: 6 }}>
                        <ABtn size="sm" onClick={() => void create(c.code)} disabled={!draftValid(addDraft)}>{t("c.create")}</ABtn>
                        <ABtn size="sm" kind="ghost" onClick={() => setAdding((a) => {
                          const next = { ...a };
                          delete next[c.code];
                          return next;
                        })}>{t("c.cancel")}</ABtn>
                      </span>
                    </ATd>
                  </ATr>
                )}
              </ATable>
            )}
          </ACard>
        );
      })}
    </div>
  );
}
