import { useEffect, useMemo, useState } from "react";
import { api, ApiError, type Item, type Order } from "../api.js";
import type { Nav } from "../App.js";
import { useAuth } from "../auth.js";
import { formatDate, formatEur } from "../format.js";
import { AT, ITEM_STATUS_TONE, ORDER_STATUS_TONE } from "../theme.js";
import {
  AAvatar, ABadge, ABtn, ACard, ADrawer, AEmpty, AField, AInput, APills,
  ATable, ATd, ATr, useConfirm, useToast,
} from "../ui.js";

interface Refund {
  id: string;
  amountCents: number;
  reason: string;
  createdAt: string;
}

interface OrderDetail {
  order: Order;
  item: Item;
  refunds: Refund[];
  invoice: { id: string; number: string; issuedAt: string } | null;
}

const PILLS = [
  { id: "all", label: "All" },
  { id: "awaiting_payment", label: "Awaiting payment" },
  { id: "paid", label: "Paid" },
  { id: "cancelled", label: "Cancelled" },
  { id: "refunded", label: "Refunded" },
];

export function OrdersScreen({ nav: _nav }: { nav: Nav }) {
  const { can } = useAuth();
  const toast = useToast();
  const confirm = useConfirm();
  const [orders, setOrders] = useState<Order[]>([]);
  const [filter, setFilter] = useState("all");
  const [detail, setDetail] = useState<OrderDetail | null>(null);
  const [refundAmount, setRefundAmount] = useState("");

  const load = () => {
    void api.get<{ orders: Order[] }>("/api/orders").then((r) => setOrders(r.orders)).catch(() => undefined);
  };
  useEffect(load, []);

  const openDetail = (id: string) => {
    void api.get<OrderDetail>(`/api/orders/${id}`).then((d) => {
      setDetail(d);
      const refunded = d.refunds.reduce((a, r) => a + r.amountCents, 0);
      setRefundAmount(((d.order.totalCents - refunded) / 100).toFixed(2));
    }).catch(() => undefined);
  };

  const markPaid = async (o: Order) => {
    const r = await confirm({
      title: `Mark ${o.ref} as paid?`,
      body: `${formatEur(o.totalCents)} from ${o.customerAlias}. The item moves to the fulfilment queue.`,
      confirmLabel: "Mark paid",
    });
    if (!r.ok) return;
    try {
      await api.post(`/api/orders/${o.id}/mark-paid`);
      toast("Order marked paid", "ok");
      openDetail(o.id);
      load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Failed", "danger");
    }
  };

  const refund = async (o: Order) => {
    const cents = Math.round(parseFloat(refundAmount.replace(",", ".")) * 100);
    if (!Number.isFinite(cents) || cents <= 0) {
      toast("Enter a valid refund amount", "danger");
      return;
    }
    const r = await confirm({
      title: `Refund ${formatEur(cents)} on ${o.ref}?`,
      requireReason: true,
      confirmLabel: "Refund",
    });
    if (!r.ok) return;
    try {
      await api.post(`/api/orders/${o.id}/refund`, { amountCents: cents, reason: r.reason });
      toast("Refund recorded", "ok");
      openDetail(o.id);
      load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Refund failed", "danger");
    }
  };

  const issueInvoice = async (o: Order) => {
    try {
      await api.post(`/api/orders/${o.id}/issue-invoice`);
      toast("Invoice issued", "ok");
      openDetail(o.id);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Issue failed", "danger");
    }
  };

  const cancelUnpaid = async (o: Order) => {
    const r = await confirm({
      title: `Cancel ${o.ref} and strike ${o.customerAlias}?`,
      body: "The order is cancelled, the buyer gets an unpaid-winner strike, and the item is freed for relisting.",
      danger: true,
      requireReason: true,
      confirmLabel: "Cancel + strike",
    });
    if (!r.ok) return;
    try {
      await api.post(`/api/orders/${o.id}/cancel-unpaid`, { reason: r.reason, strike: true });
      toast("Order cancelled, strike added", "ok");
      setDetail(null);
      load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Cancel failed", "danger");
    }
  };

  const counts = useMemo(() => {
    const map: Record<string, number> = { all: orders.length };
    for (const p of PILLS.slice(1)) map[p.id] = orders.filter((o) => o.status === p.id).length;
    return map;
  }, [orders]);

  const visible = filter === "all" ? orders : orders.filter((o) => o.status === filter);
  const now = Date.now();

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <h1 style={{ fontFamily: AT.body, fontSize: 20, fontWeight: 700, color: AT.ink }}>Orders</h1>

      <APills options={PILLS.map((p) => ({ id: p.id, label: p.label, count: counts[p.id] ?? 0 }))} value={filter} onChange={setFilter} />

      <ACard pad={false}>
        {visible.length === 0 ? (
          <AEmpty text="No orders match this filter." />
        ) : (
          <ATable head={["Order", "Buyer", "Item", "Hammer", "Premium", "VAT", "Total", "Deadline", "Item state", "Status"]}>
            {visible.map((o) => {
              const overdue = o.status === "awaiting_payment" && o.paymentDeadlineAt !== null && new Date(o.paymentDeadlineAt).getTime() < now;
              return (
                <ATr key={o.id} onClick={() => openDetail(o.id)}>
                  <ATd>
                    <div style={{ fontFamily: AT.mono, fontWeight: 700 }}>{o.ref}</div>
                    <div style={{ fontSize: 11, color: AT.inkSoft }}>{formatDate(o.createdAt)}</div>
                  </ATd>
                  <ATd>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                      <AAvatar name={o.customerAlias} size={22} />
                      <span>
                        <div style={{ fontWeight: 600 }}>{o.customerAlias}</div>
                        <div style={{ fontSize: 10.5, color: AT.inkSoft }}>{o.customerEmail}</div>
                      </span>
                    </span>
                  </ATd>
                  <ATd mono>{o.itemSku}</ATd>
                  <ATd mono right>{formatEur(o.hammerCents)}</ATd>
                  <ATd mono right>{formatEur(o.premiumCents)}</ATd>
                  <ATd mono right>
                    {o.reverseCharge ? <ABadge tone="accent">RC 0%</ABadge> : formatEur(o.vatCents)}
                  </ATd>
                  <ATd mono right><strong>{formatEur(o.totalCents)}</strong></ATd>
                  <ATd>
                    <span style={{ color: overdue ? AT.danger : undefined, fontWeight: overdue ? 700 : 400 }}>
                      {formatDate(o.paymentDeadlineAt)}
                    </span>
                  </ATd>
                  <ATd>
                    {o.itemStatus && (
                      <ABadge tone={ITEM_STATUS_TONE[o.itemStatus]?.tone ?? "neutral"}>
                        {ITEM_STATUS_TONE[o.itemStatus]?.label ?? o.itemStatus}
                      </ABadge>
                    )}
                  </ATd>
                  <ATd>
                    <ABadge tone={ORDER_STATUS_TONE[o.status]?.tone ?? "neutral"}>
                      {ORDER_STATUS_TONE[o.status]?.label ?? o.status}
                    </ABadge>
                  </ATd>
                </ATr>
              );
            })}
          </ATable>
        )}
      </ACard>

      {detail && (
        <ADrawer
          title={<span>Order <span style={{ fontFamily: AT.mono }}>{detail.order.ref}</span></span>}
          onClose={() => setDetail(null)}
          footer={
            <>
              {detail.order.status === "awaiting_payment" && can("orders.cancel_unpaid") && (
                <ABtn kind="danger" onClick={() => void cancelUnpaid(detail.order)}>Cancel + strike</ABtn>
              )}
              <ABtn kind="ghost" onClick={() => setDetail(null)}>Close</ABtn>
              {detail.order.status === "awaiting_payment" && can("orders.mark_paid") && (
                <ABtn onClick={() => void markPaid(detail.order)}>Mark paid</ABtn>
              )}
            </>
          }
        >
          <div style={{ display: "grid", gap: 14 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <AAvatar name={detail.order.customerAlias} size={32} />
              <div style={{ flex: 1 }}>
                <div style={{ fontFamily: AT.body, fontWeight: 700, fontSize: 14 }}>{detail.order.customerAlias}</div>
                <div style={{ fontFamily: AT.body, fontSize: 11.5, color: AT.inkSoft }}>{detail.order.customerEmail}</div>
              </div>
              <ABadge tone={ORDER_STATUS_TONE[detail.order.status]?.tone ?? "neutral"}>
                {ORDER_STATUS_TONE[detail.order.status]?.label ?? detail.order.status}
              </ABadge>
            </div>

            <ACard title="Invoice breakdown">
              <div style={{ display: "grid", gap: 7, fontFamily: AT.body, fontSize: 13 }}>
                <Line k={`Hammer price — ${detail.item.title}`} v={formatEur(detail.order.hammerCents)} />
                <Line k="Buyer's premium (10%)" v={formatEur(detail.order.premiumCents)} />
                <Line k="Net" v={formatEur(detail.order.hammerCents + detail.order.premiumCents)} />
                <Line k={`VAT (${(detail.order.vatRateBp / 100).toFixed(1).replace(/\.0$/, "")}%)`} v={formatEur(detail.order.vatCents)} />
                {detail.order.shippingCents > 0 && <Line k="Shipping" v={formatEur(detail.order.shippingCents)} />}
                <div style={{ borderTop: `1px solid ${AT.rule}`, paddingTop: 7 }}>
                  <Line k="Total due" v={formatEur(detail.order.totalCents)} bold />
                </div>
                {detail.order.reverseCharge && (
                  <div style={{ fontSize: 11.5, color: AT.inkSoft, marginTop: 3 }}>
                    Reverse charge — VAT payable by recipient, Art. 196 Dir. 2006/112/EC.
                  </div>
                )}
                <div style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 8 }}>
                  {detail.invoice ? (
                    <>
                      <span style={{ fontFamily: AT.mono, fontSize: 12 }}>{detail.invoice.number}</span>
                      <ABtn size="sm" kind="ghost" onClick={() =>
                        window.open(`/api/invoices/${detail.invoice!.id}/html?token=${encodeURIComponent(api.accessToken ?? "")}`, "_blank")
                      }>Open invoice</ABtn>
                    </>
                  ) : can("invoices.issue") ? (
                    <ABtn size="sm" kind="ghost" onClick={() => void issueInvoice(detail.order)}>Issue invoice</ABtn>
                  ) : (
                    <span style={{ fontSize: 11.5, color: AT.inkSoft }}>No invoice issued.</span>
                  )}
                </div>
              </div>
            </ACard>

            {detail.refunds.length > 0 && (
              <ACard title="Refunds" pad={false}>
                <ATable head={["When", "Amount", "Reason"]}>
                  {detail.refunds.map((r) => (
                    <ATr key={r.id}>
                      <ATd>{formatDate(r.createdAt)}</ATd>
                      <ATd mono right>{formatEur(r.amountCents)}</ATd>
                      <ATd><span style={{ fontSize: 12, color: AT.inkSoft }}>{r.reason}</span></ATd>
                    </ATr>
                  ))}
                </ATable>
              </ACard>
            )}

            {detail.order.status === "paid" && can("orders.refund") && (
              <ACard title="Refund">
                <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
                  <div style={{ flex: 1 }}>
                    <AField label="Amount €">
                      <AInput value={refundAmount} onChange={setRefundAmount} />
                    </AField>
                  </div>
                  <ABtn kind="ghost" onClick={() => void refund(detail.order)}>Refund…</ABtn>
                </div>
              </ACard>
            )}
          </div>
        </ADrawer>
      )}
    </div>
  );
}

function Line({ k, v, bold }: { k: string; v: string; bold?: boolean }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 14 }}>
      <span style={{ color: bold ? AT.ink : AT.inkSoft, fontWeight: bold ? 700 : 400 }}>{k}</span>
      <span style={{ fontFamily: AT.mono, fontWeight: bold ? 700 : 500 }}>{v}</span>
    </div>
  );
}
