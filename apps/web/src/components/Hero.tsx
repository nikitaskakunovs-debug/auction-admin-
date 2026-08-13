"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "./Icon";

/** Плавающие иконки фона героя — позиции из утверждённого макета
 *  (left%, top%, размер, длительность, задержка, наклон). */
const HERO_ICONS: Array<[string, number, number, number, number, number, number]> = [
  ["watch", 4, 16, 74, 15, 0, -8], ["camera", 13, 62, 88, 18, -3, 6],
  ["laptop", 22, 12, 62, 13, -6, 4], ["bike", 6, 86, 70, 17, -9, -5],
  ["audio", 31, 82, 58, 14, -2, 9], ["ring", 19, 40, 46, 16, -7, -3],
  ["lens", 40, 10, 52, 12, -4, 7], ["chair", 33, 30, 44, 19, -1, -6],
  ["tv", 62, 8, 66, 16, -5, 5], ["turntable", 71, 66, 92, 20, -8, -7],
  ["tools", 84, 18, 76, 14, -3, 8], ["rug", 93, 74, 64, 18, -6, -4],
  ["book", 77, 34, 48, 15, -9, 6], ["coffee", 60, 84, 70, 17, -2, -8],
  ["card", 88, 46, 44, 13, -5, 5], ["amp", 50, 92, 56, 19, -7, 3],
];

const WORDS = ["austiņām", "pulksteni", "kameru", "velosipēdu", "objektīvu", "krēslu", "gredzenu"];

/** Списки выпадашек поиска: подпись, иконка, счётчик, значение для каталога. */
const CATS: Array<[string, string, string, string]> = [
  ["Visas kategorijas", "grid", "", ""],
  ["Pulksteņi", "watch", "", "jewellery_watches"],
  ["Elektronika", "tv", "", "electronics"],
  ["Māksla", "art", "", "art_antiques"],
  ["Kameras", "camera", "", "electronics"],
  ["Audio", "audio", "", "electronics"],
  ["Mājai", "home", "", "home_garden"],
  ["Instrumenti", "tools", "", "tools"],
  ["Kolekcijas", "card", "", "other"],
  ["Velo un tūrisms", "bike", "", "sports_outdoors"],
];

const WHEN: Array<[string, string, string, string]> = [
  ["Jebkurā laikā", "timer", "", ""],
  ["Tuvākajā stundā", "bolt", "", "1h"],
  ["Šodien", "timer", "", "1d"],
  ["Tuvākajās 3 dienās", "timer", "", "3d"],
];

function Dropdown({
  list, value, onPick, right, onClose,
}: {
  list: Array<[string, string, string, string]>;
  value: string;
  onPick: (row: [string, string, string, string]) => void;
  right?: boolean;
  onClose: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    box.current?.querySelector("button")?.focus();
    const onScroll = () => onClose();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [onClose]);
  return (
    <div className={`dd${right ? " right" : ""}`} role="listbox" ref={box}>
      {list.map((row) => (
        <button
          key={row[0]}
          type="button"
          role="option"
          aria-selected={row[0] === value}
          onClick={(e) => { e.stopPropagation(); onPick(row); }}
        >
          <span className="ic" aria-hidden="true"><Icon name={row[1]} /></span>
          <span className="nm">{row[0]}</span>
          {row[2] && <span className="cnt">{row[2]}</span>}
        </button>
      ))}
    </div>
  );
}

export function Hero() {
  const router = useRouter();
  const [word, setWord] = useState(0);
  const [prev, setPrev] = useState(-1);
  const [dd, setDd] = useState<"cat" | "when" | null>(null);
  const [cat, setCat] = useState(CATS[0]!);
  const [when, setWhen] = useState(WHEN[0]!);
  const [kw, setKw] = useState("");
  const [drawn, setDrawn] = useState(false);

  // Маркер под «€1.» рисуется один раз после появления героя.
  useEffect(() => {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) { setDrawn(true); return; }
    const t = setTimeout(() => setDrawn(true), 720);
    return () => clearTimeout(t);
  }, []);

  // Кинетическая подмена последнего слова.
  useEffect(() => {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const id = setInterval(() => {
      if (document.hidden) return;
      setWord((i) => { setPrev(i); return (i + 1) % WORDS.length; });
    }, 2400);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (!dd) return;
    const onDoc = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest("[data-dd]")) setDd(null);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setDd(null); };
    document.addEventListener("click", onDoc);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("click", onDoc); document.removeEventListener("keydown", onKey); };
  }, [dd]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const p = new URLSearchParams();
    if (kw.trim()) p.set("q", kw.trim());
    if (cat[3]) p.set("category", cat[3]);
    if (when[3]) p.set("closing", when[3]);
    router.push(`/katalogs${p.toString() ? `?${p}` : ""}`);
  };

  return (
    <section className="hero">
      <span className="blob blob-1" aria-hidden="true" />
      <div className="hero-ico" aria-hidden="true">
        {HERO_ICONS.map(([name, l, t, w, dur, delay, rot]) => (
          <span
            key={name}
            className="hi"
            style={{
              left: `${l}%`, top: `${t}%`,
              ["--w" as string]: `${w}px`,
              ["--dur" as string]: `${dur}s`,
              ["--delay" as string]: `${delay}s`,
              ["--rot" as string]: `${rot}deg`,
            } as React.CSSProperties}
          ><Icon name={name} /></span>
        ))}
      </div>
      <span className="blob blob-2" aria-hidden="true" />

      <div className="wrap"><div className="hero-inner">
        <h1 className="kin" data-hero>
          <span className="l1">
            Sāc ar <span className={`hl${drawn ? " drawn" : " pre"}`} data-hl>€1.</span>
          </span>
          <span className="l2">
            Beidz ar{" "}
            <span className="rot" data-rot>
              {WORDS.map((w, i) => (
                <i key={w} data-st={i === word ? "on" : i === prev ? "prev" : "next"}
                   aria-hidden={i === word ? "false" : "true"}>{w}</i>
              ))}
            </span>
          </span>
        </h1>

        <form className="finder" role="search" aria-label="Atrast lotu" data-finder onSubmit={submit}>
          <button
            type="button" className="fi" data-dd="cat"
            aria-expanded={dd === "cat"} aria-haspopup="listbox"
            onClick={(e) => { e.stopPropagation(); setDd(dd === "cat" ? null : "cat"); }}
          >
            <span className="ic" aria-hidden="true"><Icon name="grid" /></span>
            <span className="t"><span className="lab">Kategorija</span><span className="v">{cat[0]}</span></span>
            <Icon name="chev" className="chev" size={18} />
            {dd === "cat" && (
              <Dropdown list={CATS} value={cat[0]} onClose={() => setDd(null)}
                        onPick={(r) => { setCat(r); setDd(null); }} />
            )}
          </button>

          <span className="fi-div" aria-hidden="true" />

          <label className="fi">
            <span className="ic" aria-hidden="true"><Icon name="search" /></span>
            <span className="t">
              <span className="lab" id="kw-lab">Atslēgvārds</span>
              <input className="v" id="kw" placeholder="piem. niršanas pulkstenis" aria-labelledby="kw-lab"
                     value={kw} onChange={(e) => setKw(e.target.value)} />
            </span>
          </label>

          <span className="fi-div" aria-hidden="true" />

          <button
            type="button" className="fi" data-dd="when"
            aria-expanded={dd === "when"} aria-haspopup="listbox"
            onClick={(e) => { e.stopPropagation(); setDd(dd === "when" ? null : "when"); }}
          >
            <span className="ic" aria-hidden="true"><Icon name="timer" /></span>
            <span className="t"><span className="lab">Beidzas</span><span className="v">{when[0]}</span></span>
            <Icon name="chev" className="chev" size={18} />
            {dd === "when" && (
              <Dropdown list={WHEN} value={when[0]} right onClose={() => setDd(null)}
                        onPick={(r) => { setWhen(r); setDd(null); }} />
            )}
          </button>

          <button className="btn btn-primary btn-lg" type="submit">
            <Icon name="search" size={20} />Meklēt
          </button>
        </form>
      </div></div>
    </section>
  );
}
