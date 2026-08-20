"use client";

import { useCallback, useEffect, useState } from "react";
import { publicApi } from "@/lib/api";
import { PUBLIC_API_URL } from "@/lib/config";
import type { MyOrder, PublicAuction } from "@/lib/types";
import { alertStore } from "@/lib/ui";
import { watchStore } from "@/lib/watch";

/** Ставка солиста: публичный лот + моя позиция в нём. */
export type MyBidAuction = PublicAuction & { youLead: boolean; myMaxCents?: number | null };

export interface Me {
  id: string;
  email: string;
  alias: string;
  blocked: boolean;
  emailVerified?: boolean;
  marketingOptIn?: boolean;
}

export interface MyNotification {
  id: string;
  type: string;
  subject: string;
  body: string;
  createdAt: string;
}

export interface MyShipment {
  ref: string;
  itemTitle: string;
  provider: string;
  barcode: string;
  status: string;
  providerStatus: string | null;
  lastEvent: { code: string; at: string; description?: string } | null;
  createdAt: string;
}

export interface PickupInfo {
  pickup: Array<{ ref: string; itemTitle: string; pickupCode: string | null; pickupDeadlineAt: string | null; collecting: boolean }>;
  ticket: { number: number; status: string; queueAhead: number } | null;
}

/**
 * Все данные кабинета одним хуком: раздельные состояния, параллельные
 * запросы, один refresh. Ошибка любого запроса не валит остальные —
 * каждая вкладка живёт на своём кусочке.
 */
export function useAccountData() {
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [bids, setBids] = useState<MyBidAuction[]>([]);
  const [orders, setOrders] = useState<MyOrder[]>([]);
  const [fees, setFees] = useState<{ outstandingCents: number } | null>(null);
  const [pickup, setPickup] = useState<PickupInfo>({ pickup: [], ticket: null });
  const [shipments, setShipments] = useState<MyShipment[]>([]);
  const [notifications, setNotifications] = useState<MyNotification[]>([]);
  const [watchIds, setWatchIds] = useState<string[]>([]);
  const [alertIds, setAlertIds] = useState<string[]>([]);
  const [catalog, setCatalog] = useState<PublicAuction[]>([]);

  const refresh = useCallback(() => {
    if (!publicApi.hasSession) {
      setSignedIn(false);
      return;
    }
    setSignedIn(true);
    void publicApi
      .get<{ bidder: Me }>("/api/public/auth/me")
      .then((r) => setMe(r.bidder))
      .catch(() => undefined);
    void publicApi.get<{ bids: MyBidAuction[] }>("/api/public/me/bids").then((r) => setBids(r.bids)).catch(() => undefined);
    void publicApi.get<{ orders: MyOrder[] }>("/api/public/me/orders").then((r) => setOrders(r.orders)).catch(() => undefined);
    void publicApi.get<{ outstandingCents: number }>("/api/public/me/fees").then(setFees).catch(() => undefined);
    void publicApi.get<PickupInfo>("/api/public/me/pickup").then(setPickup).catch(() => undefined);
    void publicApi.get<{ shipments: MyShipment[] }>("/api/public/me/shipments").then((r) => setShipments(r.shipments)).catch(() => undefined);
    void publicApi
      .get<{ notifications: MyNotification[] }>("/api/public/me/notifications")
      .then((r) => setNotifications(r.notifications))
      .catch(() => undefined);
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  useEffect(() => {
    const sync = () => { setWatchIds(watchStore.list()); setAlertIds(alertStore.list()); };
    sync();
    const un1 = watchStore.subscribe(sync);
    const un2 = alertStore.subscribe(sync);
    return () => { un1(); un2(); };
  }, []);

  // Каталог — чтобы вёлмes и консоль могли показать карточки по id.
  useEffect(() => {
    void fetch(`${PUBLIC_API_URL}/api/public/auctions?limit=100`)
      .then((r) => r.json() as Promise<{ auctions: PublicAuction[] }>)
      .then((r) => setCatalog(r.auctions))
      .catch(() => undefined);
  }, []);

  return { signedIn, me, bids, orders, fees, pickup, shipments, notifications, watchIds, alertIds, catalog, refresh };
}

/** «pirms 2 min» — относительное время для ленты и выпадающего меню. */
export function relTime(
  iso: string,
  t: (k: string, v?: Record<string, string | number>) => string,
): string {
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.floor(ms / 60_000);
  if (min < 1) return t("kb.justNow");
  if (min < 60) return t("kb.agoMin", { n: min });
  const h = Math.floor(min / 60);
  if (h < 24) return t("kb.agoH", { n: h });
  const d = Math.floor(h / 24);
  if (d <= 30) return t("kb.agoD", { n: d });
  return t("kb.older");
}

/** Прочитанность уведомлений живёт в браузере: серверного флага нет, а
 *  бейдж в шапке должен гаснуть после просмотра. */
const SEEN_KEY = "izsoli_alerts_seen_v1";
export function alertsSeenAt(): number {
  if (typeof localStorage === "undefined") return 0;
  return Number(localStorage.getItem(SEEN_KEY) ?? 0);
}
export function markAlertsSeen(): void {
  try { localStorage.setItem(SEEN_KEY, String(Date.now())); } catch { /* приватный режим */ }
}
