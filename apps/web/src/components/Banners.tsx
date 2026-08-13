"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "./Icon";

/** Слайды баннеров. Добавить баннер = добавить строку сюда:
 *  точки, счётчик и автопрокрутка подхватятся сами.
 *  Темы: banner-green / banner-blue / banner-pink / banner-yellow / banner-dark */
type Deco = React.CSSProperties;
type Slide = {
  theme: string;
  href: string;
  count?: string;
  kicker: string;
  title: string;
  text: string;
  cta: string;
  decos: Deco[];
};

const SLIDES: Slide[] = [
  {
    theme: "banner-green", href: "/tiesraide",
    count: "Sākas pēc 4 h 12 min",
    kicker: "Piektdienas izsole", title: "Friday Signature Sale",
    text: "Pulksteņi, kameras un dizaina objekti no vienas īpašnieka kolekcijas. 180 loti, bez rezerves cenas.",
    cta: "Atgādināt man",
    decos: [
      { width: 420, height: 420, right: -110, top: -150 },
      { width: 180, height: 180, right: 120, bottom: -90 },
    ],
  },
  {
    theme: "banner-blue", href: "/register",
    kicker: "Jaunajiem lietotājiem", title: "Pirmajam lotam piegāde bez maksas",
    text: "Reģistrējies un solī — piegādi uz pakomātu sedzam mēs.",
    cta: "Reģistrēties",
    decos: [{ width: 380, height: 380, right: -90, bottom: -160 }],
  },
  {
    theme: "banner-yellow", href: "/pardod",
    kicker: "Pārdod ar mums", title: "Novērtējums 24 h laikā",
    text: "Atsūti foto — pasakām reālo tirgus cenu un paņemam lotu izsolei.",
    cta: "Uzzināt vairāk",
    decos: [{ width: 320, height: 320, left: -80, bottom: -140 }],
  },
  {
    theme: "banner-dark", href: "/pass",
    kicker: "Izsoli Pass", title: "Piegāde bez maksas visu gadu",
    text: "99 € gadā: pircēja komisija 15% 20% vietā un piegāde bez maksas.",
    cta: "Apskatīt Izsoli Pass",
    decos: [{ width: 360, height: 360, right: -100, top: -130 }],
  },
];

export function Banners() {
  const [i, setI] = useState(0);
  const [paused, setPaused] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const n = SLIDES.length;

  const go = useCallback((k: number) => setI(((k % n) + n) % n), [n]);

  useEffect(() => {
    if (paused || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const id = setInterval(() => setI((k) => (k + 1) % n), 6000);
    return () => clearInterval(id);
  }, [paused, n, i]);

  useEffect(() => {
    const onVis = () => setPaused(document.hidden);
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  const drag = useRef(0);

  return (
    <section className="section wrap" aria-label="Aktuālie piedāvājumi" style={{ paddingTop: 0 }}>
      <div
        className={`bslider${paused ? " is-paused" : ""}`}
        role="region" aria-roledescription="karuselis" aria-label="Piedāvājumi"
        ref={root}
        onMouseEnter={() => setPaused(true)}
        onMouseLeave={() => setPaused(false)}
        onFocus={() => setPaused(true)}
        onBlur={(e) => { if (!root.current?.contains(e.relatedTarget as Node)) setPaused(false); }}
        onKeyDown={(e) => {
          if (e.key === "ArrowLeft") go(i - 1);
          if (e.key === "ArrowRight") go(i + 1);
        }}
      >
        <div className="bviewport">
          <div
            className="btrack"
            style={{ transform: `translateX(${-i * 100}%)` }}
            onPointerDown={(e) => { drag.current = e.clientX; }}
            onPointerUp={(e) => {
              const dx = e.clientX - drag.current;
              if (Math.abs(dx) > 40) go(i + (dx < 0 ? 1 : -1));
            }}
          >
            {SLIDES.map((s, k) => (
              <div key={s.title} className="bslide" role="group" aria-roledescription="slaids"
                   aria-label={`${k + 1} no ${n}`} aria-hidden={k !== i}>
                <Link className={`banner ${s.theme}`} href={s.href} tabIndex={k === i ? undefined : -1}>
                  {s.decos.map((d, j) => (
                    <span key={j} className="deco" style={d} aria-hidden="true" />
                  ))}
                  {s.count && (
                    <span className="banner-count"><Icon name="timer" size={16} />{s.count}</span>
                  )}
                  <span className="kicker">{s.kicker}</span>
                  <h3>{s.title}</h3>
                  <p>{s.text}</p>
                  <span className="cta">{s.cta} <Icon name="arrow" /></span>
                </Link>
              </div>
            ))}
          </div>
        </div>

        <button className="bnav prev" type="button" aria-label="Iepriekšējais piedāvājums"
                onClick={() => go(i - 1)}><Icon name="arrow" /></button>
        <button className="bnav next" type="button" aria-label="Nākamais piedāvājums"
                onClick={() => go(i + 1)}><Icon name="arrow" /></button>

        <div className="bbar">
          <div className="bdots" role="tablist" aria-label="Piedāvājumi">
            {SLIDES.map((s, k) => (
              <button key={s.title} className="bdot" type="button" role="tab"
                      aria-current={k === i ? "true" : undefined}
                      aria-label={`Piedāvājums ${k + 1} no ${n}`}
                      onClick={() => go(k)}><i aria-hidden="true" /></button>
            ))}
          </div>
          <span className="bcount" aria-hidden="true">{i + 1} / {n}</span>
        </div>
      </div>
    </section>
  );
}
