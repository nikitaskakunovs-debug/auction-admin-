"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { publicApi } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { consentUpdate } from "@/lib/track";
import { Icon } from "./Icon";
import { say } from "./Toast";

const KEY = "izsoli_cc_v1";
const VISITOR_KEY = "izsoli_visitor_v1";

/** Действующая редакция текста. Должна совпадать с той, что знает API:
 *  согласие на прежнюю редакцию считается устаревшим и спрашивается заново. */
const POLICY_VERSION = "2026-08-21";

type Saved = { mode: string; analytics: boolean; marketing: boolean; policyVersion?: string };

const readLocal = (): Saved | null => {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Saved) : null;
  } catch { return null; }
};

/** Постоянный идентификатор браузера — чтобы связать решения одного гостя.
 *  Не персональные данные: случайное число, живущее рядом с самим согласием. */
function visitorId(): string {
  try {
    let v = localStorage.getItem(VISITOR_KEY);
    if (!v) {
      v = (crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)).replace(/-/g, "");
      localStorage.setItem(VISITOR_KEY, v);
    }
    return v;
  } catch {
    return "no-storage";
  }
}

/**
 * Плашка согласия на cookie.
 *
 * Решение уходит на сервер. До этого оно записывалось только в браузер и не
 * читалось вообще ничем: доказать согласие было нечем, показать в панели —
 * негде, а на втором устройстве плашка спрашивала заново.
 */
export function CookieBanner() {
  const { t } = useT();
  const [shown, setShown] = useState(false);
  const [analytics, setAnalytics] = useState(false);
  const [marketing, setMarketing] = useState(false);

  /** Открыть плашку заново — из подвала, для отзыва согласия. */
  const reopen = useCallback(() => {
    const saved = readLocal();
    setAnalytics(saved?.analytics ?? false);
    setMarketing(saved?.marketing ?? false);
    setShown(true);
  }, []);

  useEffect(() => {
    window.addEventListener("izsoli:cookie-settings", reopen);
    return () => window.removeEventListener("izsoli:cookie-settings", reopen);
  }, [reopen]);

  useEffect(() => {
    let cancelled = false;
    const local = readLocal();
    // Локальная запись — только чтобы не мигать плашкой, пока идёт запрос.
    if (local && local.policyVersion === POLICY_VERSION) return;

    void (async () => {
      try {
        const r = await publicApi.get<{ consent: Saved | null; stale?: boolean }>(
          `/api/public/consent?visitorId=${encodeURIComponent(visitorId())}`,
        );
        if (cancelled) return;
        if (r.consent && !r.stale) {
          // Согласие нашлось на сервере — на этом устройстве больше не спрашиваем.
          try { localStorage.setItem(KEY, JSON.stringify({ ...r.consent, policyVersion: POLICY_VERSION })); } catch { /* приватный режим */ }
          return;
        }
      } catch {
        // API недоступен — спросим, это безопаснее, чем предположить согласие.
      }
      if (!cancelled) setShown(true);
    })();
    return () => { cancelled = true; };
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
    const a = mode === "accept" ? true : mode === "reject" ? false : analytics;
    const m = mode === "accept" ? true : mode === "reject" ? false : marketing;
    try {
      localStorage.setItem(KEY, JSON.stringify({ mode, analytics: a, marketing: m, policyVersion: POLICY_VERSION }));
    } catch { /* приватный режим — просто прячем плашку */ }
    setShown(false);
    say(message);
    // Consent Mode узнаёт о решении сразу — теги ждут именно этого сигнала.
    consentUpdate(a, m);
    // Запись в журнал — то, чем согласие доказывается. Молча падать нельзя,
    // но и держать человека перед плашкой из-за сети тоже нельзя.
    void publicApi
      .post("/api/public/consent", { visitorId: visitorId(), mode, analytics: a, marketing: m })
      .catch(() => undefined);
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

/** Ссылка «Настройки cookie» для подвала.
 *
 *  По GDPR отозвать согласие должно быть так же просто, как его дать. До
 *  этого в подвале была только ссылка на текст политики — то есть отозвать
 *  согласие было нельзя вообще. */
export function CookieSettingsLink({ label }: { label: string }) {
  return (
    <button type="button" className="f-pill"
            onClick={() => window.dispatchEvent(new Event("izsoli:cookie-settings"))}>
      {label}
    </button>
  );
}
