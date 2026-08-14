"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useT } from "@/lib/i18n";
import { Icon } from "./Icon";
import { say } from "./Toast";

const KEY = "izsoli_cc_v1";

/** Плашка согласия на cookie из макета. Выбор храним локально —
 *  до появления серверного эндпоинта согласий. */
export function CookieBanner() {
  const { t } = useT();
  const [shown, setShown] = useState(false);
  const [analytics, setAnalytics] = useState(false);
  const [marketing, setMarketing] = useState(false);

  useEffect(() => {
    try { if (!localStorage.getItem(KEY)) setShown(true); } catch { setShown(true); }
  }, []);

  useEffect(() => {
    if (!shown) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close("reject", t("cc.rejected"));
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  const close = (mode: string, message: string) => {
    try {
      localStorage.setItem(KEY, JSON.stringify({
        mode,
        analytics: mode === "accept" ? true : mode === "reject" ? false : analytics,
        marketing: mode === "accept" ? true : mode === "reject" ? false : marketing,
      }));
    } catch { /* приватный режим — просто прячем плашку */ }
    setShown(false);
    say(message);
  };

  if (!shown) return null;

  return (
    <section className="cc" aria-label={t("cc.aria")}>
      <h3>{t("cc.title")}</h3>
      <p>{t("cc.intro")}</p>
      <details className="cc-tune">
        <summary>{t("cc.tune")} <Icon name="chev" /></summary>
        <div className="cc-opts">
          <div className="cc-opt">
            <span>{t("cc.necessary")}<small>{t("cc.necessaryD")}</small></span>
            <span className="sw" role="switch" aria-checked="true" aria-disabled="true"
                  aria-label={t("cc.necessaryAria")} />
          </div>
          <div className="cc-opt">
            <span>{t("cc.analytics")}<small>{t("cc.analyticsD")}</small></span>
            <button className="sw" type="button" role="switch" aria-checked={analytics}
                    aria-label={t("cc.analyticsAria")} onClick={() => setAnalytics((v) => !v)} />
          </div>
          <div className="cc-opt">
            <span>{t("cc.marketing")}<small>{t("cc.marketingD")}</small></span>
            <button className="sw" type="button" role="switch" aria-checked={marketing}
                    aria-label={t("cc.marketingAria")} onClick={() => setMarketing((v) => !v)} />
          </div>
        </div>
      </details>
      <div className="cc-actions">
        <button className="btn btn-outline" type="button"
                onClick={() => close("reject", t("cc.rejected"))}>{t("cc.rejectAll")}</button>
        <button className="btn btn-outline" type="button"
                onClick={() => close("accept", t("cc.accepted"))}>{t("cc.acceptAll")}</button>
      </div>
      <p className="cc-more">
        <Link href="/sikdatnes">{t("cc.policy")}</Link> ·{" "}
        <button type="button" onClick={() => close("custom", t("cc.saved"))}>{t("cc.saveMine")}</button>
      </p>
    </section>
  );
}
