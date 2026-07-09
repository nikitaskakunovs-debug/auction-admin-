import { useEffect, useMemo, useState } from "react";
import { api, ApiError, type Item, type Market } from "../api.js";
import type { Nav } from "../App.js";
import { useAuth } from "../auth.js";
import { formatDate } from "../format.js";
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
  { id: "attention", label: "Attention", statuses: ["unsold", "unpaid_cancelled"] },
  { id: "closed", label: "Closed", statuses: ["closed"] },
];

const NEXT_STEP: Record<string, { to: string; label: string }> = {
  paid: { to: "picking", label: "Start picking" },
  picking: { to: "packed", label: "Mark packed" },
  packed: { to: "shipped", label: "Mark shipped" },
  shipped: { to: "delivered", label: "Mark delivered" },
  delivered: { to: "closed", label: "Close" },
};

const CONDITIONS = ["new", "excellent", "very good", "good", "fair", "restored", "working"];

interface FormState {
  sku: string;
  title: string;
  description: string;
  condition: string;
  location: string;
  weight: string;
  marketCode: string;
}

const emptyForm: FormState = { sku: "", title: "", description: "", condition: "good", location: "", weight: "", marketCode: "LV" };

export function InventoryScreen({ nav: _nav }: { nav: Nav }) {
  const { can } = useAuth();
  const toast = useToast();
  const confirm = useConfirm();
  const [items, setItems] = useState<Item[]>([]);
  const [group, setGroup] = useState("all");
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Item | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [markets, setMarkets] = useState<Market[]>([]);

  const load = () => {
    void api.get<{ items: Item[] }>("/api/items").then((r) => setItems(r.items)).catch(() => undefined);
  };
  useEffect(() => {
    load();
    void api.get<{ markets: Market[] }>("/api/markets").then((r) => setMarkets(r.markets)).catch(() => undefined);
  }, []);

  const set = (patch: Partial<FormState>) => setForm((f) => ({ ...f, ...patch }));

  const submit = async () => {
    const body = {
      sku: form.sku,
      title: form.title,
      description: form.description,
      condition: form.condition,
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
      attention: by(["unsold", "unpaid_cancelled"]),
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
          <ABtn onClick={() => { setForm(emptyForm); setEditing(null); setCreating(true); }}>
            <AIcon name="plus" size={15} color="#fff" /> New item
          </ABtn>
        )}
      </div>

      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        <AStat label="Items" value={kpis.total} />
        <AStat label="In fulfilment" value={kpis.fulfilment} />
        <AStat label="Awaiting payment" value={kpis.awaiting} tone={kpis.awaiting > 0 ? "warn" : undefined} />
        <AStat label="Needs attention" value={kpis.attention} tone={kpis.attention > 0 ? "warn" : undefined} sub="unsold / unpaid" />
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
                setForm({
                  sku: i.sku, title: i.title, description: i.description, condition: i.condition,
                  location: i.location, weight: i.weightGrams == null ? "" : String(i.weightGrams), marketCode: i.marketCode,
                });
              }}>
                <ATd mono>{i.sku}</ATd>
                <ATd><span style={{ fontWeight: 600 }}>{i.title}</span></ATd>
                <ATd>{i.condition}</ATd>
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
              {editing && editing.status === "draft" && can("items.delete") && (
                <ABtn kind="danger" onClick={() => void remove(editing)}>Delete</ABtn>
              )}
              <ABtn kind="ghost" onClick={() => { setCreating(false); setEditing(null); }}>Close</ABtn>
              {(editing ? can("items.edit") : can("items.create")) && (
                <ABtn onClick={() => void submit()} disabled={!form.sku || !form.title}>{editing ? "Save" : "Create"}</ABtn>
              )}
            </>
          }
        >
          <div style={{ display: "grid", gap: 14 }}>
            {editing && (
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <ABadge tone={ITEM_STATUS_TONE[editing.status]?.tone ?? "neutral"}>{ITEM_STATUS_TONE[editing.status]?.label ?? editing.status}</ABadge>
                {NEXT_STEP[editing.status] && can("items.transition") && (
                  <ABtn size="sm" kind="dark" onClick={() => void transition(editing, NEXT_STEP[editing.status]!.to)}>
                    <AIcon name="pkg" size={13} color="#fff" /> {NEXT_STEP[editing.status]!.label}
                  </ABtn>
                )}
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
                <ASelect value={form.condition} onChange={(v) => set({ condition: v })} options={CONDITIONS.map((c) => ({ value: c, label: c }))} />
              </AField>
              <AField label="Market">
                <ASelect value={form.marketCode} onChange={(v) => set({ marketCode: v })} options={markets.map((m) => ({ value: m.code, label: m.code }))} />
              </AField>
              <AField label="Location"><AInput value={form.location} onChange={(v) => set({ location: v })} placeholder="A-01-03" /></AField>
              <AField label="Weight (grams)"><AInput value={form.weight} onChange={(v) => set({ weight: v })} placeholder="1200" /></AField>
            </div>
          </div>
        </ADrawer>
      )}
    </div>
  );
}
