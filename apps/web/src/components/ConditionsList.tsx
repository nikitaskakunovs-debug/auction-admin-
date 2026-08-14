"use client";

import { CONDITION_CODES, conditionBadge } from "@/lib/conditions";
import { useT } from "@/lib/i18n";
import { Crumbs } from "@/components/Crumbs";

/** Грейды, у которых всегда есть пояснение к конкретному лоту. */
const NOTED = new Set(["new_with_issue", "new_cosmetic_imperfection", "lightly_used", "used", "used_with_issue"]);

export function ConditionsList() {
  const { t } = useT();
  return (
    <section className="wrap" style={{ paddingTop: 24 }}>
      <Crumbs here={t("cond.title")} />

      <div className="page-head">
        <div>
          <h1 data-hero>{t("cond.title")}</h1>
          <p className="cnt">{CONDITION_CODES.length} pakāpes · vienādi visiem lotiem</p>
        </div>
      </div>

      <p className="lead" style={{ maxWidth: "62ch", marginBottom: "var(--s5)" }}>{t("cond.intro")}</p>

      <div className="scale">
        {CONDITION_CODES.map((code) => (
          <div className="scale-row" key={code}>
            <span className="g" aria-hidden="true">{conditionBadge(code)}</span>
            <span>
              <b>
                {t(`cond.${code}`)}
                {NOTED.has(code) && <span className="this">{t("cond.notes")}</span>}
              </b>
              <small>{t(`cond.${code}.d`)}</small>
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}
