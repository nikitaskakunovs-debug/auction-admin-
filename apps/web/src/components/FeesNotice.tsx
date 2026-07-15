"use client";

import { useEffect, useState } from "react";
import { publicApi } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { formatEur } from "@/lib/types";

/** Red banner on the account page while restock fees are outstanding —
 * explains why bidding/buying is paused and how to clear it. */
export function FeesNotice() {
  const { t } = useT();
  const [fees, setFees] = useState<{ outstandingCents: number; fees: Array<{ orderRef: string; amountCents: number }> } | null>(null);

  useEffect(() => {
    if (!publicApi.hasSession) return;
    void publicApi
      .get<{ outstandingCents: number; fees: Array<{ orderRef: string; amountCents: number }> }>("/api/public/me/fees")
      .then(setFees)
      .catch(() => undefined);
  }, []);

  if (!fees || fees.outstandingCents <= 0) return null;

  return (
    <div style={{ background: "#FBE3E3", border: "1px solid #E8B4B4", borderRadius: 14, padding: "14px 18px" }}>
      <div style={{ fontSize: 14, fontWeight: 700, color: "#8F1D21" }}>
        {t("fees.banner")}: {formatEur(fees.outstandingCents)}
      </div>
      <div style={{ fontSize: 12.5, color: "#8F1D21", marginTop: 4 }}>{t("fees.note")}</div>
      <div style={{ fontSize: 12, color: "#A54A4D", marginTop: 6, display: "flex", gap: 12, flexWrap: "wrap" }}>
        {fees.fees.map((f) => (
          <span key={f.orderRef} style={{ fontFamily: '"Geist Mono", ui-monospace, monospace' }}>
            {f.orderRef} · {formatEur(f.amountCents)}
          </span>
        ))}
      </div>
    </div>
  );
}
