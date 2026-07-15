import { conditionByCode } from "@auction/domain/conditions";
import { useEffect, useMemo, useState } from "react";
import { api, ApiError, type Auction, type Item, type Listing, type Market } from "../api.js";
import type { Nav } from "../App.js";
import { useAuth } from "../auth.js";
import { formatDay, formatDate, formatEur } from "../format.js";
import { AT, AUCTION_STATUS_TONE, ITEM_STATUS_TONE } from "../theme.js";
import {
  ABadge, ABtn, ACard, ADrawer, AEmpty, AField, AIcon, AInput, APills, ASelect,
  ATable, ATd, ATr, useToast,
} from "../ui.js";

const PILLS = [
  { id: "all", label: "All" },
  { id: "draft", label: "Draft" },
  { id: "published", label: "Published" },
  { id: "archived", label: "Archived" },
];

const eurToCents = (v: string): number | null => {
  const n = parseFloat(v.replace(",", "."));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : null;
};
const centsToEur = (c: number | null): string => (c == null ? "" : (c / 100).toFixed(2));

interface FormState {
  itemId: string;
  type: "auction" | "fixed";
  title: string;
  description: string;
  marketCode: string;
  startPrice: string;
  price: string;
  reserve: string;
  antiSnipe: string;
}

const emptyForm: FormState = {
  itemId: "", type: "auction", title: "", description: "", marketCode: "LV",
  startPrice: "", price: "", reserve: "", antiSnipe: "",
};

const thumbOf = (u: string) => (u.includes("-web.webp") ? u.replace("-web.webp", "-thumb.webp") : u);

/** datetime-local value for a Date in the browser's timezone. */
const toLocalInput = (d: Date): string => {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};

export function ListingsScreen({ nav }: { nav: Nav }) {
  const { can } = useAuth();
  const toast = useToast();
  const [listings, setListings] = useState<Listing[]>([]);
  const [filter, setFilter] = useState("all");
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Listing | null>(null);
  const [history, setHistory] = useState<Auction[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [markets, setMarkets] = useState<Market[]>([]);
  const [form, setForm] = useState<FormState>(emptyForm);
  const canPrice = can("listings.set_pricing");

  // ── Ready-to-list queue (drafts that have been photographed + graded) ──────
  const [queue, setQueue] = useState<Item[] | null>(null); // null = drawer closed
  const [queueItem, setQueueItem] = useState<Item | null>(null);
  const [readyCount, setReadyCount] = useState(0);
  const [noPhotoCount, setNoPhotoCount] = useState(0);
  // Schedule is sticky between queue items — a batch usually shares one slot.
  const [sched, setSched] = useState(() => ({
    startsAt: toLocalInput(new Date(Date.now() + 3_600_000)),
    endsAt: toLocalInput(new Date(Date.now() + 3 * 24 * 3_600_000)),
  }));

  const loadReady = async (): Promise<Item[]> => {
    try {
      const r = await api.get<{ items: Item[] }>("/api/items?status=draft");
      const ready = r.items.filter((i) => i.photos.length > 0);
      setReadyCount(ready.length);
      setNoPhotoCount(r.items.length - ready.length);
      return ready;
    } catch {
      return [];
    }
  };

  const load = () => {
    void api.get<{ listings: Listing[] }>("/api/listings").then((r) => setListings(r.listings)).catch(() => undefined);
  };
  useEffect(() => {
    load();
    void loadReady();
    void api.get<{ markets: Market[] }>("/api/markets").then((r) => setMarkets(r.markets)).catch(() => undefined);
  }, []);

  const set = (patch: Partial<FormState>) => setForm((f) => ({ ...f, ...patch }));

  const openCreate = async () => {
    try {
      const [draft, listed] = await Promise.all([
        api.get<{ items: Item[] }>("/api/items?status=draft"),
        api.get<{ items: Item[] }>("/api/items?status=listed"),
      ]);
      const eligible = [...draft.items, ...listed.items];
      setItems(eligible);
      setForm({ ...emptyForm, itemId: eligible[0]?.id ?? "", title: eligible[0]?.title ?? "" });
      setCreating(true);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Failed to load items", "danger");
    }
  };

  const submitCreate = async () => {
    const body: Record<string, unknown> = {
      itemId: form.itemId,
      type: form.type,
      title: form.title,
      description: form.description,
      marketCode: form.marketCode,
    };
    if (form.type === "auction") {
      body.startPriceCents = eurToCents(form.startPrice);
      if (canPrice && form.reserve) body.reserveCents = eurToCents(form.reserve);
    } else {
      body.priceCents = eurToCents(form.price);
    }
    if (form.antiSnipe) body.antiSnipeSec = Number(form.antiSnipe);
    try {
      await api.post("/api/listings", body);
      toast("Listing created", "ok");
      setCreating(false);
      load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Create failed", "danger");
    }
  };

  const openQueue = async () => {
    setQueueItem(null);
    setQueue(await loadReady());
  };

  const pickQueueItem = (it: Item) => {
    setQueueItem(it);
    setForm({
      ...emptyForm,
      itemId: it.id,
      type: form.type, // sticky — batches are usually all-auction or all-fixed
      title: it.title,
      description: it.description,
      marketCode: it.marketCode,
    });
  };

  const quickValid =
    queueItem !== null &&
    form.title.trim().length > 0 &&
    (form.type === "auction"
      ? eurToCents(form.startPrice) !== null && sched.startsAt !== "" && sched.endsAt !== "" && new Date(sched.endsAt) > new Date(sched.startsAt)
      : eurToCents(form.price) !== null);

  /** Create → publish → (auction) schedule, one click. A mid-chain failure
   * leaves an ordinary draft listing that can be finished by hand. */
  const submitQuick = async () => {
    if (!queueItem || !quickValid) return;
    const body: Record<string, unknown> = {
      itemId: queueItem.id,
      type: form.type,
      title: form.title,
      description: form.description,
      marketCode: queueItem.marketCode,
    };
    if (form.type === "auction") {
      body.startPriceCents = eurToCents(form.startPrice);
      if (canPrice && form.reserve) body.reserveCents = eurToCents(form.reserve);
    } else {
      body.priceCents = eurToCents(form.price);
    }
    if (form.antiSnipe) body.antiSnipeSec = Number(form.antiSnipe);
    try {
      const created = await api.post<{ listing: { id: string } }>("/api/listings", body);
      await api.post(`/api/listings/${created.listing.id}/publish`);
      if (form.type === "auction") {
        await api.post("/api/auctions", {
          listingId: created.listing.id,
          startsAt: new Date(sched.startsAt).toISOString(),
          endsAt: new Date(sched.endsAt).toISOString(),
        });
      }
      toast(`${queueItem.sku} published${form.type === "auction" ? " & scheduled" : ""}`, "ok");
      setQueue((q) => q?.filter((i) => i.id !== queueItem.id) ?? q);
      setQueueItem(null);
      load();
      void loadReady();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Listing failed — check Listings for a leftover draft", "danger");
    }
  };

  const openEdit = (l: Listing) => {
    setEditing(l);
    setHistory([]);
    setForm({
      itemId: l.itemId,
      type: l.type,
      title: l.title,
      description: l.description,
      marketCode: l.marketCode,
      startPrice: centsToEur(l.startPriceCents),
      price: centsToEur(l.priceCents),
      reserve: centsToEur(l.reserveCents),
      antiSnipe: l.antiSnipeSec == null ? "" : String(l.antiSnipeSec),
    });
    void api
      .get<{ auctions: Auction[] }>(`/api/listings/${l.id}`)
      .then((r) => setHistory(r.auctions))
      .catch(() => undefined);
  };

  const submitEdit = async () => {
    if (!editing) return;
    const body: Record<string, unknown> = {
      title: form.title,
      description: form.description,
    };
    if (canPrice) {
      if (form.type === "auction") {
        body.startPriceCents = eurToCents(form.startPrice);
        body.reserveCents = form.reserve ? eurToCents(form.reserve) : null;
      } else {
        body.priceCents = eurToCents(form.price);
      }
    }
    if (form.antiSnipe !== "") body.antiSnipeSec = Number(form.antiSnipe);
    try {
      await api.patch(`/api/listings/${editing.id}`, body);
      toast("Listing saved", "ok");
      setEditing(null);
      load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Save failed", "danger");
    }
  };

  const publish = async () => {
    if (!editing) return;
    try {
      await api.post(`/api/listings/${editing.id}/publish`);
      toast("Published — item is now listed", "ok");
      setEditing(null);
      load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Publish failed", "danger");
    }
  };

  const counts = useMemo(() => {
    const map: Record<string, number> = { all: listings.length };
    for (const p of PILLS.slice(1)) map[p.id] = listings.filter((l) => l.status === p.id).length;
    return map;
  }, [listings]);

  const visible = filter === "all" ? listings : listings.filter((l) => l.status === filter);

  const priceFields = (
    <>
      {form.type === "auction" ? (
        <>
          <AField label="Start price €">
            <AInput value={form.startPrice} onChange={(v) => set({ startPrice: v })} placeholder="100.00" />
          </AField>
          {canPrice && (
            <AField label="Reserve €" hint="Hidden from bidders — “reserve not met” is all they see.">
              <AInput value={form.reserve} onChange={(v) => set({ reserve: v })} placeholder="none" />
            </AField>
          )}
        </>
      ) : (
        <AField label="Price €">
          <AInput value={form.price} onChange={(v) => set({ price: v })} placeholder="220.00" />
        </AField>
      )}
      <AField label="Anti-snipe override (seconds)" hint="Empty = market default (60s).">
        <AInput value={form.antiSnipe} onChange={(v) => set({ antiSnipe: v })} placeholder="60" />
      </AField>
    </>
  );

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <h1 style={{ fontFamily: AT.body, fontSize: 20, fontWeight: 700, color: AT.ink }}>Listings</h1>
        <div style={{ display: "flex", gap: 8 }}>
          {can("listings.create") && can("listings.publish") && (
            <ABtn kind={readyCount > 0 ? "dark" : "ghost"} onClick={() => void openQueue()}>
              Ready to list{readyCount > 0 ? ` (${readyCount})` : ""}
            </ABtn>
          )}
          {can("listings.create") && (
            <ABtn onClick={() => void openCreate()}>
              <AIcon name="plus" size={15} color="#fff" /> New listing
            </ABtn>
          )}
        </div>
      </div>

      <APills options={PILLS.map((p) => ({ id: p.id, label: p.label, count: counts[p.id] ?? 0 }))} value={filter} onChange={setFilter} />

      <ACard pad={false}>
        {visible.length === 0 ? (
          <AEmpty text="No listings here yet." />
        ) : (
          <ATable head={["Title", "Type", "Item", "Price", "Reserve", "Market", "Created", "Status"]}>
            {visible.map((l) => (
              <ATr key={l.id} onClick={() => openEdit(l)}>
                <ATd><span style={{ fontWeight: 600 }}>{l.title}</span></ATd>
                <ATd><ABadge tone={l.type === "auction" ? "accent" : "neutral"}>{l.type}</ABadge></ATd>
                <ATd>
                  <div style={{ fontFamily: AT.mono, fontSize: 11.5 }}>{l.itemSku}</div>
                  {l.itemStatus && (
                    <ABadge tone={ITEM_STATUS_TONE[l.itemStatus]?.tone ?? "neutral"}>
                      {ITEM_STATUS_TONE[l.itemStatus]?.label ?? l.itemStatus}
                    </ABadge>
                  )}
                </ATd>
                <ATd mono right>{l.type === "auction" ? (l.startPriceCents != null ? formatEur(l.startPriceCents) : "—") : l.priceCents != null ? formatEur(l.priceCents) : "—"}</ATd>
                <ATd mono right>{l.reserveCents != null ? formatEur(l.reserveCents) : "—"}</ATd>
                <ATd>{l.marketCode}</ATd>
                <ATd>{formatDay(l.createdAt)}</ATd>
                <ATd><ABadge tone={l.status === "published" ? "ok" : "neutral"}>{l.status}</ABadge></ATd>
              </ATr>
            ))}
          </ATable>
        )}
      </ACard>

      {queue !== null && (
        <ADrawer
          title={queueItem ? (
            <span>List <span style={{ fontFamily: AT.mono, fontSize: 12, color: AT.inkSoft }}>{queueItem.sku}</span></span>
          ) : `Ready to list (${queue.length})`}
          onClose={() => { setQueue(null); setQueueItem(null); }}
          footer={
            queueItem ? (
              <>
                <ABtn kind="ghost" onClick={() => setQueueItem(null)}>← Back to queue</ABtn>
                <ABtn onClick={() => void submitQuick()} disabled={!quickValid}>
                  {form.type === "auction" ? "Publish & schedule" : "Publish"}
                </ABtn>
              </>
            ) : (
              <ABtn kind="ghost" onClick={() => setQueue(null)}>Close</ABtn>
            )
          }
        >
          {queueItem ? (
            <div style={{ display: "grid", gap: 14 }}>
              <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                {queueItem.photos[0] && (
                  <img src={thumbOf(queueItem.photos[0])} alt="" style={{ width: 64, height: 64, objectFit: "cover", borderRadius: 8, border: `1px solid ${AT.rule}` }} />
                )}
                <div style={{ fontSize: 12.5, color: AT.inkSoft }}>
                  {conditionByCode(queueItem.condition)?.label ?? queueItem.condition}
                  {queueItem.conditionNotes ? ` — ${queueItem.conditionNotes}` : ""} · {queueItem.photos.length} photo{queueItem.photos.length === 1 ? "" : "s"} · {queueItem.marketCode}
                </div>
              </div>
              <AField label="Type">
                <ASelect value={form.type} onChange={(v) => set({ type: v as "auction" | "fixed" })} options={[{ value: "auction", label: "Auction" }, { value: "fixed", label: "Fixed price" }]} />
              </AField>
              <AField label="Title"><AInput value={form.title} onChange={(v) => set({ title: v })} /></AField>
              <AField label="Description" hint="Copied from the item — polish the selling copy here.">
                <textarea value={form.description} onChange={(e) => set({ description: e.target.value })} rows={4} style={{
                  width: "100%", borderRadius: AT.radiusSm, border: `1px solid ${AT.rule}`, fontFamily: AT.body,
                  fontSize: 13, color: AT.ink, padding: 10, resize: "vertical",
                }} />
              </AField>
              {priceFields}
              {form.type === "auction" && (
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                  <AField label="Starts" hint="Sticky for the whole batch.">
                    <input type="datetime-local" value={sched.startsAt} onChange={(e) => setSched({ ...sched, startsAt: e.target.value })} style={{
                      width: "100%", height: 36, borderRadius: AT.radiusSm, border: `1px solid ${AT.rule}`, fontFamily: AT.body, fontSize: 13, color: AT.ink, padding: "0 10px", boxSizing: "border-box",
                    }} />
                  </AField>
                  <AField label="Ends">
                    <input type="datetime-local" value={sched.endsAt} onChange={(e) => setSched({ ...sched, endsAt: e.target.value })} style={{
                      width: "100%", height: 36, borderRadius: AT.radiusSm, border: `1px solid ${AT.rule}`, fontFamily: AT.body, fontSize: 13, color: AT.ink, padding: "0 10px", boxSizing: "border-box",
                    }} />
                  </AField>
                </div>
              )}
            </div>
          ) : (
            <div style={{ display: "grid", gap: 10 }}>
              <div style={{ fontSize: 12.5, color: AT.inkSoft }}>
                Draft items with photos and a grade — one click from published.
                {noPhotoCount > 0 && <> <b>{noPhotoCount}</b> more draft{noPhotoCount === 1 ? "" : "s"} still need photos (shoot them in warehouse mode).</>}
              </div>
              {queue.length === 0 && <AEmpty text="Nothing ready — receive and photograph items first." />}
              {queue.map((it) => (
                <button key={it.id} onClick={() => pickQueueItem(it)} style={{
                  all: "unset", cursor: "pointer", display: "flex", gap: 10, alignItems: "center",
                  border: `1px solid ${AT.rule}`, borderRadius: 10, padding: 10, background: AT.panel,
                }}>
                  {it.photos[0] ? (
                    <img src={thumbOf(it.photos[0])} alt="" style={{ width: 46, height: 46, objectFit: "cover", borderRadius: 7 }} />
                  ) : (
                    <div style={{ width: 46, height: 46, borderRadius: 7, background: AT.surfaceAlt }} />
                  )}
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontFamily: AT.mono, fontSize: 11.5, color: AT.inkSoft }}>{it.sku}</div>
                    <div style={{ fontSize: 13, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{it.title}</div>
                  </div>
                  <ABadge tone="neutral">{conditionByCode(it.condition)?.label ?? it.condition}</ABadge>
                </button>
              ))}
            </div>
          )}
        </ADrawer>
      )}

      {creating && (
        <ADrawer
          title="New listing"
          onClose={() => setCreating(false)}
          footer={
            <>
              <ABtn kind="ghost" onClick={() => setCreating(false)}>Cancel</ABtn>
              <ABtn onClick={() => void submitCreate()} disabled={!form.itemId || !form.title || (form.type === "auction" ? !form.startPrice : !form.price)}>Create</ABtn>
            </>
          }
        >
          <div style={{ display: "grid", gap: 14 }}>
            {items.length === 0 ? (
              <div style={{ fontFamily: AT.body, fontSize: 13, color: AT.inkSoft }}>
                No draft or listed items available. Add one under Inventory first.
              </div>
            ) : (
              <AField label="Item">
                <ASelect
                  value={form.itemId}
                  onChange={(v) => {
                    const it = items.find((i) => i.id === v);
                    set({ itemId: v, title: it?.title ?? form.title });
                  }}
                  options={items.map((i) => ({ value: i.id, label: `${i.sku} — ${i.title}` }))}
                />
              </AField>
            )}
            <AField label="Type">
              <ASelect value={form.type} onChange={(v) => set({ type: v as "auction" | "fixed" })} options={[{ value: "auction", label: "Auction" }, { value: "fixed", label: "Fixed price" }]} />
            </AField>
            <AField label="Title"><AInput value={form.title} onChange={(v) => set({ title: v })} /></AField>
            <AField label="Description">
              <textarea value={form.description} onChange={(e) => set({ description: e.target.value })} rows={4} style={{
                width: "100%", borderRadius: AT.radiusSm, border: `1px solid ${AT.rule}`, fontFamily: AT.body,
                fontSize: 13, color: AT.ink, padding: 10, resize: "vertical",
              }} />
            </AField>
            <AField label="Market">
              <ASelect value={form.marketCode} onChange={(v) => set({ marketCode: v })} options={markets.map((m) => ({ value: m.code, label: `${m.name} (${m.code})` }))} />
            </AField>
            {priceFields}
          </div>
        </ADrawer>
      )}

      {editing && (
        <ADrawer
          title={<span>Edit listing <span style={{ fontFamily: AT.mono, fontSize: 12, color: AT.inkSoft }}>{editing.itemSku}</span></span>}
          onClose={() => setEditing(null)}
          footer={
            <>
              {editing.status === "draft" && can("listings.publish") && (
                <ABtn kind="dark" onClick={() => void publish()}>Publish</ABtn>
              )}
              <ABtn kind="ghost" onClick={() => setEditing(null)}>Close</ABtn>
              {can("listings.edit") && <ABtn onClick={() => void submitEdit()}>Save</ABtn>}
            </>
          }
        >
          <div style={{ display: "grid", gap: 14 }}>
            <AField label="Title"><AInput value={form.title} onChange={(v) => set({ title: v })} /></AField>
            <AField label="Description">
              <textarea value={form.description} onChange={(e) => set({ description: e.target.value })} rows={4} style={{
                width: "100%", borderRadius: AT.radiusSm, border: `1px solid ${AT.rule}`, fontFamily: AT.body,
                fontSize: 13, color: AT.ink, padding: 10, resize: "vertical",
              }} />
            </AField>
            {!canPrice && (
              <div style={{ fontFamily: AT.body, fontSize: 12, color: AT.inkSoft, background: AT.surfaceAlt, borderRadius: 8, padding: "8px 10px" }}>
                Pricing fields need the Sales Manager permission (listings.set_pricing).
              </div>
            )}
            {canPrice && priceFields}
            {editing.status === "published" && editing.type === "auction" && (
              <div style={{ fontFamily: AT.body, fontSize: 12.5, color: AT.inkSoft }}>
                Ready to run? <button onClick={() => nav.go("auctions")} style={{ all: "unset", cursor: "pointer", color: AT.accent, fontWeight: 600 }}>Schedule an auction →</button>
              </div>
            )}
            {history.length > 0 && (
              <ACard title="Auction history" pad={false}>
                <ATable head={["Status", "Price", "Ends"]}>
                  {history.map((a) => (
                    <ATr key={a.id} onClick={() => nav.go("auctions", a.id)}>
                      <ATd><ABadge tone={AUCTION_STATUS_TONE[a.status]?.tone ?? "neutral"}>{AUCTION_STATUS_TONE[a.status]?.label ?? a.status}</ABadge></ATd>
                      <ATd mono right>{a.currentPriceCents != null ? formatEur(a.currentPriceCents) : "—"}</ATd>
                      <ATd>{formatDate(a.endsAt)}</ATd>
                    </ATr>
                  ))}
                </ATable>
              </ACard>
            )}
          </div>
        </ADrawer>
      )}
    </div>
  );
}
