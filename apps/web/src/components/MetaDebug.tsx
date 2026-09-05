"use client";

import { useEffect, useState } from "react";
import { metaTrace, pixelReady, watchPixelCalls, type MetaTrace } from "@/lib/track";

type Tone = "ok" | "warn" | "bad";
type Row = [string, string, Tone];
const TONE: Record<Tone, string> = { ok: "#b9e6a1", warn: "#e8d48a", bad: "#ff9a8a" };

/**
 * Панель диагностики Meta.
 *
 * Открывается вручную: добавить к адресу `?metadebug=1` (выключить —
 * `?metadebug=0`). Живёт до конца вкладки, переходы внутри витрины её не
 * сбрасывают — именно эти переходы и надо смотреть.
 *
 * Показывает то, чего не видно в Events Manager: жив ли пиксель в браузере в
 * момент события. Server-only строка в Meta — это всегда одно из двух: либо
 * fbq не существует (базовый тег не сработал), либо тег Meta в GTM не
 * получил event_id. Первое видно здесь, второе — в режиме предпросмотра GTM.
 *
 * Личных данных панель не показывает и никуда не отправляет: имена событий,
 * их идентификаторы и признаки наличия cookie.
 */
export function MetaDebug() {
  const [on, setOn] = useState(false);
  const [rows, setRows] = useState<readonly MetaTrace[]>([]);
  const [env, setEnv] = useState<Row[]>([]);
  const [copied, setCopied] = useState(false);
  const [reset, setReset] = useState(false);

  // Включение/выключение по адресу; решение держится в рамках вкладки.
  useEffect(() => {
    try {
      const q = new URLSearchParams(window.location.search).get("metadebug");
      if (q === "1") sessionStorage.setItem("izsoli_metadebug", "1");
      if (q === "0") sessionStorage.removeItem("izsoli_metadebug");
      setOn(sessionStorage.getItem("izsoli_metadebug") === "1");
    } catch { /* приватный режим — панель просто не откроется */ }
  }, []);

  useEffect(() => {
    if (!on) return;
    // С этого момента видно каждый вызов пикселя — включая чужие, без eventID.
    watchPixelCalls();
    const cookie = (n: string) =>
      document.cookie.split("; ").some((c) => c.startsWith(`${n}=`)) ? "есть" : "нет";
    const read = () => {
      const w = window as unknown as {
        dataLayer?: unknown[];
        google_tag_manager?: Record<string, unknown>;
      };
      let consent = "не решено";
      try {
        const c = JSON.parse(localStorage.getItem("izsoli_cc_v1") ?? "null") as
          { analytics?: boolean; marketing?: boolean } | null;
        if (c) consent = `аналитика ${c.analytics ? "да" : "нет"}, реклама ${c.marketing ? "да" : "нет"}`;
      } catch { /* нет доступа к хранилищу */ }
      // Отметки «событие по этому заказу уже учтено». Именно из-за них
      // add_to_cart и purchase не повторяются во втором прогоне в том же
      // браузере — событие не потеряно, оно просто уже было.
      let marks = 0;
      try {
        for (const k of Object.keys(localStorage)) if (k.startsWith("izsoli_ga_")) marks += 1;
      } catch { /* нет хранилища */ }
      const containers = Object.keys(w.google_tag_manager ?? {}).filter((k) => k.startsWith("GTM-"));
      const fbevents = Array.from(document.scripts).some((s) => s.src.includes("fbevents.js"));
      setEnv([
        ["fbq", pixelReady() ? "функция — пиксель жив" : "НЕТ — браузерная половина не уйдёт", pixelReady() ? "ok" : "bad"],
        ["fbevents.js", fbevents ? "загружен" : "не загружен", fbevents ? "ok" : "bad"],
        ["GTM", containers.length ? containers.join(", ") : "контейнер не отвечает", containers.length ? "ok" : "bad"],
        ["dataLayer", String(w.dataLayer?.length ?? 0), "ok"],
        ["cookie _fbp", cookie("_fbp"), cookie("_fbp") === "есть" ? "ok" : "warn"],
        ["cookie _fbc", cookie("_fbc"), "ok"],
        ["согласие", consent, consent.includes("реклама да") ? "ok" : "warn"],
        [
          "отметки заказов",
          marks === 0 ? "нет — воронка пойдёт целиком" : `${marks} — add_to_cart и purchase по этим заказам не повторятся`,
          marks === 0 ? "ok" : "warn",
        ],
      ]);
      setRows([...metaTrace.list()]);
    };
    read();
    const off = metaTrace.subscribe(read);
    const timer = setInterval(read, 1000);
    return () => { off(); clearInterval(timer); };
  }, [on]);

  if (!on) return null;

  const asText = [
    ...env.map(([k, v]) => `${k}: ${v}`),
    "—",
    ...rows.map((r) => `${r.at} ${r.event}${r.from ? ` (${r.from})` : ""} | сервер: ${r.server} | браузер: ${r.browser} | ${r.eventId}`),
  ].join("\n");

  const box: React.CSSProperties = {
    position: "fixed", left: 8, bottom: 8, zIndex: 2147483000,
    maxWidth: "min(96vw, 560px)", maxHeight: "60vh", overflow: "auto",
    background: "#101410", color: "#dfe7df", border: "1px solid #2f3a2f", borderRadius: 10,
    padding: "10px 12px", font: "12px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace",
    boxShadow: "0 8px 24px rgba(0,0,0,.4)",
  };

  return (
    <div style={box} role="status" aria-label="Meta diagnostics">
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 6 }}>
        <b style={{ flex: 1 }}>Meta · диагностика</b>
        <button type="button" style={btn}
                onClick={() => {
                  void navigator.clipboard?.writeText(asText).then(() => setCopied(true));
                }}>{copied ? "скопировано" : "копировать"}</button>
        <button type="button" style={btn} title="Разрешить повтор add_to_cart и purchase по тем же заказам"
                onClick={() => {
                  try {
                    for (const k of Object.keys(localStorage)) {
                      if (k.startsWith("izsoli_ga_")) localStorage.removeItem(k);
                    }
                  } catch { /* нет хранилища */ }
                  setReset(true);
                }}>{reset ? "сброшено" : "сбросить отметки"}</button>
        <button type="button" style={btn}
                onClick={() => {
                  try { sessionStorage.removeItem("izsoli_metadebug"); } catch { /* нет хранилища */ }
                  setOn(false);
                }}>закрыть</button>
      </div>

      <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: 8 }}><tbody>
        {env.map(([k, v, tone]) => (
          <tr key={k}>
            <td style={{ opacity: .65, paddingRight: 10, whiteSpace: "nowrap" }}>{k}</td>
            <td style={{ color: TONE[tone] }}>{v}</td>
          </tr>
        ))}
      </tbody></table>

      {rows.length === 0 ? (
        <p style={{ opacity: .6, margin: 0 }}>событий пока не было</p>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead><tr style={{ opacity: .6, textAlign: "left" }}>
            <th>время</th><th>событие</th><th>сервер</th><th>браузер</th>
          </tr></thead>
          <tbody>
            {rows.slice().reverse().map((r) => (
              <tr key={r.eventId} style={{ borderTop: "1px solid #232b23" }}>
                <td style={{ whiteSpace: "nowrap", paddingRight: 8 }}>{r.at}</td>
                <td style={{ paddingRight: 8 }}>{r.event}{r.from ? <span style={{ opacity: .6 }}> · {r.from}</span> : null}</td>
                <td style={{ paddingRight: 8, color: TONE[r.server === "ушло" ? "ok" : "warn"] }}>{r.server}</td>
                <td style={{ color: TONE[r.browser.startsWith("ушло") ? "ok" : r.browser.startsWith("ждём") ? "warn" : "bad"] }}>{r.browser}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

const btn: React.CSSProperties = {
  background: "#1d251d", color: "#dfe7df", border: "1px solid #334033",
  borderRadius: 6, padding: "3px 8px", font: "inherit", cursor: "pointer",
};
