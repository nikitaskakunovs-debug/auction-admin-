import { useEffect, useRef, useState } from "react";
import { api, ApiError, type Customer, type Order } from "../api.js";
import type { Nav } from "../App.js";
import { useAuth } from "../auth.js";
import { formatDay, formatEur } from "../format.js";
import { AT, ORDER_STATUS_TONE } from "../theme.js";
import {
  AAvatar, ABadge, ABtn, ACard, ADrawer, AEmpty, AField, AIcon, AInput,
  ATable, ATd, ATr, ASelect, useConfirm, useToast,
} from "../ui.js";

interface CustomerDetail {
  customer: Customer;
  orders: Order[];
  bidStats: { totalBids: number; auctionsBidOn: number };
}

const COUNTRIES = [
  { value: "LV", label: "Latvia" },
  { value: "EE", label: "Estonia" },
  { value: "LT", label: "Lithuania" },
  { value: "", label: "Other" },
];

export function CustomersScreen({ nav: _nav }: { nav: Nav }) {
  const { can } = useAuth();
  const toast = useToast();
  const confirm = useConfirm();
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [detail, setDetail] = useState<CustomerDetail | null>(null);
  const [form, setForm] = useState({ email: "", alias: "", name: "", country: "LV", company: "", vatNo: "" });
  const [edit, setEdit] = useState({ alias: "", name: "", notes: "", blocked: false });
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = (q: string) => {
    void api
      .get<{ customers: Customer[] }>(`/api/customers${q ? `?q=${encodeURIComponent(q)}` : ""}`)
      .then((r) => setCustomers(r.customers))
      .catch(() => undefined);
  };
  useEffect(() => load(""), []);

  const onSearch = (v: string) => {
    setQuery(v);
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => load(v.trim()), 300);
  };

  const openDetail = (id: string) => {
    void api.get<CustomerDetail>(`/api/customers/${id}`).then((d) => {
      setDetail(d);
      setEdit({
        alias: d.customer.alias,
        name: d.customer.name ?? "",
        notes: d.customer.notes,
        blocked: d.customer.blocked,
      });
    }).catch(() => undefined);
  };

  const create = async () => {
    try {
      await api.post("/api/customers", {
        email: form.email,
        alias: form.alias,
        name: form.name || null,
        country: form.country || null,
        marketCode: form.country || null,
        company: form.company || null,
        vatNo: form.vatNo || null,
      });
      toast("Bidder created", "ok");
      setCreating(false);
      load(query);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Create failed", "danger");
    }
  };

  const save = async () => {
    if (!detail) return;
    try {
      await api.patch(`/api/customers/${detail.customer.id}`, {
        alias: edit.alias,
        name: edit.name || null,
        notes: edit.notes,
        blocked: edit.blocked,
      });
      toast("Bidder saved", "ok");
      openDetail(detail.customer.id);
      load(query);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Save failed", "danger");
    }
  };

  const viesCheck = async () => {
    if (!detail) return;
    try {
      const r = await api.post<{ vies: { valid: boolean; consult: string } }>(`/api/customers/${detail.customer.id}/vies-check`);
      toast(r.vies.valid ? `VIES: valid · consultation ${r.vies.consult}` : "VIES: number could NOT be validated — do not zero-rate", r.vies.valid ? "ok" : "danger");
      openDetail(detail.customer.id);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "VIES check failed", "danger");
    }
  };

  const strike = async () => {
    if (!detail) return;
    const r = await confirm({
      title: `Add a strike to ${detail.customer.alias}?`,
      body: "Strikes track unpaid-winner behaviour. Repeated strikes usually mean blocking the account.",
      requireReason: true,
      confirmLabel: "Add strike",
    });
    if (!r.ok) return;
    try {
      await api.post(`/api/customers/${detail.customer.id}/strike`, { reason: r.reason });
      toast("Strike added", "ok");
      openDetail(detail.customer.id);
      load(query);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Failed", "danger");
    }
  };

  const erase = async () => {
    if (!detail) return;
    const r = await confirm({
      title: `GDPR-erase ${detail.customer.alias}?`,
      body: "Personal data (name, company, VAT number, email) is permanently removed and the account blocked. Past orders keep their anonymised snapshots for accounting. This cannot be undone.",
      danger: true,
      typeToConfirm: detail.customer.alias,
      requireReason: true,
      confirmLabel: "Erase",
    });
    if (!r.ok) return;
    try {
      await api.post(`/api/customers/${detail.customer.id}/erase`);
      toast("Personal data erased", "ok");
      setDetail(null);
      load(query);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Erase failed", "danger");
    }
  };

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <h1 style={{ fontFamily: AT.body, fontSize: 20, fontWeight: 700, color: AT.ink }}>Bidders</h1>
        {can("customers.edit") && (
          <ABtn onClick={() => { setForm({ email: "", alias: "", name: "", country: "LV", company: "", vatNo: "" }); setCreating(true); }}>
            <AIcon name="plus" size={15} color="#fff" /> New bidder
          </ABtn>
        )}
      </div>

      <div style={{ maxWidth: 340 }}>
        <AInput value={query} onChange={onSearch} placeholder="Search alias, email or name…" />
      </div>

      <ACard pad={false}>
        {customers.length === 0 ? (
          <AEmpty text="No bidders found." />
        ) : (
          <ATable head={["Bidder", "Name", "Country", "Company / VAT", "Strikes", "Status", "Joined"]}>
            {customers.map((c) => {
              const erased = c.erasedAt !== null;
              return (
                <ATr key={c.id} onClick={() => openDetail(c.id)}>
                  <ATd style={{ opacity: erased ? 0.5 : 1 }}>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                      <AAvatar name={c.alias} size={24} />
                      <span>
                        <div style={{ fontWeight: 600 }}>{c.alias}</div>
                        <div style={{ fontSize: 10.5, color: AT.inkSoft }}>{c.email}</div>
                      </span>
                    </span>
                  </ATd>
                  <ATd style={{ opacity: erased ? 0.5 : 1 }}>{c.name ?? "—"}</ATd>
                  <ATd>{c.country ?? "—"}</ATd>
                  <ATd>
                    <div style={{ fontSize: 12.5 }}>{c.company ?? "—"}</div>
                    {c.vatNo && <div style={{ fontFamily: AT.mono, fontSize: 10.5, color: AT.inkSoft }}>{c.vatNo}</div>}
                  </ATd>
                  <ATd>
                    {c.strikes === 0 ? (
                      <span style={{ color: AT.inkSoft, fontSize: 12 }}>0</span>
                    ) : (
                      <ABadge tone={c.strikes >= 3 ? "danger" : "warn"}>{c.strikes}</ABadge>
                    )}
                  </ATd>
                  <ATd>
                    {erased ? <ABadge tone="neutral">erased</ABadge> : c.blocked ? <ABadge tone="danger">blocked</ABadge> : <ABadge tone="ok">active</ABadge>}
                  </ATd>
                  <ATd>{formatDay(c.createdAt)}</ATd>
                </ATr>
              );
            })}
          </ATable>
        )}
      </ACard>

      {creating && (
        <ADrawer
          title="New bidder"
          onClose={() => setCreating(false)}
          footer={
            <>
              <ABtn kind="ghost" onClick={() => setCreating(false)}>Cancel</ABtn>
              <ABtn onClick={() => void create()} disabled={!form.email || form.alias.length < 2}>Create</ABtn>
            </>
          }
        >
          <div style={{ display: "grid", gap: 14 }}>
            <AField label="Email"><AInput value={form.email} onChange={(v) => setForm({ ...form, email: v })} type="email" /></AField>
            <AField label="Alias" hint="Public display name shown in bid ledgers."><AInput value={form.alias} onChange={(v) => setForm({ ...form, alias: v })} /></AField>
            <AField label="Full name"><AInput value={form.name} onChange={(v) => setForm({ ...form, name: v })} /></AField>
            <AField label="Country">
              <ASelect value={form.country} onChange={(v) => setForm({ ...form, country: v })} options={COUNTRIES} />
            </AField>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <AField label="Company"><AInput value={form.company} onChange={(v) => setForm({ ...form, company: v })} /></AField>
              <AField label="VAT number"><AInput value={form.vatNo} onChange={(v) => setForm({ ...form, vatNo: v })} placeholder="EE123456789" /></AField>
            </div>
          </div>
        </ADrawer>
      )}

      {detail && (
        <ADrawer
          title={
            <span style={{ display: "inline-flex", alignItems: "center", gap: 9 }}>
              <AAvatar name={detail.customer.alias} size={26} />
              {detail.customer.alias}
              {detail.customer.erasedAt && <ABadge tone="neutral">erased</ABadge>}
            </span>
          }
          onClose={() => setDetail(null)}
          footer={
            detail.customer.erasedAt ? (
              <ABtn kind="ghost" onClick={() => setDetail(null)}>Close</ABtn>
            ) : (
              <>
                {can("customers.erase") && <ABtn kind="danger" onClick={() => void erase()}>GDPR erase</ABtn>}
                {can("customers.strike") && <ABtn kind="ghost" onClick={() => void strike()}>Add strike</ABtn>}
                <ABtn kind="ghost" onClick={() => setDetail(null)}>Close</ABtn>
                {can("customers.edit") && <ABtn onClick={() => void save()}>Save</ABtn>}
              </>
            )
          }
        >
          <div style={{ display: "grid", gap: 14 }}>
            <div style={{ display: "flex", gap: 12 }}>
              <Stat label="Bids" value={String(detail.bidStats.totalBids)} />
              <Stat label="Auctions" value={String(detail.bidStats.auctionsBidOn)} />
              <Stat label="Strikes" value={String(detail.customer.strikes)} warn={detail.customer.strikes > 0} />
            </div>

            {detail.customer.vatNo && (
              <div style={{ background: AT.surfaceAlt, borderRadius: AT.radiusSm, padding: "10px 12px", display: "flex", alignItems: "center", gap: 10 }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontFamily: AT.body, fontSize: 12, fontWeight: 700 }}>
                    VIES check{" "}
                    {detail.customer.vies ? (
                      detail.customer.vies.valid ? <ABadge tone="ok">valid</ABadge> : <ABadge tone="danger">invalid</ABadge>
                    ) : (
                      <ABadge tone="warn">not verified</ABadge>
                    )}
                  </div>
                  <div style={{ fontFamily: AT.mono, fontSize: 10.5, color: AT.inkSoft, marginTop: 2 }}>
                    {detail.customer.vatNo}
                    {detail.customer.vies ? ` · checked ${formatDay(detail.customer.vies.checkedAt)} · ${detail.customer.vies.consult}` : ""}
                  </div>
                </div>
                {can("customers.vies_check") && !detail.customer.erasedAt && (
                  <ABtn size="sm" kind="dark" onClick={() => void viesCheck()}>
                    {detail.customer.vies ? "Re-check" : "Validate"}
                  </ABtn>
                )}
              </div>
            )}

            {!detail.customer.erasedAt && can("customers.edit") && (
              <>
                <AField label="Alias"><AInput value={edit.alias} onChange={(v) => setEdit({ ...edit, alias: v })} /></AField>
                <AField label="Full name"><AInput value={edit.name} onChange={(v) => setEdit({ ...edit, name: v })} /></AField>
                <AField label="Notes">
                  <textarea value={edit.notes} onChange={(e) => setEdit({ ...edit, notes: e.target.value })} rows={3} style={{
                    width: "100%", borderRadius: AT.radiusSm, border: `1px solid ${AT.rule}`, fontFamily: AT.body,
                    fontSize: 13, color: AT.ink, padding: 10, resize: "vertical",
                  }} />
                </AField>
                <div>
                  <ABtn kind={edit.blocked ? "danger" : "ghost"} size="sm" onClick={() => setEdit({ ...edit, blocked: !edit.blocked })}>
                    {edit.blocked ? "Blocked — click to unblock on save" : "Active — click to block on save"}
                  </ABtn>
                </div>
              </>
            )}

            <ACard title={`Orders (${detail.orders.length})`} pad={false}>
              {detail.orders.length === 0 ? (
                <AEmpty text="No orders yet." />
              ) : (
                <ATable head={["Ref", "Total", "Status"]}>
                  {detail.orders.map((o) => (
                    <ATr key={o.id}>
                      <ATd mono>{o.ref}</ATd>
                      <ATd mono right>{formatEur(o.totalCents)}</ATd>
                      <ATd>
                        <ABadge tone={ORDER_STATUS_TONE[o.status]?.tone ?? "neutral"}>
                          {ORDER_STATUS_TONE[o.status]?.label ?? o.status}
                        </ABadge>
                      </ATd>
                    </ATr>
                  ))}
                </ATable>
              )}
            </ACard>
          </div>
        </ADrawer>
      )}
    </div>
  );
}

function Stat({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div style={{ flex: 1, background: AT.surfaceAlt, borderRadius: AT.radiusSm, padding: "10px 12px" }}>
      <div style={{ fontFamily: AT.body, fontSize: 10.5, fontWeight: 700, color: AT.inkSoft, textTransform: "uppercase", letterSpacing: "0.06em" }}>{label}</div>
      <div style={{ fontFamily: AT.body, fontSize: 19, fontWeight: 700, color: warn ? AT.warn : AT.ink }}>{value}</div>
    </div>
  );
}
