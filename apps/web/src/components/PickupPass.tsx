"use client";

import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { publicApi } from "@/lib/api";
import { useT } from "@/lib/i18n";

/**
 * The client's pickup pass: one card per paid, uncollected order with the
 * 6-digit collection code, its QR (renders locally — nothing leaves the
 * browser), and the collection deadline. The kiosk at the warehouse accepts
 * the code typed or scanned.
 */

export interface PickupOrder {
  ref: string;
  itemTitle: string;
  pickupCode: string | null;
  pickupDeadlineAt: string | null;
  collecting: boolean;
}

function Qr({ value }: { value: string }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    if (canvasRef.current) {
      void QRCode.toCanvas(canvasRef.current, value, { width: 96, margin: 1 }).catch(() => undefined);
    }
  }, [value]);
  return <canvas ref={canvasRef} width={96} height={96} style={{ borderRadius: 8 }} />;
}

export function PickupPass() {
  const { t } = useT();
  const [orders, setOrders] = useState<PickupOrder[]>([]);

  useEffect(() => {
    if (!publicApi.hasSession) return;
    void publicApi
      .get<{ pickup: PickupOrder[] }>("/api/public/me/pickup")
      .then((r) => setOrders(r.pickup))
      .catch(() => undefined);
  }, []);

  if (orders.length === 0) return null;

  return (
    <section>
      <h2 style={{ fontSize: 17, fontWeight: 700, margin: "0 0 10px" }}>{t("pickup.title")}</h2>
      <div style={{ display: "grid", gap: 12 }}>
        {orders.map((o) => (
          <div
            key={o.ref}
            style={{
              display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap",
              background: "#fff", border: "1px solid rgba(10,10,10,0.10)", borderRadius: 14, padding: "14px 18px",
            }}
          >
            {o.pickupCode && <Qr value={o.pickupCode} />}
            <div style={{ flex: 1, minWidth: 200 }}>
              <div style={{ fontSize: 13.5, fontWeight: 700 }}>{o.itemTitle}</div>
              <div style={{ fontSize: 12, color: "#6B6B68", marginTop: 2 }}>{o.ref}</div>
              {o.collecting ? (
                <div style={{ fontSize: 12.5, fontWeight: 700, color: "#2D7A2D", marginTop: 6 }}>{t("pickup.inProgress")}</div>
              ) : (
                o.pickupDeadlineAt && (
                  <div style={{ fontSize: 12.5, color: "#6B6B68", marginTop: 6 }}>
                    {t("pickup.deadline")}: <strong>{new Date(o.pickupDeadlineAt).toLocaleDateString()}</strong>
                    <span style={{ display: "block", marginTop: 2 }}>{t("pickup.feeNote")}</span>
                  </div>
                )
              )}
            </div>
            {o.pickupCode && (
              <div style={{ textAlign: "center" }}>
                <div style={{ fontSize: 10.5, letterSpacing: "0.08em", color: "#6B6B68", fontWeight: 700 }}>{t("pickup.code")}</div>
                <div style={{ fontFamily: '"Geist Mono", ui-monospace, monospace', fontSize: 26, fontWeight: 700, letterSpacing: "0.14em" }}>
                  {o.pickupCode}
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
