import { CATEGORIES } from "@auction/domain/categories";
import { CONDITIONS, conditionByCode, conditionRequiresNotes } from "@auction/domain/conditions";
import { useEffect, useRef, useState } from "react";
import { api, ApiError, type Item, type Market } from "../api.js";
import type { Nav } from "../App.js";
import { useAuth } from "../auth.js";
import { formatDate } from "../format.js";
import { openLabelWindow as openLabel } from "../labels.js";
import { AT } from "../theme.js";
import {
  ABadge, ABtn, ACard, ADrawer, AEmpty, AField, AIcon, AInput, ASelect,
  AStat, ATable, ATd, ATr, useConfirm, useToast,
} from "../ui.js";

interface Consignment {
  id: string;
  ref: string;
  supplier: string;
  notes: string;
  marketCode: string;
  status: string;
  expectedCount: number;
  receivedCount?: number;
  createdAt: string;
  closedAt: string | null;
}

const emptyReceive = { title: "", condition: "brand_new", conditionNotes: "", category: "other", weight: "" };

export function ReceivingScreen({ nav: _nav }: { nav: Nav }) {
  const { can } = useAuth();
  const toast = useToast();
  const confirm = useConfirm();
  const [list, setList] = useState<Consignment[]>([]);
  const [markets, setMarkets] = useState<Market[]>([]);
  const [creating, setCreating] = useState(false);
  const [createForm, setCreateForm] = useState({ supplier: "", marketCode: "LV", expected: "", notes: "" });
  const [active, setActive] = useState<Consignment | null>(null);
  const [received, setReceived] = useState<Item[]>([]);
  const [form, setForm] = useState(emptyReceive);
  const [busy, setBusy] = useState(false);
  const titleRef = useRef<HTMLInputElement | null>(null);

  const load = () => {
    void api.get<{ consignments: Consignment[] }>("/api/consignments").then((r) => setList(r.consignments)).catch(() => undefined);
  };
  useEffect(() => {
    load();
    void api.get<{ markets: Market[] }>("/api/markets").then((r) => setMarkets(r.markets)).catch(() => undefined);
  }, []);

  const openDetail = (id: string) => {
    void api
      .get<{ consignment: Consignment; items: Item[] }>(`/api/consignments/${id}`)
      .then((r) => {
        setActive(r.consignment);
        setReceived(r.items);
        setForm(emptyReceive);
      })
      .catch(() => undefined);
  };

  const create = async () => {
    try {
      const r = await api.post<{ consignment: Consignment }>("/api/consignments", {
        supplier: createForm.supplier,
        marketCode: createForm.marketCode,
        expectedCount: createForm.expected ? Number(createForm.expected) : 0,
        notes: createForm.notes,
      });
      toast(`${r.consignment.ref} created`, "ok");
      setCreating(false);
      load();
      openDetail(r.consignment.id);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Create failed", "danger");
    }
  };

  const needsNotes = conditionRequiresNotes(form.condition);
  const canReceive = form.title.trim().length >= 2 && (!needsNotes || form.conditionNotes.trim().length >= 3);

  const receive = async (printAfter: boolean) => {
    if (!active || !canReceive || busy) return;
    setBusy(true);
    try {
      const r = await api.post<{ item: Item }>(`/api/consignments/${active.id}/receive`, {
        title: form.title.trim(),
        condition: form.condition,
        conditionNotes: form.conditionNotes,
        category: form.category,
        weightGrams: form.weight ? Number(form.weight) : null,
      });
      setReceived((prev) => [r.item, ...prev]);
      // Keep the grade for runs of identical stock; clear the per-unit fields.
      setForm((f) => ({ ...f, title: "", conditionNotes: "", weight: "" }));
      toast(`${r.item.sku} received`, "ok");
      titleRef.current?.focus();
      if (printAfter) void openLabel(`/api/items/${r.item.id}/label`, (m) => toast(m, "danger"));
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Receive failed", "danger");
    } finally {
      setBusy(false);
    }
  };

  const closeConsignment = async () => {
    if (!active) return;
    const expected = active.expectedCount;
    const r = await confirm({
      title: `Close ${active.ref}?`,
      body:
        expected > 0 && received.length !== expected
          ? `Paperwork expected ${expected} units but ${received.length} were received. Closing stops further receiving.`
          : "Closing stops further receiving against this delivery.",
      confirmLabel: "Close consignment",
    });
    if (!r.ok) return;
    try {
      await api.post(`/api/consignments/${active.id}/close`);
      toast(`${active.ref} closed`, "ok");
      setActive({ ...active, status: "closed" });
      load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Close failed", "danger");
    }
  };

  // ── Detail: intake station ──────────────────────────────────────────────────
  if (active) {
    const open = active.status === "open";
    return (
      <div style={{ display: "grid", gap: 14 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <ABtn kind="ghost" size="sm" onClick={() => { setActive(null); load(); }}>← All deliveries</ABtn>
          <h1 style={{ fontFamily: AT.body, fontSize: 20, fontWeight: 700, color: AT.ink }}>
            {active.ref} <span style={{ color: AT.inkSoft, fontWeight: 500 }}>· {active.supplier}</span>
          </h1>
          <ABadge tone={open ? "ok" : "neutral"}>{active.status}</ABadge>
          <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
            {received.length > 0 && (
              <ABtn kind="ghost" size="sm" onClick={() => void openLabel(`/api/consignments/${active.id}/labels`, (m) => toast(m, "danger"))}>
                Print all labels ({received.length})
              </ABtn>
            )}
            {open && can("warehouse.manage") && (
              <ABtn kind="dark" size="sm" onClick={() => void closeConsignment()}>Close consignment</ABtn>
            )}
          </div>
        </div>

        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <AStat label="Received" value={received.length} />
          <AStat label="Expected" value={active.expectedCount || "—"} />
          <AStat label="Market" value={active.marketCode} />
        </div>

        {open && can("warehouse.manage") && (
          <ACard title="Receive next unit">
            <div style={{ display: "grid", gap: 12 }}>
              <AField label="Title">
                <AInput
                  inputRef={titleRef}
                  value={form.title}
                  onChange={(v) => setForm({ ...form, title: v })}
                  placeholder="Bosch cordless drill GSR 18V, boxed"
                />
              </AField>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 160px", gap: 12 }}>
                <AField label="Condition">
                  <ASelect
                    value={form.condition}
                    onChange={(v) => setForm({ ...form, condition: v })}
                    options={CONDITIONS.map((c) => ({ value: c.code, label: c.requiresNotes ? `${c.label} — see notes` : c.label }))}
                  />
                </AField>
                <AField label="Weight (g)">
                  <AInput value={form.weight} onChange={(v) => setForm({ ...form, weight: v })} placeholder="1200" />
                </AField>
              </div>
              <AField label="Category">
                <ASelect value={form.category} onChange={(v) => setForm({ ...form, category: v })} options={CATEGORIES.map((c) => ({ value: c.code, label: c.label }))} />
              </AField>
              {conditionByCode(form.condition) && (
                <div style={{ fontSize: 12, color: AT.inkSoft, marginTop: -6 }}>{conditionByCode(form.condition)!.description}</div>
              )}
              <AField
                label={needsNotes ? "Condition notes (required)" : "Condition notes"}
                hint={needsNotes ? "SEE NOTES grade — describe the specific issue (shown to bidders)." : "Optional."}
              >
                <textarea
                  value={form.conditionNotes}
                  onChange={(e) => setForm({ ...form, conditionNotes: e.target.value })}
                  rows={2}
                  style={{
                    width: "100%", borderRadius: AT.radiusSm, fontFamily: AT.body, fontSize: 13, color: AT.ink, padding: 10, resize: "vertical",
                    border: `1px solid ${needsNotes && form.conditionNotes.trim().length < 3 ? "#C24" : AT.rule}`,
                  }}
                />
              </AField>
              <div style={{ display: "flex", gap: 8 }}>
                <ABtn onClick={() => void receive(true)} disabled={!canReceive || busy}>
                  <AIcon name="plus" size={14} color="#fff" /> Receive + label
                </ABtn>
                <ABtn kind="ghost" onClick={() => void receive(false)} disabled={!canReceive || busy}>Receive only</ABtn>
              </div>
            </div>
          </ACard>
        )}

        <ACard title={`Received items (${received.length})`} pad={false}>
          {received.length === 0 ? (
            <AEmpty text="Nothing received yet — the first unit gets the next free SKU automatically." />
          ) : (
            <ATable head={["SKU", "Title", "Condition", "Weight", ""]}>
              {received.map((i) => (
                <ATr key={i.id}>
                  <ATd mono>{i.sku}</ATd>
                  <ATd><span style={{ fontWeight: 600 }}>{i.title}</span></ATd>
                  <ATd>{conditionByCode(i.condition)?.label ?? i.condition}</ATd>
                  <ATd right>{i.weightGrams == null ? "—" : `${i.weightGrams} g`}</ATd>
                  <ATd right>
                    <ABtn size="sm" kind="ghost" onClick={() => void openLabel(`/api/items/${i.id}/label`, (m) => toast(m, "danger"))}>Label</ABtn>
                  </ATd>
                </ATr>
              ))}
            </ATable>
          )}
        </ACard>
      </div>
    );
  }

  // ── Master list ─────────────────────────────────────────────────────────────
  return (
    <div style={{ display: "grid", gap: 14 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
        <h1 style={{ fontFamily: AT.body, fontSize: 20, fontWeight: 700, color: AT.ink }}>Receiving</h1>
        <div style={{ display: "flex", gap: 8 }}>
          {can("warehouse.manage") && (
            <ABtn kind="ghost" onClick={() => void openLabel("/api/warehouse/locations/labels", (m) => toast(m, "danger"))}>Print bin labels</ABtn>
          )}
          {can("warehouse.manage") && (
            <ABtn onClick={() => { setCreateForm({ supplier: "", marketCode: "LV", expected: "", notes: "" }); setCreating(true); }}>
              <AIcon name="plus" size={15} color="#fff" /> New delivery
            </ABtn>
          )}
        </div>
      </div>

      <ACard pad={false}>
        {list.length === 0 ? (
          <AEmpty text="No deliveries yet. Create one when a truck arrives, then receive units against it." />
        ) : (
          <ATable head={["Ref", "Supplier", "Market", "Received", "Status", "Created"]}>
            {list.map((c) => (
              <ATr key={c.id} onClick={() => openDetail(c.id)}>
                <ATd mono>{c.ref}</ATd>
                <ATd><span style={{ fontWeight: 600 }}>{c.supplier}</span></ATd>
                <ATd>{c.marketCode}</ATd>
                <ATd right>{c.receivedCount ?? 0}{c.expectedCount ? ` / ${c.expectedCount}` : ""}</ATd>
                <ATd><ABadge tone={c.status === "open" ? "ok" : "neutral"}>{c.status}</ABadge></ATd>
                <ATd>{formatDate(c.createdAt)}</ATd>
              </ATr>
            ))}
          </ATable>
        )}
      </ACard>

      {creating && (
        <ADrawer
          title="New delivery"
          onClose={() => setCreating(false)}
          footer={
            <>
              <ABtn kind="ghost" onClick={() => setCreating(false)}>Cancel</ABtn>
              <ABtn onClick={() => void create()} disabled={createForm.supplier.trim().length < 2}>Create</ABtn>
            </>
          }
        >
          <div style={{ display: "grid", gap: 14 }}>
            <AField label="Supplier" hint="Who the goods came from — retailer, liquidator, consignor.">
              <AInput value={createForm.supplier} onChange={(v) => setCreateForm({ ...createForm, supplier: v })} />
            </AField>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <AField label="Market">
                <ASelect value={createForm.marketCode} onChange={(v) => setCreateForm({ ...createForm, marketCode: v })} options={markets.map((m) => ({ value: m.code, label: m.code }))} />
              </AField>
              <AField label="Expected units" hint="From the paperwork; 0 = unknown.">
                <AInput value={createForm.expected} onChange={(v) => setCreateForm({ ...createForm, expected: v })} placeholder="0" />
              </AField>
            </div>
            <AField label="Notes">
              <textarea value={createForm.notes} onChange={(e) => setCreateForm({ ...createForm, notes: e.target.value })} rows={3} style={{
                width: "100%", borderRadius: AT.radiusSm, border: `1px solid ${AT.rule}`, fontFamily: AT.body, fontSize: 13, color: AT.ink, padding: 10, resize: "vertical",
              }} />
            </AField>
          </div>
        </ADrawer>
      )}
    </div>
  );
}
