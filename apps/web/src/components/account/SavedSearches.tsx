"use client";

/** Сохранённые поиски (макет № 80).
 *
 *  Живут рядом со списком желаний: там «конкретные лоты», здесь «условия»,
 *  по которым лоты появятся позже. Письмо о новых лотах — по галочке, и её
 *  видно прямо в строке: подписка не должна быть спрятана в настройках.
 */

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { publicApi } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { formatEur } from "@/lib/types";
import { Ph } from "../Ph";
import { say } from "../Toast";

interface SearchQuery {
  q?: string;
  category?: string;
  market?: string;
  priceMinCents?: number;
  priceMaxCents?: number;
  condition?: string;
  noReserve?: boolean;
}

interface SavedSearch {
  id: string;
  name: string;
  query: SearchQuery;
  alertEmail: boolean;
  createdAt: string;
}

/** Собирает адрес каталога из сохранённых фильтров. */
export function searchHref(q: SearchQuery): string {
  const p = new URLSearchParams();
  if (q.q) p.set("q", q.q);
  if (q.category) p.set("category", q.category);
  if (q.market) p.set("market", q.market);
  if (q.condition) p.set("condition", q.condition);
  if (q.noReserve) p.set("noReserve", "1");
  if (q.priceMinCents !== undefined) p.set("min", String(Math.round(q.priceMinCents / 100)));
  if (q.priceMaxCents !== undefined) p.set("max", String(Math.round(q.priceMaxCents / 100)));
  const s = p.toString();
  return s ? `/katalogs?${s}` : "/katalogs";
}

export function SavedSearches() {
  const { t } = useT();
  const [list, setList] = useState<SavedSearch[] | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    void publicApi
      .get<{ searches: SavedSearch[] }>("/api/public/me/searches")
      .then((r) => setList(r.searches))
      .catch(() => setList([]));
  }, []);
  useEffect(load, [load]);

  if (list === null) return null;

  const describe = (q: SearchQuery): string => {
    const parts: string[] = [];
    if (q.q) parts.push(`«${q.q}»`);
    // Коды каталога человеку ничего не говорят — показываем названия.
    if (q.category) parts.push(t(`cat.${q.category}`));
    if (q.condition) parts.push(t(`cond.${q.condition}`));
    if (q.priceMinCents !== undefined || q.priceMaxCents !== undefined) {
      parts.push(
        `${q.priceMinCents !== undefined ? formatEur(q.priceMinCents) : "—"} … ${
          q.priceMaxCents !== undefined ? formatEur(q.priceMaxCents) : "—"
        }`,
      );
    }
    if (q.noReserve) parts.push(t("rail.noReserve"));
    return parts.join(" · ") || t("ss.any");
  };

  const toggleAlert = (s: SavedSearch) => {
    setBusy(true);
    void publicApi
      .request("PATCH", `/api/public/me/searches/${s.id}`, { alertEmail: !s.alertEmail })
      .then(() => { say(!s.alertEmail ? t("ss.alertOn") : t("ss.alertOff")); load(); })
      .catch(() => say(t("err.generic")))
      .finally(() => setBusy(false));
  };

  const remove = (id: string) => {
    setBusy(true);
    void publicApi
      .request("DELETE", `/api/public/me/searches/${id}`)
      .then(load)
      .catch(() => say(t("err.generic")))
      .finally(() => setBusy(false));
  };

  return (
    <section className="ss-block">
      <p className="g-lbl">{t("ss.title")}</p>
      {list.length === 0 ? (
        <p className="note">{t("ss.empty")}</p>
      ) : (
        list.map((s) => (
          <div className="ss-row" key={s.id}>
            <span className="t">
              <b>{s.name}</b>
              <small>{describe(s.query)}</small>
            </span>
            <label className="ss-alert">
              <input type="checkbox" checked={s.alertEmail} disabled={busy} onChange={() => toggleAlert(s)} />
              <span>{t("ss.alert")}</span>
            </label>
            <span className="ss-acts">
              <Link className="btn btn-outline btn-sm" href={searchHref(s.query)}>
                <Ph name="magnifying-glass" size={18} /> {t("ss.open")}
              </Link>
              <button className="btn btn-outline btn-sm" type="button" disabled={busy} onClick={() => remove(s.id)}>
                {t("bp.remove")}
              </button>
            </span>
          </div>
        ))
      )}
      <p className="note">{t("ss.how")}</p>
    </section>
  );
}

/** Кнопка «сохранить этот поиск» — ставится рядом с фильтрами каталога. */
export function SaveSearchButton({ query }: { query: SearchQuery }) {
  const { t } = useT();
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  if (!publicApi.hasSession) return null;

  const defaultName = query.q?.trim() || query.category || t("ss.any");

  return (
    <button
      className="btn btn-outline btn-sm"
      type="button"
      disabled={busy || saved}
      onClick={() => {
        setBusy(true);
        void publicApi
          .post("/api/public/me/searches", { name: defaultName.slice(0, 80), query, alertEmail: false })
          .then(() => { setSaved(true); say(t("ss.saved")); })
          .catch(() => say(t("err.generic")))
          .finally(() => setBusy(false));
      }}
    >
      <Ph name={saved ? "check" : "bell"} size={18} /> {saved ? t("ss.saved") : t("ss.save")}
    </button>
  );
}
