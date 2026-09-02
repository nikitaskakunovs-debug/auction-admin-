"use client";

import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";

/**
 * Управляемое рекламное место Google AdSense.
 *
 * Площадка — аукцион, и реклама здесь гость на птичьих правах: никакого
 * Auto Ads по всему сайту, только явно поставленные слоты на одобренных
 * страницах. Этот компонент — единственный способ показать рекламу:
 * отдельных интеграций по шаблонам не заводить.
 *
 * Три предохранителя, каждый сам по себе гасит показ:
 *  1. NEXT_PUBLIC_ADSENSE_CLIENT не передан сборке — слот не существует.
 *  2. NEXT_PUBLIC_ADSENSE_SLOTS ≠ "1" — базовый скрипт стоит (верификация),
 *     но ни один слот не рисуется. Это выключатель первой фазы.
 *  3. Адрес из FORBIDDEN — конверсионные экраны: даже слот, поставленный
 *     туда по ошибке, не отрисуется.
 *
 * Согласие: сам блок появляется независимо от плашки, но персонализация
 * подчиняется Consent Mode/TCF-сигналам, которые выставляет наша плашка
 * cookie (см. gtmBootstrap в layout.tsx и consentUpdate в lib/track.ts) —
 * без согласия Google не имеет права на персонализированную рекламу.
 * Высота резервируется заранее (minHeight) — макет не прыгает (CLS).
 */

const CLIENT = /^ca-pub-\d{5,20}$/.test(process.env.NEXT_PUBLIC_ADSENSE_CLIENT ?? "")
  ? process.env.NEXT_PUBLIC_ADSENSE_CLIENT!
  : null;

/** Выключатель показа. Первая фаза AdSense — только верификация: флаг
 *  не выставлен, и ни одно место не активно. */
const SLOTS_ENABLED = process.env.NEXT_PUBLIC_ADSENSE_SLOTS === "1";

/** Куда рекламу не пускаем никогда: вход и регистрация, кабинет, корзина,
 *  оформление и оплата, торги и живые ставки. Список — предохранитель на
 *  уровне кода, а не договорённость. */
const FORBIDDEN: RegExp[] = [
  /^\/(login|register|forgot-password|reset-password|verify-email|pass)(\/|$)/,
  /^\/(account|kiosk|apmaksa|grozs|pasutijums|iznemsana|atteikties)(\/|$)/,
  /^\/(auction|tiesraide|automatiskais-solitajs)(\/|$)/,
];

export function AdSenseSlot({ slot, format = "auto", minHeight = 280, show = "all" }: {
  /** data-ad-slot конкретного места из кабинета AdSense. */
  slot: string;
  /** Формат AdSense (auto, horizontal, rectangle…). */
  format?: string;
  /** Заранее зарезервированная высота против скачков макета. */
  minHeight?: number;
  /** Видимость по устройствам. */
  show?: "all" | "desktop" | "mobile";
}) {
  const pathname = usePathname();
  const ref = useRef<HTMLModElement>(null);
  const allowed = CLIENT !== null && SLOTS_ENABLED && !FORBIDDEN.some((r) => r.test(pathname));

  useEffect(() => {
    if (!allowed) return;
    const el = ref.current;
    // Ровно один push на один контейнер: повторный рендер списка, StrictMode
    // и возврат по SPA-навигации второй инициализации не дают.
    if (!el || el.getAttribute("data-ad-status") !== null || el.dataset.izInit) return;
    el.dataset.izInit = "1";
    try {
      ((window as unknown as { adsbygoogle?: unknown[] }).adsbygoogle ??= []).push({});
    } catch {
      // Блокировщик рекламы — место просто останется пустым.
    }
  }, [allowed, pathname]);

  if (!allowed) return null;
  return (
    <ins
      ref={ref}
      className={`adsbygoogle ad-slot${show === "desktop" ? " ad-desktop" : show === "mobile" ? " ad-mobile" : ""}`}
      style={{ display: "block", minHeight, maxWidth: "100%", overflow: "hidden" }}
      data-ad-client={CLIENT}
      data-ad-slot={slot}
      data-ad-format={format}
      data-full-width-responsive="true"
    />
  );
}
