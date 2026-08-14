"use client";

import { useEffect, useRef } from "react";

/** Общий список «брīdinājumi» — как WATCH/ALERTS в макете: отметил колокольчик
 *  на одной карточке, счётчик в шапке и все копии этой карточки обновились. */
const KEY = "izsoli_alerts_v1";
type Fn = () => void;
const listeners = new Set<Fn>();

function read(): string[] {
  if (typeof localStorage === "undefined") return [];
  try { return JSON.parse(localStorage.getItem(KEY) ?? "[]") as string[]; }
  catch { return []; }
}

export const alertStore = {
  has(id: string) { return read().includes(id); },
  list() { return read(); },
  toggle(id: string) {
    const cur = read();
    const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
    localStorage.setItem(KEY, JSON.stringify(next));
    listeners.forEach((f) => f());
  },
  subscribe(fn: Fn) {
    listeners.add(fn);
    const onStorage = (e: StorageEvent) => { if (e.key === KEY) fn(); };
    window.addEventListener("storage", onStorage);
    return () => { listeners.delete(fn); window.removeEventListener("storage", onStorage); };
  },
};

/** Горизонтальные рельсы макета: вертикальное колесо прокручивает вбок,
 *  мышью можно тащить, а клик после перетаскивания подавляется. */
export function useRail<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (el.scrollWidth <= el.clientWidth) return;
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      el.scrollLeft += e.deltaY;
      e.preventDefault();
    };
    let down = false, sx = 0, sl = 0, moved = false;
    const onDown = (e: PointerEvent) => {
      if (e.pointerType !== "mouse") return;
      down = true; moved = false; sx = e.clientX; sl = el.scrollLeft; el.style.cursor = "grabbing";
    };
    const onMove = (e: PointerEvent) => {
      if (!down) return;
      const dx = e.clientX - sx;
      if (Math.abs(dx) > 4) moved = true;
      el.scrollLeft = sl - dx;
    };
    const onUp = () => { down = false; el.style.cursor = ""; };
    const onClick = (e: MouseEvent) => {
      if (moved) { e.preventDefault(); e.stopPropagation(); moved = false; }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("pointerdown", onDown);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    el.addEventListener("click", onClick, true);
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("pointerdown", onDown);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      el.removeEventListener("click", onClick, true);
    };
  }, []);
  return ref;
}

/** Появление блоков при скролле — замена GSAP ScrollTrigger из макета.
 *  Вешает класс `in` на всё с data-reveal / data-lot / data-bars. */
export function useReveal() {
  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
      document.querySelectorAll("[data-reveal],[data-lot],[data-bars]").forEach((n) => n.classList.add("in"));
      return;
    }
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        e.target.classList.add("in");
        io.unobserve(e.target);
      }
    }, { rootMargin: "0px 0px -8% 0px", threshold: 0.05 });
    const scan = () => {
      document.querySelectorAll("[data-reveal]:not(.in),[data-lot]:not(.in),[data-bars]:not(.in)")
        .forEach((n) => io.observe(n));
    };
    scan();
    const mo = new MutationObserver(scan);
    mo.observe(document.body, { childList: true, subtree: true });
    return () => { io.disconnect(); mo.disconnect(); };
  }, []);
}

/** Пока на экране висит липкая панель действия, странице нужен запас снизу,
 *  иначе последний блок уезжает под неё. Класс на <body> — потому что
 *  padding-bottom задан там же. */
export function useStickyBar(active: boolean) {
  useEffect(() => {
    if (!active) return;
    document.body.classList.add("has-bidbar");
    return () => { document.body.classList.remove("has-bidbar"); };
  }, [active]);
}
