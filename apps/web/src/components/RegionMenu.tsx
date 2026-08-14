"use client";

import { useEffect } from "react";
import { COUNTRIES, SITE_ORIGINS, type Country } from "@/lib/country";
import { useT, type Lang } from "@/lib/i18n";
import { Icon } from "./Icon";

/** Страна, язык и валюта.
 *
 *  Страна — это домен: izsoli.lv / .ee / .lt. Переключение уводит на
 *  соседний домен, потому что там свой рынок, свой НДС и свои лоты.
 *  Язык переключается на месте. */
export const COUNTRY_LABEL: Record<Country, { name: string; city: string; domain: string }> = {
  LV: { name: "Latvija", city: "Rīga", domain: "izsoli.lv" },
  EE: { name: "Eesti", city: "Tallinn", domain: "izsoli.ee" },
  LT: { name: "Lietuva", city: "Vilnius", domain: "izsoli.lt" },
};

export const LANG_NAME: Record<string, string> = {
  lv: "Latviešu", et: "Eesti", lt: "Lietuvių", ru: "Русский", en: "English",
};

export function RegionMenu({
  open, onClose, country,
}: { open: boolean; onClose: () => void; country: Country }) {
  const { t, lang, setLang, available } = useT();

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    document.body.classList.add("no-scroll");
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.classList.remove("no-scroll");
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="modal sheet" role="dialog" aria-modal="true" aria-labelledby="reg-t">
      <div className="modal-bd" onClick={onClose} />
      <div className="modal-card region-card">
        <div className="modal-head">
          <div>
            <span className="kicker">{t("reg.kicker")}</span>
            <h3 id="reg-t">{t("reg.title")}</h3>
          </div>
          <button className="modal-x" type="button" aria-label={t("nav.close")} onClick={onClose}>
            <Icon name="x" />
          </button>
        </div>

        <section>
          <h4>{t("reg.country")}</h4>
          <div className="region-list">
            {(Object.keys(COUNTRY_LABEL) as Country[]).map((c) => {
              const on = c === country;
              return (
                <a key={c} className={`region-row${on ? " on" : ""}`}
                   href={on ? undefined : SITE_ORIGINS[c]}
                   aria-current={on ? "true" : undefined}>
                  <span className="ic" aria-hidden="true"><Icon name="pin" /></span>
                  <span className="t">
                    <b>{COUNTRY_LABEL[c].name}</b>
                    <small>
                      {COUNTRY_LABEL[c].city} · {COUNTRY_LABEL[c].domain} ·{" "}
                      {COUNTRIES[c].languages.map((l) => LANG_NAME[l] ?? l).join(" · ")}
                    </small>
                  </span>
                  {on ? <Icon name="check" size={18} /> : <Icon name="arrow" size={18} />}
                </a>
              );
            })}
          </div>
          <p className="note" style={{ marginTop: 8 }}>
            {t("reg.countryNote")}
          </p>
        </section>

        <section style={{ marginTop: 20 }}>
          <h4>{t("reg.language")}</h4>
          <div className="sheet-chips">
            {available.map((l: Lang) => (
              <button key={l} className={`chip${lang === l ? " chip-dark" : ""}`} type="button"
                      aria-pressed={lang === l}
                      onClick={() => { setLang(l); onClose(); }}>
                {LANG_NAME[l] ?? l.toUpperCase()}
              </button>
            ))}
          </div>
        </section>

        <section style={{ marginTop: 20 }}>
          <h4>{t("reg.currency")}</h4>
          <div className="sheet-chips">
            <button className="chip chip-dark" type="button" aria-pressed="true">EUR €</button>
          </div>
          <p className="note" style={{ marginTop: 8 }}>
            {t("reg.currencyNote")}
          </p>
        </section>
      </div>
    </div>
  );
}
