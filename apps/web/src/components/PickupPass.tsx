"use client";

import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { publicApi } from "@/lib/api";
import { useT } from "@/lib/i18n";

/**
 * The client's pickup pass: one card per paid, uncollected order with the
 * collection code, its QR (renders locally — nothing leaves the
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
    <section className="card-b">
      <h2>{t("pickup.title")}</h2>
      <ul className="orders">
        {orders.map((o) => (
          <li key={o.ref}>
            <div className="o-top">
              {o.pickupCode && <Qr value={o.pickupCode} />}
              <span className="o-title" style={{ minWidth: 200 }}>
                {o.itemTitle}
                <small style={{ display: "block", color: "var(--text-3)", fontWeight: 600 }}>{o.ref}</small>
              </span>
              {o.pickupCode && (
                <span style={{ textAlign: "center" }}>
                  <span className="price-lab">{t("pickup.code")}</span>
                  <b className="tnum" style={{ display: "block", fontSize: 26, letterSpacing: ".14em" }}>
                    {o.pickupCode}
                  </b>
                </span>
              )}
            </div>
            {o.collecting ? (
              <p className="bb-status win" style={{ margin: 0 }}>{t("pickup.inProgress")}</p>
            ) : o.pickupDeadlineAt ? (
              <p className="note">
                {t("pickup.deadline")}: <b>{new Date(o.pickupDeadlineAt).toLocaleDateString("lv-LV")}</b>
                {" · "}{t("pickup.feeNote")}
              </p>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
