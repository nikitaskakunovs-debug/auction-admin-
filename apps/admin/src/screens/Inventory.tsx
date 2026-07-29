// Subpath import keeps the node-only parts of @auction/domain (TOTP) out of the browser bundle.
import { CATEGORIES } from "@auction/domain/categories";
import { CONDITIONS, conditionByCode, conditionRequiresNotes } from "@auction/domain/conditions";
import { useEffect, useMemo, useState } from "react";
import { api, ApiError, type Item, type Market } from "../api.js";
import type { Nav } from "../App.js";
import { useAuth } from "../auth.js";
import { formatDate } from "../format.js";
import { useT } from "../i18n.js";
import { ActivityTimeline, CommentsThread, useCommentsLive } from "../itemPanels.js";
import { openLabelWindow as openLabel } from "../labels.js";
import { AT, ITEM_STATUS_TONE } from "../theme.js";
import {
  ABadge, ABtn, ACard, ADrawer, AEmpty, AField, AIcon, AInput, APills, ASelect,
  AStat, ATable, ATd, ATr, useConfirm, useToast,
} from "../ui.js";

const GROUPS = [
  { id: "all", label: "All", statuses: null as string[] | null },
  { id: "intake", label: "Intake", statuses: ["draft", "listed"] },
  { id: "selling", label: "Selling", statuses: ["live", "won", "awaiting_payment"] },
  { id: "fulfilment", label: "Fulfilment", statuses: ["paid", "picking", "packed", "shipped", "delivered"] },
  { id: "attention", label: "Attention", statuses: ["unsold", "unpaid_cancelled", "no_pickup_cancelled"] },
  { id: "restock", label: "Returned", statuses: ["unpaid_cancelled", "no_pickup_cancelled"] },
  { id: "closed", label: "Closed", statuses: ["closed"] },
];

const NEXT_STEP: Record<string, { to: string; label: string }> = {
  unpaid_cancelled: { to: "draft", label: "Return to stock" },
  no_pickup_cancelled: { to: "draft", label: "Return to stock" },
  paid: { to: "picking", label: "Start picking" },
  picking: { to: "packed", label: "Mark packed" },
  packed: { to: "shipped", label: "Mark shipped" },
  shipped: { to: "delivered", label: "Mark delivered" },
  delivered: { to: "closed", label: "Close" },
};

/** Items graded before the 16-grade taxonomy keep their free-text value. */
const conditionLabel = (code: string) => conditionByCode(code)?.label ?? code;

interface FormState {
  sku: string;
  title: string;
  description: string;
  condition: string;
  conditionNotes: string;
  category: string;
  location: string;
  weight: string;
  marketCode: string;
}

const emptyForm: FormState = { sku: "", title: "", description: "", condition: "brand_new", conditionNotes: "", category: "other", location: "", weight: "", marketCode: "LV" };

interface Bin { id: string; label: string; zone: string; active: boolean }

/** Drawer tabs — details plus the W2 Saruna (chat) and Vēsture (history). */
type DrawerTab = "details" | "chat" | "history";

export function InventoryScreen({ nav }: { nav: Nav }) {
  const { can } = useAuth();
  const { t } = useT();
  const toast = useToast();
  const confirm = useConfirm();
  const [items, setItems] = useState<Item[]>([]);
  const [group, setGroup] = useState("all");
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Item | null>(null);
  const [drawerTab, setDrawerTab] = useState<DrawerTab>("details");
  const [form, setForm] = useState<FormState>(emptyForm);
  const [markets, setMarkets] = useState<Market[]>([]);
  const [bins, setBins] = useState<Bin[]>([]);
  // W2: per-item unread comment badges, live over WS.
  const { unread, bump, refreshUnread } = useCommentsLive();

  const load = () => {
    void api.get<{ items: Item[] }>("/api/items").then((r) => setItems(r.items)).catch(() => undefined);
  };
  useEffect(() => {
    load();
    void api.get<{ markets: Market[] }>("/api/markets").then((r) => setMarkets(r.markets)).catch(() => undefined);
    void api.get<{ locations: Bin[] }>("/api/warehouse/locations").then((r) => setBins(r.locations.filter((b) => b.active))).catch(() => undefined);
  }, []);

  // Deep link (#/inventory/<itemId>) from ⌘K search and the W3 bin drawer —
  // opens the item's detail drawer directly.
  const param = nav.route.param;
  useEffect(() => {
    if (!param) return;
    void api.get<{ item: Item }>(`/api/items/${param}`).then((r) => {
      const i = r.item;
      setEditing(i);
      setDrawerTab("details");
      setForm({
        sku: i.sku, title: i.title, description: i.description, condition: i.condition,
        conditionNotes: i.conditionNotes ?? "", category: i.category ?? "other",
        location: i.location, weight: i.weightGrams == null ? "" : String(i.weightGrams), marketCode: i.marketCode,
      });
    }).catch(() => undefined);
  }, [param]);

  const putaway = async (locationId: string | null) => {
    if (!editing) return;
    try {
      await api.post(`/api/items/${editing.id}/putaway`, { locationId, reason: "" });
      toast(locationId ? "Bin assigned" : "Bin cleared", "ok");
      setEditing({ ...editing, locationId });
      load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Putaway failed", "danger");
    }
  };

  const set = (patch: Partial<FormState>) => setForm((f) => ({ ...f, ...patch }));

  // ── Photos (upload → server re-encodes to web+thumb webp) ────────────────
  const thumbOf = (u: string) => (u.includes("-web.webp") ? u.replace("-web.webp", "-thumb.webp") : u);

  const uploadPhotos = async (files: FileList | null) => {
    if (!editing || !files || files.length === 0) return;
    const fd = new FormData();
    for (const f of Array.from(files)) fd.append("photos", f);
    try {
      const r = await api.postForm<{ item: Item }>(`/api/items/${editing.id}/photos`, fd);
      setEditing(r.item);
      toast(files.length > 1 ? `${files.length} photos uploaded` : "Photo uploaded", "ok");
      load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Upload failed", "danger");
    }
  };

  const removePhoto = async (url: string) => {
    if (!editing) return;
    try {
      const r = await api.delete<{ item: Item }>(`/api/items/${editing.id}/photos`, { url });
      setEditing(r.item);
      load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Delete failed", "danger");
    }
  };

  const setCover = async (url: string) => {
    if (!editing) return;
    try {
      const r = await api.post<{ item: Item }>(`/api/items/${editing.id}/photos/cover`, { url });
      setEditing(r.item);
      load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Failed", "danger");
    }
  };

  const submit = async () => {
    const body = {
      sku: form.sku,
      title: form.title,
      description: form.description,
      condition: form.condition,
      conditionNotes: form.conditionNotes,
      category: form.category,
      location: form.location,
      weightGrams: form.weight ? Number(form.weight) : null,
      marketCode: form.marketCode,
    };
    try {
      if (editing) {
        await api.patch(`/api/items/${editing.id}`, body);
        toast("Item saved", "ok");
      } else {
        await api.post("/api/items", body);
        toast("Item created", "ok");
      }
      setCreating(false);
      setEditing(null);
      load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Save failed", "danger");
    }
  };

  const transition = async (item: Item, to: string) => {
    try {
      await api.post(`/api/items/${item.id}/transition`, { to });
      toast(`${item.sku} → ${to.replace(/_/g, " ")}`, "ok");
      setEditing(null);
      load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Transition failed", "danger");
    }
  };

  const remove = async (item: Item) => {
    const r = await confirm({
      title: `Delete ${item.sku}?`,
      body: "Only draft items can be deleted. This cannot be undone.",
      danger: true,
      typeToConfirm: item.sku,
      confirmLabel: "Delete",
    });
    if (!r.ok) return;
    try {
      await api.delete(`/api/items/${item.id}`);
      toast("Item deleted", "ok");
      setEditing(null);
      load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Delete failed", "danger");
    }
  };

  const counts = useMemo(() => {
    const map: Record<string, number> = { all: items.length };
    for (const g of GROUPS.slice(1)) map[g.id] = items.filter((i) => g.statuses!.includes(i.status)).length;
    return map;
  }, [items]);

  const kpis = useMemo(() => {
    const by = (statuses: string[]) => items.filter((i) => statuses.includes(i.status)).length;
    return {
      total: items.length,
      fulfilment: by(["paid", "picking", "packed", "shipped"]),
      awaiting: by(["awaiting_payment"]),
      attention: by(["unsold", "unpaid_cancelled", "no_pickup_cancelled"]),
    };
  }, [items]);

  const activeGroup = GROUPS.find((g) => g.id === group) ?? GROUPS[0]!;
  const visible = items
    .filter((i) => (activeGroup.statuses ? activeGroup.statuses.includes(i.status) : true))
    .filter((i) => {
      const q = query.trim().toLowerCase();
      return !q || i.sku.toLowerCase().includes(q) || i.title.toLowerCase().includes(q);
    });

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <h1 style={{ fontFamily: AT.body, fontSize: 20, fontWeight: 700, color: AT.ink }}>Inventory</h1>
        {can("items.create") && (
          <ABtn onClick={() => { setForm(emptyForm); setEditing(null); setDrawerTab("details"); setCreating(true); }}>
            <AIcon name="plus" size={15} color="#fff" /> New item
          </ABtn>
        )}
      </div>

      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        <AStat label="Items" value={kpis.total} />
        <AStat label="In fulfilment" value={kpis.fulfilment} />
        <AStat label="Awaiting payment" value={kpis.awaiting} tone={kpis.awaiting > 0 ? "warn" : undefined} />
        <AStat label="Needs attention" value={kpis.attention} tone={kpis.attention > 0 ? "warn" : undefined} sub="unsold / cancelled" />
      </div>

      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <APills options={GROUPS.map((g) => ({ id: g.id, label: g.label, count: counts[g.id] ?? 0 }))} value={group} onChange={setGroup} />
        <div style={{ marginLeft: "auto", width: 220 }}>
          <AInput value={query} onChange={setQuery} placeholder="Search sku or title…" />
        </div>
      </div>

      <ACard pad={false}>
        {visible.length === 0 ? (
          <AEmpty text="No items match." />
        ) : (
          <ATable head={["SKU", "Title", "Condition", "Location", "Weight", "Status", "Updated"]}>
            {visible.map((i) => (
              <ATr key={i.id} onClick={() => {
                setEditing(i);
                setDrawerTab("details");
                setForm({
                  sku: i.sku, title: i.title, description: i.description, condition: i.condition,
                  conditionNotes: i.conditionNotes ?? "", category: i.category ?? "other",
                  location: i.location, weight: i.weightGrams == null ? "" : String(i.weightGrams), marketCode: i.marketCode,
                });
              }}>
                <ATd mono>
                  {i.sku}
                  {(unread.get(i.id) ?? 0) > 0 && (
                    <span style={{
                      marginLeft: 7, display: "inline-grid", placeItems: "center", verticalAlign: "middle",
                      minWidth: 16, height: 16, padding: "0 4px", borderRadius: 999, background: AT.accent,
                      color: "#fff", fontFamily: AT.body, fontSize: 10, fontWeight: 800,
                    }}>{unread.get(i.id)}</span>
                  )}
                </ATd>
                <ATd><span style={{ fontWeight: 600 }}>{i.title}</span></ATd>
                <ATd>{conditionLabel(i.condition)}</ATd>
                <ATd mono>{i.location || "—"}</ATd>
                <ATd right>{i.weightGrams == null ? "—" : `${i.weightGrams} g`}</ATd>
                <ATd><ABadge tone={ITEM_STATUS_TONE[i.status]?.tone ?? "neutral"}>{ITEM_STATUS_TONE[i.status]?.label ?? i.status}</ABadge></ATd>
                <ATd>{formatDate(i.updatedAt)}</ATd>
              </ATr>
            ))}
          </ATable>
        )}
      </ACard>

      {(creating || editing) && (
        <ADrawer
          title={editing ? <span>Edit item <span style={{ fontFamily: AT.mono, fontSize: 12, color: AT.inkSoft }}>{editing.sku}</span></span> : "New item"}
          onClose={() => { setCreating(false); setEditing(null); }}
          footer={
            <>
              {drawerTab === "details" && editing && editing.status === "draft" && can("items.delete") && (
                <ABtn kind="danger" onClick={() => void remove(editing)}>Delete</ABtn>
              )}
              <ABtn kind="ghost" onClick={() => { setCreating(false); setEditing(null); }}>Close</ABtn>
              {drawerTab === "details" && (editing ? can("items.edit") : can("items.create")) && (
                <ABtn onClick={() => void submit()} disabled={!form.sku || !form.title || (conditionRequiresNotes(form.condition) && form.conditionNotes.trim().length < 3)}>{editing ? "Save" : "Create"}</ABtn>
              )}
            </>
          }
        >
          <div style={{ display: "grid", gap: 14 }}>
            {editing && (
              <div style={{ display: "flex", gap: 2, borderBottom: `1px solid ${AT.rule}` }}>
                {([
                  { id: "details" as DrawerTab, label: "Details", badge: 0 },
                  { id: "chat" as DrawerTab, label: t("wh.tab.chat"), badge: unread.get(editing.id) ?? 0 },
                  { id: "history" as DrawerTab, label: t("wh.tab.history"), badge: 0 },
                ]).map((tb) => (
                  <button key={tb.id} onClick={() => setDrawerTab(tb.id)} style={{
                    all: "unset", cursor: "pointer", padding: "8px 13px", fontFamily: AT.body,
                    fontSize: 12.5, fontWeight: 600, color: drawerTab === tb.id ? AT.ink : AT.inkSoft,
                    borderBottom: `2px solid ${drawerTab === tb.id ? AT.accent : "transparent"}`, marginBottom: -1,
                    display: "inline-flex", alignItems: "center", gap: 6,
                  }}>
                    {tb.label}
                    {tb.badge > 0 && (
                      <span style={{
                        display: "inline-grid", placeItems: "center", minWidth: 16, height: 16, padding: "0 4px",
                        borderRadius: 999, background: AT.accent, color: "#fff", fontSize: 10, fontWeight: 800,
                      }}>{tb.badge}</span>
                    )}
                  </button>
                ))}
              </div>
            )}
            {editing && drawerTab === "chat" && (
              <CommentsThread itemId={editing.id} bump={bump} onRead={refreshUnread} />
            )}
            {editing && drawerTab === "history" && <ActivityTimeline itemId={editing.id} />}
            {(!editing || drawerTab === "details") && (<>
            {editing && (
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <ABadge tone={ITEM_STATUS_TONE[editing.status]?.tone ?? "neutral"}>{ITEM_STATUS_TONE[editing.status]?.label ?? editing.status}</ABadge>
                {NEXT_STEP[editing.status] && can("items.transition") && (
                  <ABtn size="sm" kind="dark" onClick={() => void transition(editing, NEXT_STEP[editing.status]!.to)}>
                    <AIcon name="pkg" size={13} color="#fff" /> {NEXT_STEP[editing.status]!.label}
                  </ABtn>
                )}
                <ABtn size="sm" kind="ghost" onClick={() => void openLabel(`/api/items/${editing.id}/label`, (m) => toast(m, "danger"))}>
                  Print label
                </ABtn>
              </div>
            )}
            <AField label="SKU"><AInput value={form.sku} onChange={(v) => set({ sku: v })} placeholder="LOT-0042" /></AField>
            <AField label="Title"><AInput value={form.title} onChange={(v) => set({ title: v })} /></AField>
            <AField label="Description">
              <textarea value={form.description} onChange={(e) => set({ description: e.target.value })} rows={4} style={{
                width: "100%", borderRadius: AT.radiusSm, border: `1px solid ${AT.rule}`, fontFamily: AT.body,
                fontSize: 13, color: AT.ink, padding: 10, resize: "vertical",
              }} />
            </AField>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <AField label="Condition">
                <ASelect
                  value={form.condition}
                  onChange={(v) => set({ condition: v })}
                  options={[
                    ...(conditionByCode(form.condition) ? [] : [{ value: form.condition, label: `${form.condition} (legacy)` }]),
                    ...CONDITIONS.map((c) => ({ value: c.code, label: c.requiresNotes ? `${c.label} — see notes` : c.label })),
                  ]}
                />
              </AField>
              <AField label="Market">
                <ASelect value={form.marketCode} onChange={(v) => set({ marketCode: v })} options={markets.map((m) => ({ value: m.code, label: m.code }))} />
              </AField>
              <AField label="Category">
                <ASelect value={form.category} onChange={(v) => set({ category: v })} options={CATEGORIES.map((c) => ({ value: c.code, label: c.label }))} />
              </AField>
              <AField label="Location (note)"><AInput value={form.location} onChange={(v) => set({ location: v })} placeholder="A-01-03" /></AField>
              <AField label="Weight (grams)"><AInput value={form.weight} onChange={(v) => set({ weight: v })} placeholder="1200" /></AField>
            </div>
            {conditionByCode(form.condition) && (
              <div style={{ fontSize: 12, color: AT.inkSoft, marginTop: -8 }}>{conditionByCode(form.condition)!.description}</div>
            )}
            <AField
              label={conditionRequiresNotes(form.condition) ? "Condition notes (required)" : "Condition notes"}
              hint={conditionRequiresNotes(form.condition)
                ? "This is a SEE NOTES grade — describe the specific issue (shown to bidders)."
                : "Optional details shown to bidders."}
            >
              <textarea value={form.conditionNotes} onChange={(e) => set({ conditionNotes: e.target.value })} rows={2} style={{
                width: "100%", borderRadius: AT.radiusSm, fontFamily: AT.body,
                border: `1px solid ${conditionRequiresNotes(form.condition) && form.conditionNotes.trim().length < 3 ? "#C24" : AT.rule}`,
                fontSize: 13, color: AT.ink, padding: 10, resize: "vertical",
              }} />
            </AField>
            {editing && (
              <AField label={`Photos (${editing.photos.length})`} hint="The first photo is the storefront cover. Uploads are resized server-side.">
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {editing.photos.map((p, idx) => (
                    <div key={p} style={{ position: "relative", width: 84 }}>
                      <a href={p} target="_blank" rel="noreferrer">
                        <img src={thumbOf(p)} alt="" style={{ width: 84, height: 84, objectFit: "cover", borderRadius: 8, border: `1px solid ${AT.rule}`, display: "block" }} />
                      </a>
                      {can("items.edit") && (
                        <button
                          onClick={() => void removePhoto(p)}
                          title="Remove photo"
                          style={{ position: "absolute", top: -6, right: -6, width: 20, height: 20, borderRadius: 99, border: "none", background: "#B0282C", color: "#fff", fontSize: 12, cursor: "pointer", lineHeight: 1 }}
                        >×</button>
                      )}
                      {idx === 0 ? (
                        <div style={{ fontSize: 9.5, fontWeight: 700, textAlign: "center", color: AT.inkSoft, marginTop: 3, textTransform: "uppercase", letterSpacing: "0.05em" }}>cover</div>
                      ) : can("items.edit") ? (
                        <button
                          onClick={() => void setCover(p)}
                          style={{ all: "unset", cursor: "pointer", display: "block", width: "100%", textAlign: "center", fontSize: 9.5, fontWeight: 700, color: "#2D4BFF", marginTop: 3, textTransform: "uppercase", letterSpacing: "0.05em" }}
                        >set cover</button>
                      ) : null}
                    </div>
                  ))}
                  {can("items.edit") && (
                    <label style={{ width: 84, height: 84, borderRadius: 8, border: `1.5px dashed ${AT.rule}`, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", color: AT.inkSoft, fontSize: 22 }}>
                      +
                      <input
                        type="file"
                        accept="image/jpeg,image/png,image/webp"
                        multiple
                        style={{ display: "none" }}
                        onChange={(e) => { void uploadPhotos(e.target.files); e.target.value = ""; }}
                      />
                    </label>
                  )}
                </div>
              </AField>
            )}
            {editing && can("warehouse.manage") && (
              <AField label="Warehouse bin" hint="Changing the bin writes a putaway/move into the stock ledger.">
                <ASelect
                  value={editing.locationId ?? ""}
                  onChange={(v) => void putaway(v || null)}
                  options={[{ value: "", label: "— no bin —" }, ...bins.map((b) => ({ value: b.id, label: b.label }))]}
                />
              </AField>
            )}
            </>)}
          </div>
        </ADrawer>
      )}
    </div>
  );
}
