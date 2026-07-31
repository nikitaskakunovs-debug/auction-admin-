import type { Entry } from "./types.js";

/** Filled by the Phase D translation pass — one module per screen area. */
export const DASHBOARD = {
  "dash.title": { lv: "Pārskats", ru: "Обзор", en: "Dashboard" },

  // ── KPI tiles ──────────────────────────────────────────────────────────────
  "dash.liveAuctions": { lv: "Aktīvās izsoles", ru: "Активные аукционы", en: "Live auctions" },
  "dash.endingSoon": { lv: "Drīz beigsies", ru: "Скоро завершатся", en: "Ending soon" },
  "dash.next2h": { lv: "tuvāko 2 stundu laikā", ru: "в ближайшие 2 часа", en: "next 2 hours" },
  "dash.scheduled": { lv: "Ieplānotas", ru: "Запланированы", en: "Scheduled" },
  "dash.awaitingPayment": { lv: "Gaida apmaksu", ru: "Ждут оплаты", en: "Awaiting payment" },
  "dash.gmv30d": { lv: "GMV · 30 dienas", ru: "GMV · 30 дней", en: "GMV · 30 days" },
  "dash.paidOrders": { lv: "apmaksāti pasūtījumi", ru: "оплаченных заказов", en: "paid orders" },
  "dash.bids24h": { lv: "Solījumi · 24 h", ru: "Ставки · 24 ч", en: "Bids · 24h" },

  // ── Live-now table ─────────────────────────────────────────────────────────
  "dash.liveNow": { lv: "Notiek tagad", ru: "Идут сейчас", en: "Live now" },
  "dash.noLive": { lv: "Nav aktīvu izsoļu.", ru: "Активных аукционов нет.", en: "No live auctions." },
  "dash.lot": { lv: "Lots", ru: "Лот", en: "Lot" },
  "dash.current": { lv: "Cena", ru: "Цена", en: "Current" },
  "dash.bids": { lv: "Solījumi", ru: "Ставки", en: "Bids" },
  "dash.reserve": { lv: "Rezerve", ru: "Резерв", en: "Reserve" },
  "dash.endsIn": { lv: "Beidzas pēc", ru: "До конца", en: "Ends in" },
  "dash.reserveMet": { lv: "sasniegta", ru: "достигнут", en: "met" },
  "dash.reserveNotMet": { lv: "nav sasniegta", ru: "не достигнут", en: "not met" },
  "dash.reserveNone": { lv: "nav", ru: "нет", en: "none" },
  "dash.ended": { lv: "beigusies", ru: "завершён", en: "ended" },

  // ── Warehouse pipeline ─────────────────────────────────────────────────────
  "dash.whPipeline": { lv: "Noliktavas plūsma", ru: "Этапы склада", en: "Warehouse pipeline" },
  "dash.state": { lv: "Posms", ru: "Этап", en: "State" },
  "dash.items": { lv: "Preces", ru: "Товары", en: "Items" },
} satisfies Record<string, Entry>;
