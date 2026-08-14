"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { PUBLIC_API_URL } from "@/lib/config";
import { CATEGORY_CODES } from "@/lib/categories";
import { useT } from "@/lib/i18n";
import { formatEur, type PublicAuction } from "@/lib/types";
import { Icon } from "./Icon";

/** Экран поиска: открывается по клику в поле шапки.
 *  Пока пусто — недавние запросы и подборки; как только набрано два символа,
 *  показывает живые совпадения по каталогу. Enter уводит в /meklet. */
const RECENT_KEY = "izsoli_recent_q_v1";
const MAX_RECENT = 6;

const CAT_ICON: Record<string, string> = {
  electronics: "tv", appliances: "coffee", furniture: "chair", tools: "tools",
  home_garden: "home", jewellery_watches: "watch", art_antiques: "art",
  sports_outdoors: "bike", kids_toys: "card", fashion: "box",
  food_household: "box", other: "art",
};

function readRecent(): string[] {
  if (typeof localStorage === "undefined") return [];
  try { return JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]") as string[]; }
  catch { return []; }
}

export function SearchOverlay({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useT();
  const router = useRouter();
  const [q, setQ] = useState("");
  const [recent, setRecent] = useState<string[]>([]);
  const [all, setAll] = useState<PublicAuction[] | null>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setRecent(readRecent());
    document.body.classList.add("no-scroll");
    input.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.classList.remove("no-scroll");
    };
  }, [open, onClose]);

  useEffect(() => {
    if (!open || all) return;
    void fetch(`${PUBLIC_API_URL}/api/public/auctions?limit=100`)
      .then((r) => r.json() as Promise<{ auctions: PublicAuction[] }>)
      .then((r) => setAll(r.auctions))
      .catch(() => setAll([]));
  }, [open, all]);

  const hits = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (needle.length < 2 || !all) return [];
    return all.filter((a) => a.title.toLowerCase().includes(needle)).slice(0, 6);
  }, [q, all]);

  const catHits = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (needle.length < 2) return [];
    return CATEGORY_CODES.filter((c) => t(`cat.${c}`).toLowerCase().includes(needle)).slice(0, 4);
  }, [q, t]);

  const go = (term: string) => {
    const clean = term.trim();
    if (clean) {
      const next = [clean, ...readRecent().filter((x) => x !== clean)].slice(0, MAX_RECENT);
      try { localStorage.setItem(RECENT_KEY, JSON.stringify(next)); } catch { /* приватный режим */ }
    }
    onClose();
    router.push(clean ? `/meklet?q=${encodeURIComponent(clean)}` : "/meklet");
  };

  if (!open) return null;

  const popular = CATEGORY_CODES.slice(0, 8);

  return (
    <div className="srch" role="dialog" aria-modal="true" aria-label={t("srch.aria")}>
      <div className="srch-bd" onClick={onClose} />
      <div className="srch-panel">
        <form className="srch-bar" role="search" onSubmit={(e) => { e.preventDefault(); go(q); }}>
          <Icon name="search" size={22} />
          <label className="sr" htmlFor="srch-q">{t("srch.label")}</label>
          <input id="srch-q" ref={input} value={q} type="search" autoComplete="off"
                 placeholder={t("nav.searchPh")} onChange={(e) => setQ(e.target.value)} />
          {q && (
            <button className="srch-clear" type="button" aria-label={t("nav.clear")} onClick={() => setQ("")}>
              <Icon name="x" size={18} />
            </button>
          )}
          <button className="btn btn-primary" type="submit">{t("nav.search")}</button>
          <button className="srch-x" type="button" aria-label={t("nav.close")} onClick={onClose}>
            <Icon name="x" />
          </button>
        </form>

        <div className="srch-body">
          {q.trim().length < 2 ? (
            <>
              {recent.length > 0 && (
                <section>
                  <h4>{t("srch.recent")}</h4>
                  <div className="sheet-chips">
                    {recent.map((r) => (
                      <button key={r} className="chip" type="button" onClick={() => go(r)}>
                        <Icon name="timer" size={14} /> {r}
                      </button>
                    ))}
                    <button className="chip" type="button"
                            onClick={() => {
                              try { localStorage.removeItem(RECENT_KEY); } catch { /* приватный режим */ }
                              setRecent([]);
                            }}>{t("srch.clearHistory")}</button>
                  </div>
                </section>
              )}

              <section>
                <h4>{t("srch.popularCats")}</h4>
                <div className="srch-cats">
                  {popular.map((c) => (
                    <button key={c} className="srch-cat" type="button"
                            onClick={() => { onClose(); router.push(`/katalogs?category=${c}`); }}>
                      <span className="ic"><Icon name={CAT_ICON[c] ?? "art"} /></span>
                      {t(`cat.${c}`)}
                    </button>
                  ))}
                </div>
              </section>

              <section>
                <h4>{t("srch.quickViews")}</h4>
                <div className="sheet-chips">
                  <button className="chip" type="button"
                          onClick={() => { onClose(); router.push("/tiesraide"); }}>{t("rail.live")}</button>
                  <button className="chip" type="button"
                          onClick={() => { onClose(); router.push("/katalogs?closing=1h"); }}>{t("rail.closing")}</button>
                  <button className="chip" type="button"
                          onClick={() => { onClose(); router.push("/katalogs?reserve=no"); }}>{t("rail.noReserve")}</button>
                  <button className="chip" type="button"
                          onClick={() => { onClose(); router.push("/rezultati"); }}>{t("nav.results")}</button>
                </div>
              </section>
            </>
          ) : (
            <>
              {catHits.length > 0 && (
                <section>
                  <h4>{t("nav.categories")}</h4>
                  <div className="sheet-chips">
                    {catHits.map((c) => (
                      <button key={c} className="chip" type="button"
                              onClick={() => { onClose(); router.push(`/katalogs?category=${c}`); }}>
                        {t(`cat.${c}`)}
                      </button>
                    ))}
                  </div>
                </section>
              )}

              <section>
                <h4>{all === null ? t("srch.searching") : t("srch.lotsN", { n: hits.length })}</h4>
                {hits.length === 0 && all !== null && (
                  <p className="note">{t("srch.nothing", { q: q.trim() })}</p>
                )}
                <div className="srch-hits">
                  {hits.map((a) => (
                    <button key={a.id} className="srch-hit" type="button"
                            onClick={() => { onClose(); router.push(`/auction/${a.id}`); }}>
                      <span className="ic" aria-hidden="true">
                        <Icon name={CAT_ICON[a.category] ?? "art"} />
                      </span>
                      <span className="t">
                        <b>{a.title}</b>
                        <small>{a.sku} · {t(`cat.${a.category}`)}</small>
                      </span>
                      <span className="am tnum">
                        {formatEur(a.currentPriceCents ?? a.startPriceCents ?? 0)}
                      </span>
                    </button>
                  ))}
                </div>
                <button className="btn btn-outline btn-block" type="button" onClick={() => go(q)}>
                  {t("srch.showAll", { q: q.trim() })}
                </button>
              </section>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
