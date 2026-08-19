import { useCallback, useEffect, useState } from "react";
import { api } from "../api.js";
import { formatDate } from "../format.js";
import { useT } from "../i18n.js";
import { useDebounced } from "../powerkit.js";
import { AT } from "../theme.js";
import { ABadge, ABtn, ACard, AEmpty, AInput, APills, ATable, ATd, ATr } from "../ui.js";

interface ConsentRow {
  id: string;
  mode: string;
  analytics: boolean;
  marketing: boolean;
  policyVersion: string;
  host: string;
  ip: string | null;
  visitorId: string;
  createdAt: string;
  email: string | null;
  alias: string | null;
}

const MODES = [
  { id: "", key: "cons.all" },
  { id: "accept", key: "cons.accept" },
  { id: "reject", key: "cons.reject" },
  { id: "custom", key: "cons.custom" },
] as const;

const PAGE = 100;

/**
 * Журнал согласий на cookie.
 *
 * До этого выбор человека записывался только в его собственный браузер и не
 * читался вообще ничем: показать его здесь было нечем, а на запрос надзорного
 * органа «докажите, что этот человек соглашался» ответить было нечего —
 * GDPR ст. 7 п. 1 требует уметь это показать.
 *
 * Строки не переписываются: каждое решение — отдельная запись, поэтому видна
 * и история, если человек сперва согласился, а потом отозвал.
 */
export function ConsentsScreen() {
  const { t } = useT();
  const [rows, setRows] = useState<ConsentRow[]>([]);
  const [total, setTotal] = useState(0);
  const [mode, setMode] = useState("");
  const [qInput, setQInput] = useState("");
  const [q, setQ] = useState("");
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useDebounced(qInput, setQ);

  /* В зависимостях нет t и toast — useT() отдаёт новую функцию на каждой
   * перерисовке. С ними load пересоздавался каждый рендер, эффект видел
   * «новую» функцию и стрелял загрузкой снова: бесконечный цикл запросов,
   * который на проде упирался в ограничитель частоты и превращался в стену
   * тостов «Neizdevās ielādēt piekrišanas». Ошибка теперь показывается один
   * раз и по месту, вместе с причиной от сервера. */
  const load = useCallback(
    (nextOffset: number, append: boolean) => {
      setLoading(true);
      setError(null);
      const p = new URLSearchParams({ limit: String(PAGE), offset: String(nextOffset) });
      if (mode) p.set("mode", mode);
      if (q.trim().length >= 2) p.set("q", q.trim());
      void api
        .get<{ consents: ConsentRow[]; hasMore: boolean; total: number }>(`/api/consents?${p}`)
        .then((r) => {
          setRows((cur) => (append ? [...cur, ...r.consents] : r.consents));
          setHasMore(r.hasMore);
          setTotal(r.total);
        })
        .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
        .finally(() => setLoading(false));
    },
    [mode, q],
  );

  useEffect(() => {
    setOffset(0);
    load(0, false);
  }, [load]);

  const tone = (m: string) => (m === "accept" ? "ok" : m === "reject" ? "neutral" : "warn");

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <h1 style={{ fontFamily: AT.body, fontSize: 20, fontWeight: 700, color: AT.ink, flex: 1 }}>
          {t("cons.title")}
        </h1>
      </div>

      <p style={{ fontFamily: AT.body, fontSize: 13, color: AT.inkSoft, margin: 0, maxWidth: "68ch" }}>
        {t("cons.intro")}
      </p>

      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <APills
          options={MODES.map((m) => ({ id: m.id, label: t(m.key) }))}
          value={mode}
          onChange={setMode}
        />
        <AInput value={qInput} onChange={setQInput} placeholder={t("cons.search")} />
      </div>

      <ACard>
        {error !== null ? (
          <div style={{ display: "grid", gap: 10, justifyItems: "start", padding: 18 }}>
            <span style={{ fontFamily: AT.body, fontSize: 13.5, color: AT.danger }}>
              {t("cons.loadFailed")}: {error}
            </span>
            <ABtn kind="ghost" onClick={() => load(0, false)}>{t("c.refresh")}</ABtn>
          </div>
        ) : rows.length === 0 && !loading ? (
          <AEmpty text={`${t("cons.empty")} — ${t("cons.emptyHint")}`} />
        ) : (
          <>
            <ATable
              head={[
                t("cons.th.when"), t("cons.th.who"), t("cons.th.decision"),
                t("cons.th.analytics"), t("cons.th.marketing"),
                t("cons.th.site"), t("cons.th.version"),
              ]}
            >
              {rows.map((r) => (
                <ATr key={r.id}>
                  <ATd mono>{formatDate(r.createdAt)}</ATd>
                  <ATd>
                    {r.email ? (
                      <span>
                        <strong style={{ fontWeight: 600 }}>{r.alias ?? r.email}</strong>
                        <span style={{ color: AT.inkSoft, fontSize: 12, display: "block" }}>{r.email}</span>
                      </span>
                    ) : (
                      // Гость: показываем только случайный номер браузера —
                      // ничего, что позволило бы узнать человека.
                      <span style={{ color: AT.inkSoft, fontSize: 12, fontFamily: AT.mono }}>
                        {t("cons.guest")} · {r.visitorId.slice(0, 8)}
                      </span>
                    )}
                  </ATd>
                  <ATd><ABadge tone={tone(r.mode)}>{t(`cons.${r.mode}` as "cons.accept")}</ABadge></ATd>
                  <ATd>{r.analytics ? t("c.yes") : <span style={{ color: AT.inkSoft }}>—</span>}</ATd>
                  <ATd>{r.marketing ? t("c.yes") : <span style={{ color: AT.inkSoft }}>—</span>}</ATd>
                  <ATd mono>{r.host || "—"}</ATd>
                  <ATd mono>{r.policyVersion}</ATd>
                </ATr>
              ))}
            </ATable>
            <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 16px" }}>
              <span style={{ fontFamily: AT.body, fontSize: 12.5, color: AT.inkSoft, flex: 1 }}>
                {`${rows.length} / ${total}`}
              </span>
              {hasMore && (
                <ABtn
                  kind="ghost"
                  disabled={loading}
                  onClick={() => {
                    const next = offset + PAGE;
                    setOffset(next);
                    load(next, true);
                  }}
                >
                  {t("c.loadMore")}
                </ABtn>
              )}
            </div>
          </>
        )}
      </ACard>
    </div>
  );
}
