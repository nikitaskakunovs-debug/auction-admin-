import { LANGS, useT } from "./i18n.js";
import { AT } from "./theme.js";

/** Three-pill language selector (LV · RU · EN), persisted per device. */
export function LangSwitch({ dark = false }: { dark?: boolean }) {
  const { lang, setLang } = useT();
  return (
    <div style={{ display: "inline-flex", gap: 4, background: dark ? "rgba(255,255,255,0.08)" : AT.surfaceAlt, borderRadius: 999, padding: 3 }}>
      {LANGS.map((l) => {
        const active = l === lang;
        return (
          <button
            key={l}
            onClick={() => setLang(l)}
            style={{
              all: "unset",
              cursor: "pointer",
              padding: "5px 12px",
              borderRadius: 999,
              fontFamily: AT.body,
              fontSize: 12.5,
              fontWeight: 800,
              letterSpacing: "0.04em",
              textTransform: "uppercase",
              color: active ? (dark ? AT.ink : "#fff") : dark ? "rgba(255,255,255,0.65)" : AT.inkSoft,
              background: active ? (dark ? "#fff" : AT.ink) : "transparent",
            }}
          >
            {l}
          </button>
        );
      })}
    </div>
  );
}
