"use client";

import { useEffect, useMemo, useState } from "react";
import { publicApi } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { formatEur, type MyOrder, type ParcelLocation, type ShippingOption } from "@/lib/types";

/**
 * Delivery selection for an unpaid order: warehouse pickup (free) or an
 * Omniva parcel machine (flat price, joins the total). Saving reprices the
 * order server-side, so the parent must reload orders afterwards.
 */
export function DeliveryPicker({ order, onSaved }: { order: MyOrder; onSaved: () => void }) {
  const { t } = useT();
  const [options, setOptions] = useState<ShippingOption[]>([]);
  const [method, setMethod] = useState(order.fulfilment);
  const [locations, setLocations] = useState<ParcelLocation[] | null>(null);
  const [filter, setFilter] = useState("");
  const [machineId, setMachineId] = useState(order.shippingTo?.machineId ?? "");
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<"saved" | "error" | null>(null);

  useEffect(() => {
    void publicApi
      .get<{ options: ShippingOption[] }>(`/api/public/shipping/options?market=LV`)
      .then((r) => setOptions(r.options))
      .catch(() => setOptions([{ method: "pickup", priceCents: 0, handlingCents: 0 }]));
  }, []);

  useEffect(() => {
    if (method !== "omniva_pm" || locations !== null) return;
    void publicApi
      .get<{ locations: ParcelLocation[] }>(`/api/public/shipping/locations?country=LV`)
      .then((r) => setLocations(r.locations))
      .catch(() => setLocations([]));
  }, [method, locations]);

  const filtered = useMemo(() => {
    if (!locations) return [];
    const needle = filter.trim().toLowerCase();
    const list = needle
      ? locations.filter((l) => l.name.toLowerCase().includes(needle) || l.city.toLowerCase().includes(needle))
      : locations;
    return list.slice(0, 60);
  }, [locations, filter]);

  const omniva = options.find((o) => o.method === "omniva_pm");
  if (!omniva) return null; // shipping off — pickup is implicit

  async function save() {
    setBusy(true);
    setNotice(null);
    try {
      await publicApi.post(`/api/public/orders/${encodeURIComponent(order.ref)}/fulfilment`, {
        method,
        ...(method === "omniva_pm" ? { machineId, recipientPhone: phone } : {}),
      });
      setNotice("saved");
      onSaved();
    } catch {
      setNotice("error");
    } finally {
      setBusy(false);
    }
  }

  const radio = (value: string, label: string): React.ReactNode => (
    <label style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 12.5, cursor: "pointer" }}>
      <input type="radio" name={`delivery-${order.ref}`} checked={method === value} onChange={() => setMethod(value)} />
      {label}
    </label>
  );

  const inputStyle: React.CSSProperties = {
    border: "1px solid rgba(10,10,10,0.15)", borderRadius: 8, padding: "7px 10px", fontSize: 12.5, width: "100%", boxSizing: "border-box",
  };

  const canSave =
    method !== order.fulfilment || (method === "omniva_pm" && machineId !== (order.shippingTo?.machineId ?? ""))
      ? method === "pickup" || (machineId && phone.replace(/\D/g, "").length >= 7)
      : false;

  return (
    <div style={{ background: "#FAFAF8", border: "1px solid rgba(10,10,10,0.07)", borderRadius: 10, padding: "10px 12px", display: "grid", gap: 8 }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: "#6B6B68", textTransform: "uppercase", letterSpacing: "0.05em" }}>{t("acc.delivery")}</div>
      <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
        {radio("pickup", t("acc.deliveryPickup"))}
        {radio("omniva_pm", `${t("acc.deliveryOmniva")} — ${formatEur(omniva.priceCents + omniva.handlingCents)}`)}
      </div>
      {method === "omniva_pm" && (
        <div style={{ display: "grid", gap: 6 }}>
          <input style={inputStyle} placeholder={t("acc.machineFilter")} value={filter} onChange={(e) => setFilter(e.target.value)} />
          <select style={inputStyle} value={machineId} onChange={(e) => setMachineId(e.target.value)}>
            <option value="">{t("acc.chooseMachine")}</option>
            {filtered.map((l) => (
              <option key={l.id} value={l.id}>
                {l.city} — {l.name}
              </option>
            ))}
          </select>
          <input style={inputStyle} placeholder={t("acc.phone")} value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" />
        </div>
      )}
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <button
          onClick={() => void save()}
          disabled={busy || !canSave}
          style={{
            border: "none", borderRadius: 99, padding: "6px 14px", fontSize: 12, fontWeight: 700,
            background: canSave ? "#0A0A0A" : "rgba(10,10,10,0.15)", color: "#fff", cursor: canSave ? "pointer" : "default",
          }}
        >
          {t("acc.saveDelivery")}
        </button>
        {notice === "saved" && <span style={{ fontSize: 12, color: "#1F8A4C", fontWeight: 600 }}>{t("acc.deliverySaved")}</span>}
        {notice === "error" && <span style={{ fontSize: 12, color: "#B0282C", fontWeight: 600 }}>{t("acc.deliveryError")}</span>}
        {order.fulfilment === "omniva_pm" && order.shippingTo && (
          <span style={{ fontSize: 11.5, color: "#6B6B68" }}>
            {order.shippingTo.name} · {t("acc.shippingCost")}: {formatEur(order.shippingCents + order.handlingCents)}
          </span>
        )}
      </div>
    </div>
  );
}

/** Tracking line for a paid, shipped order. */
export function TrackingLine({ order }: { order: MyOrder }) {
  const { t } = useT();
  if (!order.shipment) return null;
  const statusKey =
    order.shipment.status === "delivered" ? "acc.shipDelivered" : order.shipment.status === "in_transit" ? "acc.shipTransit" : "acc.shipRegistered";
  return (
    <div style={{ padding: "0 16px 10px", fontSize: 12, color: "#6B6B68", display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
      <span style={{
        fontSize: 11, fontWeight: 700, borderRadius: 99, padding: "2px 9px",
        background: order.shipment.status === "delivered" ? "#E4F4EA" : "#EAF0FE",
        color: order.shipment.status === "delivered" ? "#1F8A4C" : "#2D4BFF",
      }}>{t(statusKey)}</span>
      {order.shippingTo && <span>{order.shippingTo.name}</span>}
      <a
        href={`https://www.omniva.lv/track-and-trace/?barcode=${encodeURIComponent(order.shipment.barcode)}`}
        target="_blank"
        rel="noreferrer"
        style={{ color: "#2D4BFF", fontWeight: 700 }}
      >
        {t("acc.tracking")}: {order.shipment.barcode}
      </a>
    </div>
  );
}
