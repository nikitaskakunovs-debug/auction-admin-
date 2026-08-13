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
    <div className="bb-status out" style={{ margin: 0, padding: "14px 18px" }}>
      <b>{t("fees.banner")}: {formatEur(fees.outstandingCents)}</b>
      <p className="note" style={{ marginTop: 4 }}>{t("fees.note")}</p>
      <p className="note tnum" style={{ marginTop: 6, display: "flex", gap: 12, flexWrap: "wrap" }}>
        {fees.fees.map((f) => (
          <span key={f.orderRef}>{f.orderRef} · {formatEur(f.amountCents)}</span>
        ))}
      </p>
    </div>
  );
}
