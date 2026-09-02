"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { PUBLIC_API_URL } from "./config";
import { translate, type Lang } from "./strings";

export type { Lang };
export { ALL_LANGS, dateLocale } from "./strings";

/**
 * Flat key→{lv,ru,en,et,lt} dictionary — the Shhh i18n mechanism, auction-keyed.
 * The default language is chosen per country from the request domain (see
 * lib/country.ts); each country offers its national language + Russian +
 * English. Estonian/Lithuanian strings should be reviewed by native speakers
 * before launch (like the per-country VAT rates).
 */



interface I18n {
  lang: Lang;
  setLang: (l: Lang) => void;
  /** Languages offered on the current country's domain. */
  available: Lang[];
  /** `t("acc.n", { n: 3 })` подставит 3 вместо `{n}`. */
  t: (key: string, vars?: Record<string, string | number>) => string;
}

const I18nContext = createContext<I18n>({ lang: "lv", setLang: () => undefined, available: ["lv", "ru", "en"], t: (k) => k });
export const useT = () => useContext(I18nContext);

export function I18nProvider({
  children,
  initialLang = "lv",
  available = ["lv", "ru", "en"],
}: {
  children: ReactNode;
  initialLang?: Lang;
  available?: Lang[];
}) {
  const [lang, setLangState] = useState<Lang>(initialLang);
  // Правки текстов из админки (CMS): накладываются поверх словаря кода.
  // Витрина остаётся рабочей и без них — это удобство, не зависимость.
  const [overrides, setOverrides] = useState<Record<string, Record<string, string>>>({});
  useEffect(() => {
    // A stored preference wins, but only if the domain offers that language.
    const stored = localStorage.getItem("auction_lang") as Lang | null;
    if (stored && available.includes(stored)) setLangState(stored);
    void fetch(`${PUBLIC_API_URL}/api/public/ui-strings`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { overrides?: Record<string, Record<string, string>> } | null) => {
        if (d?.overrides && Object.keys(d.overrides).length) setOverrides(d.overrides);
      })
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const setLang = (l: Lang) => {
    setLangState(l);
    localStorage.setItem("auction_lang", l);
    document.documentElement.lang = l;
  };
  const t = (key: string, vars?: Record<string, string | number>): string => {
    const over = overrides[key]?.[lang];
    if (over !== undefined) {
      return vars ? over.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : over;
    }
    return translate(lang, key, vars);
  };
  return <I18nContext.Provider value={{ lang, setLang, available, t }}>{children}</I18nContext.Provider>;
}

/** Переведённая строка как элемент.
 *
 *  Серверные страницы не могут звать хук, но могут отрисовать клиентский
 *  компонент — так их подписи тоже меняются вместе с языком, без перезагрузки. */
export function T({ k, vars }: { k: string; vars?: Record<string, string | number> }) {
  const { t } = useT();
  return <>{t(k, vars)}</>;
}

/** То же для мест, где нужна именно строка (aria-label, placeholder). */
export function useTs() {
  return useT().t;
}
