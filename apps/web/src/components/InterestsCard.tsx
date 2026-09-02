"use client";

import { useEffect, useState } from "react";
import { publicApi } from "@/lib/api";
import { CATEGORY_CODES } from "@/lib/categories";
import { useT } from "@/lib/i18n";
import { say } from "./Toast";

/**
 * §6.4: «что тебе интересно?» — выбор категорий чипами при знакомстве.
 * Сеет user_category_stats до первой покупки, чтобы подборки и письма
 * работали с первого дня. Показывается один раз, закрывается навсегда.
 */
const DONE_KEY = "izsoli_interests_v1";

export function InterestsCard() {
  const { t } = useT();
  const [visible, setVisible] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!publicApi.hasSession) return;
    try {
      if (localStorage.getItem(DONE_KEY)) return;
    } catch { /* приватный режим — просто покажем */ }
    setVisible(true);
  }, []);

  if (!visible) return null;

  const toggle = (code: string) =>
    setPicked((cur) => (cur.includes(code) ? cur.filter((c) => c !== code) : cur.length >= 5 ? cur : [...cur, code]));

  const dismiss = () => {
    setVisible(false);
    try { localStorage.setItem(DONE_KEY, "1"); } catch { /* ignore */ }
  };

  const save = async () => {
    if (picked.length === 0) { dismiss(); return; }
    setBusy(true);
    try {
      await publicApi.post("/api/public/me/interests", { categories: picked });
      say(t("int.saved"));
    } catch { /* не удалось — не мешаем человеку жить */ }
    setBusy(false);
    dismiss();
  };

  return (
    <section className="report" style={{ marginBottom: 16 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <h2 style={{ flex: 1 }}>{t("int.title")}</h2>
        <button type="button" onClick={dismiss} aria-label={t("nav.close")}
                style={{ background: "none", border: 0, cursor: "pointer", fontSize: 16 }}>×</button>
      </div>
      <p className="note" style={{ marginTop: 4 }}>{t("int.sub")}</p>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, margin: "10px 0" }}>
        {CATEGORY_CODES.filter((c) => c !== "other").map((code) => {
          const on = picked.includes(code);
          return (
            <button key={code} type="button" onClick={() => toggle(code)} aria-pressed={on}
                    className={on ? "btn btn-primary btn-sm" : "btn btn-sm"}>
              {t(`cat.${code}`)}
            </button>
          );
        })}
      </div>
      <button className="btn btn-primary" type="button" disabled={busy || picked.length === 0}
              onClick={() => void save()}>
        {t("int.save")}
      </button>
    </section>
  );
}
