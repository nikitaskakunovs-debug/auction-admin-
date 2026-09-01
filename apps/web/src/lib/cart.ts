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
const VISITOR_KEY = "izsoli_visitor_v1";

/** Идентификатор браузера — тот же, что сшивает согласие на cookie. По нему
 *  сервер хранит гостевую корзину и сливает её с корзиной аккаунта после
 *  входа. */
export function visitorId(): string {
  try {
    let v = localStorage.getItem(VISITOR_KEY);
    if (!v) {
      v = crypto.randomUUID();
      localStorage.setItem(VISITOR_KEY, v);
    }
    return v;
  } catch {
    return "";
  }
}

/** Лот корзины, как его отдаёт сервер: суммы посчитаны движком. */
export interface CartItem {
  listingId: string;
  sku: string;
  title: string;
  category: string | null;
  photo: string | null;
  marketCode: string;
  quantity: number;
  currency: string;
  hammerCents: number;
  premiumCents: number;
  vatCents: number;
  vatRateBp: number;
  totalCents: number;
  available: boolean;
  priceChanged: boolean;
  /** Живой остаток лота за вычетом чужих резервов. */
  stock: number;
  /** До какого момента (мс) единица придержана за этим человеком. */
  reservedUntil: number | null;
}

export interface CartView {
  items: CartItem[];
  count: number;
  totalCents: number;
}

const vq = () => {
  const v = visitorId();
  return v ? `?visitor_id=${encodeURIComponent(v)}` : "";
};

export function cartList(): Promise<CartView> {
  return publicApi.get<CartView>(`/api/public/cart${vq()}`);
}

export function cartAdd(listingId: string): Promise<{ ok: boolean; added: boolean; count: number }> {
  return publicApi.post(`/api/public/cart`, { listing_id: listingId, visitor_id: visitorId() || undefined });
}

export function cartRemove(listingId: string): Promise<{ ok: boolean; count: number }> {
  return publicApi.request(`DELETE`, `/api/public/cart/${encodeURIComponent(listingId)}${vq()}`);
}

export interface CartCheckoutResult {
  ok: boolean;
  code?: string;
  orders: Array<{ ref: string; totalCents: number; listingId: string }>;
  unavailable?: Array<{ listingId: string; title: string }>;
}

export function cartCheckout(listingIds?: string[]): Promise<CartCheckoutResult> {
  return publicApi.post(`/api/public/cart/checkout`, {
    visitor_id: visitorId() || undefined,
    ...(listingIds && listingIds.length > 0 ? { listing_ids: listingIds } : {}),
  });
}

export interface CartReserveResult {
  ok: boolean;
  reserved: Array<{ listingId: string; until: number }>;
  missed: string[];
  reservedUntil: number | null;
}

/** Начало оформления: придержать по одной единице каждого лота на 10 минут. */
export function cartCheckoutStart(): Promise<CartReserveResult> {
  return publicApi.post(`/api/public/cart/checkout-start`, { visitor_id: visitorId() || undefined });
}

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

/** Значок складывается из двух частей: заказы, ждущие оплаты (только у
 *  вошедших), и отложенные лоты гостевой корзины (у всех). */
let ordersN = 0;
let itemsN = 0;
const publish = () => set(ordersN + itemsN);

/** Число неоплаченных заказов — сообщают экраны, которые их уже загрузили. */
export function setCartCount(n: number): void {
  ordersN = n;
  publish();
}

/** Число отложенных лотов — сообщает тот, кто загрузил корзину. */
export function setCartItemsCount(n: number): void {
  itemsN = n;
  publish();
}

/** Спросить движок, сколько лотов ждёт человека. */
export function refreshCart(): void {
  if (!visitorId() && !publicApi.hasSession) {
    set(0);
    return;
  }
  void cartList()
    .then((c) => { itemsN = c.count; publish(); })
    .catch(() => undefined);
  if (!publicApi.hasSession) {
    ordersN = 0;
    publish();
    return;
  }
  void publicApi
    .get<{ orders: Array<{ status: string }> }>("/api/public/me/orders")
    .then((r) => { ordersN = r.orders.filter((o) => o.status === "awaiting_payment").length; publish(); })
    .catch(() => undefined);
}

/** Вход и выход: корзина принадлежит аккаунту, а не браузеру. */
let owner: string | null = null;
function onSession(): void {
  const next = publicApi.bidderId;
  if (next === owner && loaded) return;
  owner = next;
  // После выхода гостевая корзина не очищается: человек мог отложить лоты
  // до входа, и терять их при выходе нечестно. Правду знает сервер.
  ordersN = 0;
  itemsN = 0;
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
