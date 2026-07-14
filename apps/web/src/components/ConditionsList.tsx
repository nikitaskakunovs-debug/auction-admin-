"use client";

import { CONDITION_CODES } from "@/lib/conditions";
import { useT } from "@/lib/i18n";

/** SEE NOTES grades — these always carry a per-lot note describing the issue. */
const NOTED = new Set(["new_with_issue", "new_cosmetic_imperfection", "lightly_used", "used", "used_with_issue"]);

export function ConditionsList() {
  const { t } = useT();
  return (
    <div style={{ maxWidth: 760, display: "grid", gap: 14 }}>
      <div>
        <h1 style={{ margin: 0, fontSize: 26, fontWeight: 700, letterSpacing: "-0.02em" }}>{t("cond.title")}</h1>
        <p style={{ color: "#454542", fontSize: 14, lineHeight: 1.6, margin: "8px 0 0" }}>{t("cond.intro")}</p>
      </div>
      <div style={{ display: "grid", gap: 8 }}>
        {CONDITION_CODES.map((code) => (
          <div key={code} style={{ background: "#fff", border: "1px solid rgba(10,10,10,0.10)", borderRadius: 12, padding: "12px 16px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <span style={{ fontSize: 14, fontWeight: 700 }}>{t(`cond.${code}`)}</span>
              {NOTED.has(code) && (
                <span style={{ fontSize: 10.5, fontWeight: 700, color: "#9A5B00", background: "#FCEFD9", borderRadius: 99, padding: "2px 8px", textTransform: "uppercase", letterSpacing: "0.04em" }}>
                  {t("cond.notes")}
                </span>
              )}
            </div>
            <div style={{ fontSize: 13, color: "#454542", lineHeight: 1.55, marginTop: 3 }}>{t(`cond.${code}.d`)}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
