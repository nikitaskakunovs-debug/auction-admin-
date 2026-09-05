"use client";

import { useEffect, useState } from "react";
import { publicApi } from "./api";
import { myPromoCodes, type MyPromoCode } from "./cart";

/**
 * «Привилегии» вошедшего: неиспользованный код за регистрацию и личная
 * реферальная ссылка.
 *
 * Раньше код жил только в письме о подтверждении почты, а про «пригласи
 * друга» человек узнавал из рассылки — и только если на неё согласился.
 * Кто письмо закрыл или согласия не дал, не знал ни о том, ни о другом.
 * Теперь оба факта грузятся один раз на сессию и показываются там, где
 * человек и так смотрит: в меню аккаунта, в кабинете, в корзине.
 *
 * Один запрос на сессию, общий для всех мест: шапка, кабинет и корзина
 * подписываются на одно состояние, а не ходят в API по отдельности.
 */

export interface Referral {
  code: string;
  url: string;
  rewards: { signupCents: number; orderCents: number; friendPercent: number };
  stats: { invited: number; signupRewarded: number; orderRewarded: number; onHold: number };
}

export interface Perks {
  /** Личный процентный код, ещё действующий; null — нет или истёк. */
  welcome: MyPromoCode | null;
  referral: Referral | null;
  loaded: boolean;
}

const EMPTY: Perks = { welcome: null, referral: null, loaded: false };
let state: Perks = EMPTY;
let inflight: Promise<void> | null = null;
const subs = new Set<() => void>();
const emit = () => { for (const fn of subs) fn(); };

/** Код за регистрацию — процентный, личный, не просроченный. */
function pickWelcome(codes: MyPromoCode[]): MyPromoCode | null {
  const now = Date.now();
  return (
    codes.find(
      (c) =>
        c.type === "percent" &&
        (c.source === "welcome_auto" || c.source === "referral_referred") &&
        (!c.validTo || new Date(c.validTo).getTime() > now),
    ) ?? null
  );
}

export function loadPerks(force = false): Promise<void> {
  if (!publicApi.hasSession) {
    state = { ...EMPTY, loaded: true };
    emit();
    return Promise.resolve();
  }
  if (inflight && !force) return inflight;
  inflight = Promise.all([
    myPromoCodes().catch(() => ({ codes: [] as MyPromoCode[] })),
    publicApi.get<Referral>("/api/public/me/referral").catch(() => null),
  ])
    .then(([codes, referral]) => {
      state = { welcome: pickWelcome(codes.codes), referral, loaded: true };
      emit();
    })
    .finally(() => { inflight = null; });
  return inflight;
}

/** Сброс после покупки/использования кода — чтобы подсказка исчезла сразу. */
export function refreshPerks(): void {
  void loadPerks(true);
}

export function usePerks(): Perks {
  const [s, setS] = useState<Perks>(state);
  useEffect(() => {
    const fn = () => setS(state);
    subs.add(fn);
    void loadPerks();
    // Вход/выход — привилегии другого человека.
    const onSession = () => { void loadPerks(true); };
    publicApi.listeners.add(onSession);
    return () => { subs.delete(fn); publicApi.listeners.delete(onSession); };
  }, []);
  return s;
}

/** Сколько полных дней ещё действует код (0 — истекает сегодня). */
export function daysLeft(validTo: string | null): number | null {
  if (!validTo) return null;
  return Math.max(0, Math.ceil((new Date(validTo).getTime() - Date.now()) / 86_400_000));
}

/** Скопировать в буфер; false — браузер не дал. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** Ссылки «поделиться» для реферальной страницы. */
export function shareLinks(url: string, text: string): { whatsapp: string; telegram: string; email: string } {
  const full = `${text} ${url}`;
  return {
    whatsapp: `https://wa.me/?text=${encodeURIComponent(full)}`,
    telegram: `https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(text)}`,
    email: `mailto:?subject=${encodeURIComponent("izsoli.lv")}&body=${encodeURIComponent(full)}`,
  };
}
