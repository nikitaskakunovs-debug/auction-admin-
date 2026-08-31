"use client";

import { publicApi } from "./api";

/**
 * Корзина — лоты, ждущие оплаты.
 *
 * В аукционе корзина наполняется не только нажатием «Pirkt tagad»: выигранные
 * торги попадают в неё сами. Поэтому счётчик живёт здесь, а не в компоненте
 * страницы: значок в шапке обязан показывать число на любой странице сайта,
 * а не только там, где список заказов уже загружен.
 *
 * Число кэшируется в браузере, чтобы значок не мигал пустым на каждом
 * переходе, и обновляется одним запросом при входе и после действий с
 * заказами. Суммы здесь не хранятся: их считает движок, и повторять их
 * в кэше — верный способ однажды показать неправду.
 */
const KEY = "izsoli_cart_n_v1";

type Fn = () => void;
const listeners = new Set<Fn>();
let count = 0;
let loaded = false;

function read(): number {
  if (typeof localStorage === "undefined") return 0;
  const n = Number(localStorage.getItem(KEY));
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function set(n: number): void {
  if (count === n && loaded) return;
  count = n;
  loaded = true;
  try {
    localStorage.setItem(KEY, String(n));
  } catch {
    /* приватный режим — значок просто не переживёт перезагрузку */
  }
  listeners.forEach((f) => f());
}

/** Записать число, уже известное вызывающей стороне.
 *
 *  Кабинет и корзина всё равно загружают список заказов — пусть они и
 *  сообщают правду, вместо того чтобы значок делал собственный запрос за
 *  тем же самым. */
export function setCartCount(n: number): void {
  set(n);
}

/** Спросить движок, сколько лотов ждёт оплаты. */
export function refreshCart(): void {
  if (!publicApi.hasSession) {
    set(0);
    return;
  }
  void publicApi
    .get<{ orders: Array<{ status: string }> }>("/api/public/me/orders")
    .then((r) => set(r.orders.filter((o) => o.status === "awaiting_payment").length))
    .catch(() => undefined);
}

/** Вход и выход: корзина принадлежит аккаунту, а не браузеру. */
let owner: string | null = null;
function onSession(): void {
  const next = publicApi.bidderId;
  if (next === owner && loaded) return;
  owner = next;
  if (next === null) {
    set(0);
    return;
  }
  refreshCart();
}

if (typeof window !== "undefined") {
  count = read();
  publicApi.listeners.add(onSession);
  onSession();
}

export const cartStore = {
  count: () => count,
  refresh: refreshCart,
  subscribe(fn: Fn) {
    listeners.add(fn);
    const onStorage = (e: StorageEvent) => {
      if (e.key === KEY) {
        count = read();
        fn();
      }
    };
    window.addEventListener("storage", onStorage);
    return () => {
      listeners.delete(fn);
      window.removeEventListener("storage", onStorage);
    };
  },
};
