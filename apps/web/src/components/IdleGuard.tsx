"use client";

import { useEffect, useRef, useState } from "react";
import { publicApi } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { say } from "./Toast";

/**
 * Страж неактивности — только для вошедших.
 *
 * Полчаса без единого движения (отраслевая норма для площадок с деньгами:
 * OWASP советует 15–30 минут для «среднего» риска) — и человека сначала
 * спрашивают: поп-ап с минутным отсчётом, «Продолжить» или «Выйти».
 * Молчание = выход, тем же маршрутом, что и кнопка выхода в шапке:
 * с приватных страниц — на главную, с публичных — остаёшься на месте.
 *
 * Активность — общая на все вкладки: метка последнего движения живёт в
 * localStorage, и чтение каталога в соседней вкладке не даёт выкинуть из
 * аккаунта в этой. Гостя страж не трогает: у гостя нет сессии, терять нечего.
 */
const LAST_KEY = "izsoli_last_activity_v1";
const OUT_FLAG = "izsoli_idle_out_v1";
const IDLE_MS = 30 * 60_000;
const WARN_MS = 60_000;
const WRITE_EVERY_MS = 15_000;

export function IdleGuard() {
  const { t } = useT();
  const [on, setOn] = useState(false);
  const [deadline, setDeadline] = useState<number | null>(null);
  const [left, setLeft] = useState(WARN_MS / 1000);
  const lastWrite = useRef(0);

  const bump = () => {
    lastWrite.current = Date.now();
    try {
      localStorage.setItem(LAST_KEY, String(lastWrite.current));
    } catch {
      // без storage живём на внутривкладочной метке
    }
  };

  // Сессия: появилась — начинаем считать с этого момента, а не со старой
  // метки прошлого владельца браузера.
  useEffect(() => {
    const sync = () => {
      const has = publicApi.hasSession;
      setOn((was) => {
        if (!was && has) bump();
        return has;
      });
      if (!has) setDeadline(null);
    };
    sync();
    publicApi.listeners.add(sync);
    return () => void publicApi.listeners.delete(sync);
  }, []);

  // Объяснение после автоворота: страница уже перезагрузилась, тост — отсюда.
  useEffect(() => {
    try {
      if (sessionStorage.getItem(OUT_FLAG)) {
        sessionStorage.removeItem(OUT_FLAG);
        say(t("idle.done"));
      }
    } catch { /* приватный режим */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Слушаем движение — экономно: пишем метку не чаще раза в 15 секунд.
  // Пока открыт поп-ап, случайное движение мыши ответом не считается:
  // продолжение сессии — только осознанной кнопкой.
  useEffect(() => {
    if (!on || deadline !== null) return;
    const mark = () => {
      if (Date.now() - lastWrite.current >= WRITE_EVERY_MS) bump();
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") mark();
    };
    const evs = ["pointerdown", "pointermove", "keydown", "wheel", "scroll", "touchstart"] as const;
    for (const e of evs) window.addEventListener(e, mark, { passive: true });
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      for (const e of evs) window.removeEventListener(e, mark);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [on, deadline]);

  // Дозор: раз в пять секунд сверяемся с общей меткой. Активность в другой
  // вкладке закрывает поп-ап и здесь — человек очевидно на месте.
  useEffect(() => {
    if (!on) return;
    const read = (): number => {
      let v = lastWrite.current;
      try {
        const raw = Number(localStorage.getItem(LAST_KEY));
        if (Number.isFinite(raw) && raw > v) v = raw;
      } catch { /* ignore */ }
      return v;
    };
    const check = () => {
      const idleFor = Date.now() - read();
      if (idleFor < IDLE_MS) setDeadline((d) => (d !== null ? null : d));
      else setDeadline((d) => d ?? Date.now() + WARN_MS);
    };
    const timer = setInterval(check, 5_000);
    const onStorage = (e: StorageEvent) => {
      if (e.key === LAST_KEY) check();
    };
    window.addEventListener("storage", onStorage);
    return () => {
      clearInterval(timer);
      window.removeEventListener("storage", onStorage);
    };
  }, [on]);

  // Отсчёт в открытом поп-апе; ноль — выход.
  useEffect(() => {
    if (deadline === null) return;
    const tick = () => {
      const s = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      setLeft(s);
      if (s === 0) signOut();
    };
    tick();
    const timer = setInterval(tick, 500);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deadline]);

  const stay = () => {
    bump();
    setDeadline(null);
  };

  const signOut = () => {
    try {
      sessionStorage.setItem(OUT_FLAG, "1");
    } catch { /* ignore */ }
    publicApi.logout();
    // Та же политика, что у кнопки выхода: не уводить человека со страницы,
    // которая существует и для гостя.
    const p = window.location.pathname;
    if (p.startsWith("/account") || p.startsWith("/apmaksa")) window.location.href = "/";
    else window.location.reload();
  };

  if (!on || deadline === null) return null;

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-labelledby="idle-t">
      {/* Клик мимо окна — не ответ: фон без обработчика, решение только кнопками. */}
      <div className="modal-bd" />
      <div className="modal-card">
        <div className="modal-head">
          <div>
            <h3 id="idle-t">{t("idle.title")}</h3>
          </div>
        </div>
        <p className="note" role="timer" aria-live="polite">{t("idle.body", { s: left })}</p>
        <div style={{ display: "grid", gap: 8, marginTop: 16 }}>
          <button className="btn btn-primary btn-lg btn-block" type="button" autoFocus onClick={stay}>
            {t("idle.stay")}
          </button>
          <button className="btn btn-outline btn-block" type="button" onClick={signOut}>
            {t("idle.out")}
          </button>
        </div>
      </div>
    </div>
  );
}
