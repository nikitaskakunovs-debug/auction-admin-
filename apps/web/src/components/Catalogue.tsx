"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { CATEGORY_CODES } from "@/lib/categories";
import { CONDITION_CODES, conditionBadge } from "@/lib/conditions";
import { useT } from "@/lib/i18n";
import { formatEur, type FixedListing, type PublicAuction } from "@/lib/types";
import { useRail } from "@/lib/ui";
import { Icon } from "./Icon";
import { fixedToCard, LotCard, type CardLot } from "./LotCard";
import { say } from "./Toast";

/** Каталог утверждённого макета: коллекции, панель фильтров с поповерами,
 *  чипы активных фильтров, пустое состояние.
 *
 *  Коллекция — поле, которого пока нет в движке (появится позже);
 *  пока лот без `collection` попадает только в «Visi». */
type Row = CardLot & { collection?: string | null };

const COLLS: Array<[string, string, string]> = [
  ["all", "cg.collAll", "cg.collAllD"],
  ["highvalue", "coll.premium", "coll.premiumD"],
  ["overstock", "coll.stock", "coll.stockD"],
  ["estate", "coll.estate", "coll.estateD"],
  ["signature", "coll.signature", "coll.signatureD"],
];

const WHENS: Array<[string, string, number]> = [
  ["any", "when.any", Infinity],
  ["1h", "when.1h", 3_600],
  ["today", "when.today", 43_200],
  ["3d", "when.3d", 259_200],
];

/** Тип лота. Каталог, поиск и избранное годами грузили только аукционы,
 *  поэтому лоты «Купить сразу» не показывались нигде, кроме главной. */
const KINDS: Array<[string, string]> = [
  ["all", "cg.kindAll"], ["auction", "cg.kindAuction"], ["fixed", "buy.badge"],
];

const QUICK: Array<[string, string]> = [
  ["closing", "rail.closing"], ["nores", "rail.noReserve"], ["hot", "quick.hot"],
];

const SORTS: Array<[string, string]> = [
  ["ending", "sort.ending"], ["low", "sort.low"],
  ["high", "sort.high"], ["bids", "sort.bids"],
];

const PRICE_MAX = 1_000_000;   // 10 000 € в центах — верх ползунка
const PRICE_STEP = 10_000;     // 100 € — шаг
const PRICE_GAP = 10_000;      // минимальный зазор между ползунками

const price = (a: PublicAuction) => a.currentPriceCents ?? a.startPriceCents ?? 0;

export function Catalogue({
  auctions, listings = [], heading,
}: { auctions: Row[]; listings?: FixedListing[]; heading?: string }) {
  const { t } = useT();
  const qs = useSearchParams();
  const [coll, setColl] = useState("all");
  const [cat, setCat] = useState(qs.get("category") ?? "all");
  const [when, setWhen] = useState(qs.get("closing") === "1h" ? "1h" : "any");
  const [grades, setGrades] = useState<string[]>([]);
  const [quick, setQuick] = useState<string[]>(qs.get("reserve") === "no" ? ["nores"] : []);
  const [min, setMin] = useState(0);
  const [max, setMax] = useState(PRICE_MAX);
  const [sort, setSort] = useState("ending");
  const [q] = useState(qs.get("q") ?? "");
  const [kind, setKind] = useState(() => {
    const v = qs.get("type");
    return v === "fixed" || v === "auction" ? v : "all";
  });
  const [open, setOpen] = useState<string | null>(null);
  const [sheet, setSheet] = useState(false);
  const bar = useRef<HTMLDivElement>(null);
  const colls = useRail<HTMLDivElement>();
  const [now, setNow] = useState(() => Date.now());

  // Пересчитываем только когда время реально влияет на выдачу — как в макете.
  const timeMatters = sort === "ending" || quick.length > 0 || when !== "any";
  useEffect(() => {
    if (!timeMatters) return;
    const id = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(id);
  }, [timeMatters]);

  useEffect(() => {
    if (!sheet) return;
    document.body.classList.add("no-scroll");
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setSheet(false); };
    document.addEventListener("keydown", onKey);
    return () => {
      document.body.classList.remove("no-scroll");
      document.removeEventListener("keydown", onKey);
    };
  }, [sheet]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!bar.current?.contains(e.target as Node)) setOpen(null);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(null); };
    document.addEventListener("click", onDoc);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("click", onDoc); document.removeEventListener("keydown", onKey); };
  }, [open]);

  const catLabel = (c: string) => (c === "all" ? t("cg.allCats") : t(`cat.${c}`));

  const pool = useMemo<Row[]>(
    () => [...auctions, ...listings.map(fixedToCard)],
    [auctions, listings],
  );

  const rows = useMemo(() => {
    const left = (a: Row) => (new Date(a.endsAt).getTime() - now) / 1000;
    const window_ = WHENS.find(([id]) => id === when)![2];
    // Фильтры по времени осмысленны только для аукционов: у лота с
    // фиксированной ценой конца нет, и NaN тихо прошёл бы любое сравнение.
    const timeFiltered = when !== "any" || quick.includes("closing") || sort === "ending";
    const out = pool.filter((a) => {
      const isFixed = a.kind === "fixed";
      if (kind !== "all" && (kind === "fixed") !== isFixed) return false;
      if (isFixed && timeFiltered && sort !== "ending") return false;
      if (coll === "highvalue") { if (!a.retailCents || a.retailCents < 100_000) return false; }
      else if (coll !== "all" && a.collection !== coll) return false;
      if (cat !== "all" && a.category !== cat) return false;
      if (grades.length && !grades.includes(a.condition)) return false;
      const p = price(a);
      if (p < min || p > max) return false;
      if (!isFixed && left(a) > window_) return false;
      if (!isFixed && quick.includes("closing") && left(a) > 3_600) return false;
      if (quick.includes("nores") && a.hasReserve) return false;
      if (quick.includes("hot") && !a.hot) return false;
      if (q.trim() && !a.title.toLowerCase().includes(q.trim().toLowerCase())) return false;
      return true;
    });
    const cmp: Record<string, (a: Row, b: Row) => number> = {
      // Лоты без даты окончания идут в конец, иначе NaN рассыпает порядок.
      ending: (a, b) => (new Date(a.endsAt).getTime() || Infinity) - (new Date(b.endsAt).getTime() || Infinity),
      low: (a, b) => price(a) - price(b),
      high: (a, b) => price(b) - price(a),
      bids: (a, b) => b.bidCount - a.bidCount,
    };
    return [...out].sort(cmp[sort]);
  }, [pool, kind, coll, cat, grades, quick, when, min, max, q, sort, now]);

  type Chip = { key: string; label: string; drop: () => void };
  const active: Chip[] = [
    ...(kind !== "all"
      ? [{ key: "kind", label: t(KINDS.find(([k]) => k === kind)![1]), drop: () => setKind("all") }]
      : []),
    ...(coll !== "all"
      ? [{ key: "coll", label: t(COLLS.find(([c]) => c === coll)![1]), drop: () => setColl("all") }] : []),
    ...(cat !== "all" ? [{ key: "cat", label: catLabel(cat), drop: () => setCat("all") }] : []),
    ...(when !== "any"
      ? [{ key: "when", label: t(WHENS.find(([c]) => c === when)![1]), drop: () => setWhen("any") }] : []),
    ...grades.map((g) => ({
      key: `grade:${g}`, label: t("cg.gradeChip", { g: t(`cond.${g}`) }),
      drop: () => setGrades((x) => x.filter((y) => y !== g)),
    })),
    ...quick.map((k) => ({
      key: `quick:${k}`, label: t(QUICK.find(([c]) => c === k)![1]),
      drop: () => setQuick((x) => x.filter((y) => y !== k)),
    })),
    ...(min > 0 ? [{ key: "min", label: t("cg.from", { sum: formatEur(min) }), drop: () => setMin(0) }] : []),
    ...(max < PRICE_MAX ? [{ key: "max", label: t("cg.to", { sum: formatEur(max) }), drop: () => setMax(PRICE_MAX) }] : []),
  ];

  const clearAll = () => {
    setColl("all"); setCat("all"); setWhen("any"); setGrades([]); setQuick([]);
    setMin(0); setMax(PRICE_MAX); setSort("ending"); setOpen(null);
    say(t("cg.resetDone"));
  };

  const priceLabel = min === 0 && max === PRICE_MAX
    ? t("cg.priceAny")
    : `${formatEur(min)} – ${max === PRICE_MAX ? t("cg.priceAny") : formatEur(max)}`;

  const chipOn: Record<string, boolean> = {
    coll: coll !== "all", cat: cat !== "all", when: when !== "any",
    grade: grades.length > 0, price: min > 0 || max < PRICE_MAX,
    quick: quick.length > 0, sort: sort !== "ending",
  };

  const chip = (id: string, label: string, value: string, pop: React.ReactNode, right?: boolean) => (
    <div style={{ position: "relative" }}>
      <button className={`fchip${chipOn[id] ? " on" : ""}`} type="button" aria-expanded={open === id}
              onClick={() => setOpen(open === id ? null : id)}>
        {label} <span className="val">{value}</span><Icon name="chev" className="chev" size={14} />
      </button>
      {open === id && (
        <div className={`pop${right ? " right" : ""}`} role="listbox" aria-label={label}>{pop}</div>
      )}
    </div>
  );

  return (
    <section className="wrap" style={{ paddingTop: 24 }}>
      <nav className="crumbs" aria-label={t("nav.breadcrumb")}>
        <ol>
          <li><Link href="/">{t("nav.home")}</Link></li>
          <li aria-current="page">{t("nav.catalogue")}</li>
        </ol>
      </nav>

      <div className="page-head">
        <div>
          <h1 data-hero>{heading ?? t("cg.allActive")}</h1>
          <p className="cnt">{t("cg.lotsLive", { n: rows.length })}</p>
        </div>
        <Link className="link" href="/tiesraide">
          {t("cg.watchLive")} <Icon name="arrow" size={16} />
        </Link>
      </div>

      <div className="hrail" style={{ gap: 8, paddingBottom: 8 }} ref={colls}>
        {COLLS.map(([id, key]) => (
          <button key={id} className={`chip${coll === id ? " chip-dark" : ""}`} type="button"
                  aria-pressed={coll === id} style={{ flex: "0 0 auto" }}
                  onClick={() => setColl(id)}>{t(key)}</button>
        ))}
      </div>

      {/* Тип лота. Макет ссылается на «?type=fixed» с главной, но каталог
          этот параметр не читал и лоты «Купить сразу» не грузил вовсе. */}
      <div className="hrail" style={{ gap: 8, paddingBottom: 8 }}>
        {KINDS.map(([id, key]) => (
          <button key={id} className={`chip${kind === id ? " chip-dark" : ""}`} type="button"
                  aria-pressed={kind === id} style={{ flex: "0 0 auto" }}
                  onClick={() => setKind(id)}>{t(key)}</button>
        ))}
      </div>

      {/* На телефоне семь чипов не помещаются и рассыпаются в пять рядов —
          там показываем две кнопки, а сами фильтры живут в шторке. */}
      <div className="fbar-mob">
        <button className="fchip fchip-dark" type="button" aria-haspopup="dialog"
                onClick={() => setSheet(true)}>
          <Icon name="sliders" size={16} />{t("cg.filters")}
          {active.length > 0 && <span className="n">{active.length}</span>}
        </button>
        <button className={`fchip${chipOn.sort ? " on" : ""}`} type="button" aria-haspopup="dialog"
                onClick={() => setSheet(true)}>
          {t("cg.sort")} <span className="val">{t(SORTS.find(([c]) => c === sort)![1])}</span>
          <Icon name="chev" className="chev" size={14} />
        </button>
      </div>

      <div className="fbar" role="group" aria-label={t("cg.filters")} ref={bar}>
        <button className="fchip fchip-dark" type="button" aria-haspopup="dialog" aria-expanded={sheet}
                onClick={() => setSheet(true)}>
          <Icon name="sliders" size={16} />{t("cg.allFilters")}
          {active.length > 0 && <span className="n">{active.length}</span>}
        </button>

        {chip("coll", t("cg.collection"), t(COLLS.find(([c]) => c === coll)![1]),
          <>
            {COLLS.map(([id, key, subKey]) => (
              <button key={id} type="button" role="option" aria-selected={coll === id}
                      onClick={() => { setColl(id); setOpen(null); }}>
                <span className="nm">
                  <b style={{ display: "block", fontSize: 15 }}>{t(key)}</b>
                  <small style={{ color: "var(--text-3)", fontWeight: 600 }}>{t(subKey)}</small>
                </span>
              </button>
            ))}
          </>)}

        {chip("cat", t("he.category"), catLabel(cat),
          <>
            <button type="button" role="option" aria-selected={cat === "all"}
                    onClick={() => { setCat("all"); setOpen(null); }}>
              <span className="nm">{t("nav.allCategories")}</span>
              <span className="c">{auctions.length}</span>
            </button>
            {CATEGORY_CODES.map((c) => (
              <button key={c} type="button" role="option" aria-selected={cat === c}
                      onClick={() => { setCat(c); setOpen(null); }}>
                <span className="nm">{t(`cat.${c}`)}</span>
                <span className="c">{auctions.filter((a) => a.category === c).length}</span>
              </button>
            ))}
          </>)}

        {chip("when", t("cg.ends"), t(WHENS.find(([c]) => c === when)![1]),
          <>
            {WHENS.map(([id, key]) => (
              <button key={id} type="button" role="option" aria-selected={when === id}
                      onClick={() => { setWhen(id); setOpen(null); }}>
                <span className="nm">{t(key)}</span>
              </button>
            ))}
          </>)}

        {chip("grade", t("cg.condition"),
          grades.length ? grades.map((g) => t(`cond.${g}`)).join(" · ") : t("cg.conditionAny"),
          <>
            <b>{t("cg.condition")}</b>
            {CONDITION_CODES.map((g) => (
              <button key={g} type="button" aria-pressed={grades.includes(g)}
                      onClick={() => setGrades((x) => x.includes(g) ? x.filter((y) => y !== g) : [...x, g])}>
                <span className="g">{conditionBadge(g)}</span><span className="nm">{t(`cond.${g}`)}</span>
              </button>
            ))}
          </>)}

        {chip("price", t("buy.price"), priceLabel,
          <div className="rng">
            <p className="row">
              <span>{formatEur(min)}</span>
              <span>{max === PRICE_MAX ? t("cg.priceAny") : formatEur(max)}</span>
            </p>
            <label className="sr" htmlFor="pmin">{t("cg.priceFrom")}</label>
            <input id="pmin" type="range" min={0} max={PRICE_MAX} step={PRICE_STEP} value={min}
                   onChange={(e) => {
                     const v = +e.target.value;
                     setMin(v);
                     if (v > max - PRICE_GAP) setMax(Math.min(PRICE_MAX, v + PRICE_GAP));
                   }} />
            <label className="sr" htmlFor="pmax">{t("cg.priceTo")}</label>
            <input id="pmax" type="range" min={PRICE_STEP} max={PRICE_MAX} step={PRICE_STEP} value={max}
                   onChange={(e) => {
                     const v = +e.target.value;
                     setMax(v);
                     if (v < min + PRICE_GAP) setMin(Math.max(0, v - PRICE_GAP));
                   }} />
          </div>)}

        {chip("quick", t("cg.showOnly"),
          quick.length ? quick.map((k) => t(QUICK.find(([c]) => c === k)![1])).join(" · ") : t("cg.showAll"),
          <>
            <b>{t("cg.showOnly")}</b>
            {QUICK.map(([id, key]) => (
              <button key={id} type="button" aria-pressed={quick.includes(id)}
                      onClick={() => setQuick((x) => x.includes(id) ? x.filter((y) => y !== id) : [...x, id])}>
                <span className="nm">{t(key)}</span>
              </button>
            ))}
          </>)}

        <div className="sortwrap" style={{ position: "relative" }}>
          <button className={`fchip${chipOn.sort ? " on" : ""}`} type="button" aria-expanded={open === "sort"}
                  onClick={() => setOpen(open === "sort" ? null : "sort")}>
            {t("cg.sort")} <span className="val">{t(SORTS.find(([c]) => c === sort)![1])}</span>
            <Icon name="chev" className="chev" size={14} />
          </button>
          {open === "sort" && (
            <div className="pop right" role="listbox" aria-label={t("cg.sort")}>
              {SORTS.map(([id, key]) => (
                <button key={id} type="button" role="option" aria-selected={sort === id}
                        onClick={() => { setSort(id); setOpen(null); }}>
                  <span className="nm">{t(key)}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {active.length > 0 && (
        <div className="active-f">
          {active.map((f) => (
            <button key={f.key} className="af" type="button" onClick={f.drop}>
              {f.label}<b aria-hidden="true">×</b><span className="sr">{t("cg.dropFilter")}</span>
            </button>
          ))}
          <button className="clear-all" type="button" onClick={clearAll}>{t("cg.clearAll")}</button>
        </div>
      )}

      {sheet && (
        <div className="modal sheet" role="dialog" aria-modal="true" aria-labelledby="fsheet-t">
          <div className="modal-bd" onClick={() => setSheet(false)} />
          <div className="modal-card sheet-card">
            <div className="modal-head">
              <div>
                <span className="kicker">{t("cg.lotsN", { n: rows.length })}</span>
                <h3 id="fsheet-t">{t("cg.allFilters")}</h3>
              </div>
              <button className="modal-x" type="button" aria-label={t("nav.close")}
                      onClick={() => setSheet(false)}><Icon name="x" /></button>
            </div>

            <div className="sheet-body">
              <section>
                <h4>{t("cg.sort")}</h4>
                <div className="sheet-chips">
                  {SORTS.map(([id, key]) => (
                    <button key={id} className={`chip${sort === id ? " chip-dark" : ""}`} type="button"
                            aria-pressed={sort === id} onClick={() => setSort(id)}>{t(key)}</button>
                  ))}
                </div>
              </section>

              <section>
                <h4>{t("cg.collection")}</h4>
                <div className="sheet-chips">
                  {COLLS.map(([id, key]) => (
                    <button key={id} className={`chip${coll === id ? " chip-dark" : ""}`} type="button"
                            aria-pressed={coll === id} onClick={() => setColl(id)}>{t(key)}</button>
                  ))}
                </div>
              </section>

              <section>
                <h4>{t("cg.category")}</h4>
                <div className="sheet-chips">
                  <button className={`chip${cat === "all" ? " chip-dark" : ""}`} type="button"
                          aria-pressed={cat === "all"} onClick={() => setCat("all")}>{t("cg.categoryAll")}</button>
                  {CATEGORY_CODES.map((c) => (
                    <button key={c} className={`chip${cat === c ? " chip-dark" : ""}`} type="button"
                            aria-pressed={cat === c} onClick={() => setCat(c)}>
                      {t(`cat.${c}`)} <span className="c">{auctions.filter((a) => a.category === c).length}</span>
                    </button>
                  ))}
                </div>
              </section>

              <section>
                <h4>{t("cg.ends")}</h4>
                <div className="sheet-chips">
                  {WHENS.map(([id, key]) => (
                    <button key={id} className={`chip${when === id ? " chip-dark" : ""}`} type="button"
                            aria-pressed={when === id} onClick={() => setWhen(id)}>{t(key)}</button>
                  ))}
                </div>
              </section>

              <section>
                <h4>{t("cg.condition")}</h4>
                <div className="sheet-chips">
                  {CONDITION_CODES.map((g) => (
                    <button key={g} className={`chip${grades.includes(g) ? " chip-dark" : ""}`} type="button"
                            aria-pressed={grades.includes(g)}
                            onClick={() => setGrades((x) => x.includes(g) ? x.filter((y) => y !== g) : [...x, g])}>
                      {t(`cond.${g}`)}
                    </button>
                  ))}
                </div>
              </section>

              <section>
                <h4>{t("cg.price")}</h4>
                <div className="rng" style={{ padding: 0 }}>
                  <p className="row">
                    <span>{formatEur(min)}</span>
                    <span>{max === PRICE_MAX ? t("cg.priceAny") : formatEur(max)}</span>
                  </p>
                  <label className="sr" htmlFor="s-pmin">{t("cg.priceFrom")}</label>
                  <input id="s-pmin" type="range" min={0} max={PRICE_MAX} step={PRICE_STEP} value={min}
                         onChange={(e) => {
                           const v = +e.target.value; setMin(v);
                           if (v > max - PRICE_GAP) setMax(Math.min(PRICE_MAX, v + PRICE_GAP));
                         }} />
                  <label className="sr" htmlFor="s-pmax">{t("cg.priceTo")}</label>
                  <input id="s-pmax" type="range" min={PRICE_STEP} max={PRICE_MAX} step={PRICE_STEP} value={max}
                         onChange={(e) => {
                           const v = +e.target.value; setMax(v);
                           if (v < min + PRICE_GAP) setMin(Math.max(0, v - PRICE_GAP));
                         }} />
                </div>
              </section>

              <section>
                <h4>{t("cg.showOnly")}</h4>
                <div className="sheet-chips">
                  {QUICK.map(([id, key]) => (
                    <button key={id} className={`chip${quick.includes(id) ? " chip-dark" : ""}`} type="button"
                            aria-pressed={quick.includes(id)}
                            onClick={() => setQuick((x) => x.includes(id) ? x.filter((y) => y !== id) : [...x, id])}>
                      {t(key)}
                    </button>
                  ))}
                </div>
              </section>

            </div>

            <div className="sheet-foot">
              <button className="btn btn-outline" type="button" onClick={clearAll}>{t("cg.reset")}</button>
              <button className="btn btn-primary" type="button" onClick={() => setSheet(false)}>
                {t("cg.showN", { n: rows.length })}
              </button>
            </div>
          </div>
        </div>
      )}

      <p className="sr" role="status" aria-live="polite">{t("cg.matchN", { n: rows.length })}</p>

      {rows.length > 0 ? (
        <div className="results">
          {rows.map((a) => <LotCard key={a.id} lot={a} />)}
        </div>
      ) : (
        <div className="empty">
          <span className="ic" aria-hidden="true"><Icon name="search" /></span>
          <h3>{t("cg.nothingMatches")}</h3>
          <p>{t("cg.dropOne", { n: auctions.length })}</p>
          <button className="btn btn-primary" type="button" onClick={clearAll}>{t("cg.resetFilters")}</button>
        </div>
      )}

      <p className="note" style={{ marginTop: "var(--s5)" }}>
        Ieteiktā cena — ražotāja ieteiktā mazumtirdzniecības cena, nevis mūsu iepriekšējā cena.
        Uzvarot izsolē, cenai tiek pievienota pircēja komisija 10 % un PVN 21 %.
      </p>
    </section>
  );
}
