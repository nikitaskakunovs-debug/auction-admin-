"use client";

import { useEffect, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import { translate, type Lang } from "@/lib/strings";

/* ═══ ОДНИ ЧАСЫ НА ВСЁ ПРИЛОЖЕНИЕ ═══
 *
 *  Раньше каждая карточка лота заводила собственный setInterval. На странице
 *  каталога это 48 таймеров, 48 отдельных перерисовок в секунду и 48 порций
 *  изменений в DOM — телефон этого не выдерживал.
 *
 *  Теперь тикает один таймер. Все подписчики получают время из него, React
 *  сводит их обновления в одну перерисовку, а на скрытой вкладке часы
 *  останавливаются совсем. */

let now = Date.now();
let timer: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<() => void>();

function tick(): void {
  now = Date.now();
  for (const fn of listeners) fn();
}

function start(): void {
  if (timer !== null || typeof document === "undefined") return;
  if (document.visibilityState === "hidden") return;
  tick();
  timer = setInterval(tick, 1000);
}

function stop(): void {
  if (timer === null) return;
  clearInterval(timer);
  timer = null;
}

if (typeof document !== "undefined") {
  // Вкладка в фоне — считать нечего: экрана всё равно нет.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") stop();
    else if (listeners.size > 0) start();
  });
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  start();
  return () => {
    listeners.delete(fn);
    if (listeners.size === 0) stop();
  };
}

/**
 * Текущее время, округлённое вниз до `intervalMs`.
 *
 *  Округление — это и есть экономия: подписчику с шагом 5 секунд четыре тика
 *  из пяти вернут ровно то же число, а React на неизменившемся состоянии
 *  перерисовку не делает.
 */
export function useNow(intervalMs = 1000): number {
  const snap = (): number => Math.floor(now / intervalMs) * intervalMs;
  return useSyncExternalStore(subscribe, snap, snap);
}

/** То же, но подписка живёт только пока элемент виден на экране.
 *  Карточки, уехавшие за пределы окна, перестают перерисовываться. */
export function useNowVisible(ref: RefObject<HTMLElement | null>): number {
  const [vis, setVis] = useState(() => now);
  const off = useRef<(() => void) | null>(null);

  useEffect(() => {
    const el = ref.current;
    // Без IntersectionObserver ведём себя как раньше — тикаем всегда.
    if (!el || typeof IntersectionObserver === "undefined") {
      return subscribe(() => setVis(now));
    }
    /* Запас по краям не нужен: при входе в окно подписка сразу берёт время из
     * общих часов, отставшего кадра человек не увидит. Зато без запаса
     * карточка за краем гарантированно молчит. */
    const io = new IntersectionObserver((entries) => {
      const e = entries[0];
      if (!e) return;
      if (e.isIntersecting && !off.current) {
        setVis(now);
        off.current = subscribe(() => setVis(now));
      } else if (!e.isIntersecting && off.current) {
        off.current();
        off.current = null;
      }
    });
    io.observe(el);
    return () => {
      io.disconnect();
      off.current?.();
      off.current = null;
    };
  }, [ref]);

  return vis;
}

/** Латышский формат: «3 dienas» → «1 diena 5 h» → «6:59:12» → «11:54» → «Beidzies».
 *  Часы и минуты показываем как таймер, чтобы последние минуты читались точно.
 *
 *  Язык обязателен: до этого функция всегда отвечала по-латышски, и на русском
 *  экране карточка писала «3 dienas» рядом с русской ценой. */
export function formatLeft(msLeft: number, lang: Lang = "lv"): string {
  const w = (k: string, v?: Record<string, string | number>) => translate(lang, k, v);
  if (msLeft <= 0) return w("cd.ended");
  const s = Math.floor(msLeft / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const p = (n: number) => (n < 10 ? `0${n}` : `${n}`);
  if (d >= 2) return w("cd.days", { n: d });
  if (d === 1) return w("cd.dayH", { h });
  if (h >= 1) return `${h}:${p(m)}:${p(sec)}`;
  return `${p(m)}:${p(sec)}`;
}

export function Countdown({ endsAt, danger, lang = "lv" }: { endsAt: string; danger?: boolean; lang?: Lang }) {
  const now = useNow();
  const left = new Date(endsAt).getTime() - now;
  // 10 минут — порог, после которого лот считается «горящим»
  const critical = danger !== false && left < 600_000 && left > 0;
  return (
    <time
      suppressHydrationWarning
      dateTime={endsAt}
      className={`tnum${critical ? " soon" : ""}`}
    >
      {formatLeft(left, lang)}
    </time>
  );
}
