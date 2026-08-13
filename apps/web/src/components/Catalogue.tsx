"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { CATEGORY_CODES } from "@/lib/categories";
import { CONDITION_CODES, conditionBadge } from "@/lib/conditions";
import { useT } from "@/lib/i18n";
import type { PublicAuction } from "@/lib/types";
import { Icon } from "./Icon";
import { LotCard, type CardLot } from "./LotCard";

/** Каталог утверждённого макета: коллекции, панель фильтров с поповерами,
 *  чипы активных фильтров, пустое состояние.
 *
 *  Коллекция — поле, которого пока нет в движке (появится позже);
 *  пока лот без `collection` попадает только в «Visi». */
type Row = CardLot & { collection?: string | null };

const COLLS: Array<[string, string, string]> = [
  ["all", "Visi", "Viss, kas šobrīd ir aktīvs"],
  ["highvalue", "Augstvērtīgie", "Veikala cena no 1 000 €"],
  ["overstock", "Noliktavu atlikumi", "Bez rezerves — viss tiek pārdots"],
  ["estate", "Mantojumi un dizains", "Viena īpašnieka kolekcijas"],
  ["signature", "Signature", "Atlasīti pulksteņi un objekti"],
];

const WHENS: Array<[string, string, number]> = [
  ["any", "Jebkurā laikā", Infinity],
  ["1h", "Tuvākajā stundā", 3_600],
  ["today", "Šodien", 43_200],
  ["3d", "Tuvākajās 3 dienās", 259_200],
];

const QUICK: Array<[string, string]> = [
  ["closing", "Drīz beidzas"], ["nores", "Bez rezerves"], ["hot", "Karstie loti"],
];

const SORTS: Array<[string, string]> = [
  ["ending", "Drīzāk beidzas"], ["low", "Cena: augoša"],
  ["high", "Cena: dilstoša"], ["bids", "Visvairāk solījumu"],
];

const price = (a: PublicAuction) => a.currentPriceCents ?? a.startPriceCents ?? 0;

export function Catalogue({ auctions }: { auctions: Row[] }) {
  const { t } = useT();
  const qs = useSearchParams();
  const [coll, setColl] = useState("all");
  const [cat, setCat] = useState(qs.get("category") ?? "all");
  const [when, setWhen] = useState(qs.get("closing") === "1h" ? "1h" : "any");
  const [grades, setGrades] = useState<string[]>([]);
  const [quick, setQuick] = useState<string[]>(qs.get("reserve") === "no" ? ["nores"] : []);
  const [min, setMin] = useState(0);
  const [max, setMax] = useState(1_000_000);
  const [sort, setSort] = useState("ending");
  const [q, setQ] = useState(qs.get("q") ?? "");
  const [open, setOpen] = useState<string | null>(null);
  const bar = useRef<HTMLDivElement>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(id);
  }, []);

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

  const catLabel = (c: string) => (c === "all" ? "Visas" : t(`cat.${c}`));

  const rows = useMemo(() => {
    const left = (a: Row) => (new Date(a.endsAt).getTime() - now) / 1000;
    const window_ = WHENS.find(([id]) => id === when)![2];
    const out = auctions.filter((a) => {
      if (coll === "highvalue") { if (!a.retailCents || a.retailCents < 100_000) return false; }
      else if (coll !== "all" && a.collection !== coll) return false;
      if (cat !== "all" && a.category !== cat) return false;
      if (grades.length && !grades.includes(a.condition)) return false;
      const p = price(a);
      if (p < min || p > max) return false;
      if (left(a) > window_) return false;
      if (quick.includes("closing") && left(a) > 3_600) return false;
      if (quick.includes("nores") && a.hasReserve) return false;
      if (quick.includes("hot") && a.bidCount < 20) return false;
      if (q.trim() && !a.title.toLowerCase().includes(q.trim().toLowerCase())) return false;
      return true;
    });
    const cmp: Record<string, (a: Row, b: Row) => number> = {
      ending: (a, b) => new Date(a.endsAt).getTime() - new Date(b.endsAt).getTime(),
      low: (a, b) => price(a) - price(b),
      high: (a, b) => price(b) - price(a),
      bids: (a, b) => b.bidCount - a.bidCount,
    };
    return [...out].sort(cmp[sort]);
  }, [auctions, coll, cat, grades, quick, when, min, max, q, sort, now]);

  const active: Array<[string, string, () => void]> = [
    ...(coll !== "all" ? [["coll", COLLS.find(([c]) => c === coll)![1], () => setColl("all")] as [string, string, () => void]] : []),
    ...(cat !== "all" ? [["cat", catLabel(cat), () => setCat("all")] as [string, string, () => void]] : []),
    ...(when !== "any" ? [["when", WHENS.find(([c]) => c === when)![1], () => setWhen("any")] as [string, string, () => void]] : []),
    ...grades.map((g) => ["grade", t(`cond.${g}`), () => setGrades((x) => x.filter((y) => y !== g))] as [string, string, () => void]),
    ...quick.map((k) => ["quick", QUICK.find(([c]) => c === k)![1], () => setQuick((x) => x.filter((y) => y !== k))] as [string, string, () => void]),
  ];

  const clearAll = () => {
    setColl("all"); setCat("all"); setWhen("any"); setGrades([]); setQuick([]);
    setMin(0); setMax(1_000_000); setQ("");
  };

  const chip = (id: string, label: string, value: string, pop: React.ReactNode, right?: boolean) => (
    <div style={{ position: "relative" }}>
      <button className="fchip" type="button" aria-expanded={open === id}
              onClick={() => setOpen(open === id ? null : id)}>
        {label} <span className="val">{value}</span><Icon name="chev" className="chev" size={14} />
      </button>
      {open === id && <div className={`pop${right ? " right" : ""}`}>{pop}</div>}
    </div>
  );

  return (
    <section className="wrap" style={{ paddingTop: 24 }}>
      <nav className="crumbs" aria-label="Navigācijas ceļš">
        <ol>
          <li><Link href="/">Sākums</Link></li>
          <li aria-current="page">Katalogs</li>
        </ol>
      </nav>

      <div className="page-head">
        <div>
          <h1 data-hero>Visi aktīvie loti</h1>
          <p className="cnt">{rows.length} loti · atjaunojas reāllaikā</p>
        </div>
        <Link className="link" href="/katalogs?status=live">
          Skatīt izsoles tiešraidē <Icon name="arrow" size={16} />
        </Link>
      </div>

      <div className="hrail" style={{ gap: 8, paddingBottom: 8 }}>
        {COLLS.map(([id, label]) => (
          <button key={id} className={`chip${coll === id ? " chip-dark" : ""}`} type="button"
                  aria-pressed={coll === id} style={{ flex: "0 0 auto" }}
                  onClick={() => setColl(id)}>{label}</button>
        ))}
      </div>

      <div className="fbar" role="group" aria-label="Filtri" ref={bar}>
        <button className="fchip fchip-dark" type="button" onClick={clearAll}>
          <Icon name="sliders" size={16} />Visi filtri
          {active.length > 0 && <span className="n">{active.length}</span>}
        </button>

        {chip("coll", "Kolekcija", COLLS.find(([c]) => c === coll)![1],
          <div role="listbox">
            {COLLS.map(([id, label, sub]) => (
              <button key={id} type="button" role="option" aria-selected={coll === id}
                      onClick={() => { setColl(id); setOpen(null); }}>
                <span className="nm">
                  <b style={{ display: "block", fontSize: 15 }}>{label}</b>
                  <small style={{ color: "var(--text-3)", fontWeight: 600 }}>{sub}</small>
                </span>
              </button>
            ))}
          </div>)}

        {chip("cat", "Kategorija", catLabel(cat),
          <div role="listbox">
            <button type="button" role="option" aria-selected={cat === "all"}
                    onClick={() => { setCat("all"); setOpen(null); }}>
              <span className="nm">Visas kategorijas</span>
            </button>
            {CATEGORY_CODES.map((c) => (
              <button key={c} type="button" role="option" aria-selected={cat === c}
                      onClick={() => { setCat(c); setOpen(null); }}>
                <span className="nm">{t(`cat.${c}`)}</span>
                <span className="c">{auctions.filter((a) => a.category === c).length}</span>
              </button>
            ))}
          </div>)}

        {chip("when", "Beidzas", WHENS.find(([c]) => c === when)![1],
          <div role="listbox">
            {WHENS.map(([id, label]) => (
              <button key={id} type="button" role="option" aria-selected={when === id}
                      onClick={() => { setWhen(id); setOpen(null); }}>
                <span className="nm">{label}</span>
              </button>
            ))}
          </div>)}

        {chip("grade", "Stāvoklis", grades.length ? `${grades.length}` : "Jebkurš",
          <>
            <b>Stāvoklis</b>
            {CONDITION_CODES.map((g) => (
              <button key={g} type="button" aria-pressed={grades.includes(g)}
                      onClick={() => setGrades((x) => x.includes(g) ? x.filter((y) => y !== g) : [...x, g])}>
                <span className="g">{conditionBadge(g)}</span><span className="nm">{t(`cond.${g}`)}</span>
              </button>
            ))}
          </>)}

        {chip("price", "Cena", min === 0 && max === 1_000_000 ? "Jebkura" : `${Math.round(min / 100)}–${Math.round(max / 100)} €`,
          <div className="rng">
            <p className="row"><span>{Math.round(min / 100)} €</span>
              <span>{max === 1_000_000 ? "Jebkura" : `${Math.round(max / 100)} €`}</span></p>
            <label className="sr" htmlFor="pmin">Cena no</label>
            <input id="pmin" type="range" min={0} max={1_000_000} step={10_000}
                   value={min} onChange={(e) => setMin(Math.min(+e.target.value, max))} />
            <label className="sr" htmlFor="pmax">Cena līdz</label>
            <input id="pmax" type="range" min={10_000} max={1_000_000} step={10_000}
                   value={max} onChange={(e) => setMax(Math.max(+e.target.value, min))} />
          </div>)}

        {chip("quick", "Rādīt tikai", quick.length ? `${quick.length}` : "Visu",
          <>
            <b>Rādīt tikai</b>
            {QUICK.map(([id, label]) => (
              <button key={id} type="button" aria-pressed={quick.includes(id)}
                      onClick={() => setQuick((x) => x.includes(id) ? x.filter((y) => y !== id) : [...x, id])}>
                <span className="nm">{label}</span>
              </button>
            ))}
          </>)}

        <div className="sortwrap">
          {chip("sort", "Kārtot", SORTS.find(([c]) => c === sort)![1],
            <div role="listbox">
              {SORTS.map(([id, label]) => (
                <button key={id} type="button" role="option" aria-selected={sort === id}
                        onClick={() => { setSort(id); setOpen(null); }}>
                  <span className="nm">{label}</span>
                </button>
              ))}
            </div>, true)}
        </div>
      </div>

      {active.length > 0 && (
        <div className="active-f">
          {active.map(([kind, label, drop], i) => (
            <button key={`${kind}${i}`} className="af" type="button" onClick={drop}>
              {label}<Icon name="x" size={14} />
            </button>
          ))}
          <button className="af-clear" type="button" onClick={clearAll}>Notīrīt visu</button>
        </div>
      )}

      <p className="sr" role="status" aria-live="polite">{rows.length} loti</p>

      {rows.length > 0 ? (
        <div className="results">
          {rows.map((a) => <LotCard key={a.id} lot={a} />)}
        </div>
      ) : (
        <div className="empty">
          <span className="ic" aria-hidden="true"><Icon name="search" /></span>
          <h3>Neviens lots neatbilst filtriem</h3>
          <p>Atlaid vienu vai divus filtrus — šobrīd aktīvi vairāk nekā {auctions.length} lotu visās kategorijās.</p>
          <button className="btn btn-primary" type="button" onClick={clearAll}>Atiestatīt filtrus</button>
        </div>
      )}

      <p className="note" style={{ marginTop: "var(--s5)" }}>
        Ieteiktā cena — ražotāja ieteiktā mazumtirdzniecības cena, nevis mūsu iepriekšējā cena.
        Uzvarot izsolē, cenai tiek pievienota pircēja komisija un PVN.
      </p>
    </section>
  );
}
