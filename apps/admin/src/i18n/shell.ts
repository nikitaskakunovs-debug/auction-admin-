import type { Entry } from "./types.js";

/** Admin shell: sidebar/drawer navigation, tab strip, ⌘K palette, confirm dialog. */
export const SHELL = {
  // ── Screen names (sidebar, mobile drawer, tab titles, palette "Go to") ─────
  "sh.nav.dashboard": { lv: "Pārskats", ru: "Обзор", en: "Dashboard" },
  "sh.nav.auctions": { lv: "Izsoles", ru: "Аукционы", en: "Auctions" },
  "sh.nav.listings": { lv: "Sludinājumi", ru: "Объявления", en: "Listings" },
  "sh.nav.inventory": { lv: "Krājumi", ru: "Товары", en: "Inventory" },
  "sh.nav.receiving": { lv: "Pieņemšana", ru: "Приёмка", en: "Receiving" },
  "sh.nav.orders": { lv: "Pasūtījumi", ru: "Заказы", en: "Orders" },
  "sh.nav.pickup": { lv: "Izsniegšana", ru: "Выдача", en: "Pickup" },
  "sh.nav.whstats": { lv: "Statistika", ru: "Статистика", en: "Stats" },
  "sh.nav.customers": { lv: "Solītāji", ru: "Участники", en: "Bidders" },
  "sh.nav.finance": { lv: "Finanses", ru: "Финансы", en: "Finance" },
  "sh.nav.content": { lv: "Saturs", ru: "Контент", en: "Content" },
  "sh.nav.settings": { lv: "Iestatījumi", ru: "Настройки", en: "Settings" },
  "sh.nav.notifications": { lv: "Paziņojumi", ru: "Уведомления", en: "Notifications" },
  "sh.nav.activity": { lv: "Aktivitāte", ru: "Активность", en: "Activity" },
  "sh.nav.security": { lv: "Drošība", ru: "Безопасность", en: "Security" },

  // ── Shell chrome ───────────────────────────────────────────────────────────
  "sh.menu": { lv: "Izvēlne", ru: "Меню", en: "Menu" },
  "sh.searchBtn": { lv: "Meklēt…", ru: "Поиск…", en: "Search…" },
  "sh.warehouseMode": { lv: "Noliktavas režīms", ru: "Режим склада", en: "Warehouse mode" },
  "sh.reportProblem": { lv: "Ziņot par problēmu", ru: "Сообщить о проблеме", en: "Report a problem" },
  "sh.signOut": { lv: "Iziet", ru: "Выйти", en: "Sign out" },
  "sh.pane": { lv: "PANELIS", ru: "ПАНЕЛЬ", en: "PANE" },
  "sh.focused": { lv: "FOKUSĀ", ru: "В ФОКУСЕ", en: "FOCUSED" },

  // ── Tab strip ──────────────────────────────────────────────────────────────
  "sh.split": { lv: "Dalīt", ru: "Разделить", en: "Split" },
  "sh.newTab": { lv: "Jauna cilne", ru: "Новая вкладка", en: "New tab" },
  "sh.closeTab": { lv: "Aizvērt cilni", ru: "Закрыть вкладку", en: "Close tab" },

  // ── ⌘K search palette ──────────────────────────────────────────────────────
  "sh.searchPlaceholder": { lv: "Meklēt lotes, pasūtījumus, solītājus…", ru: "Поиск лотов, заказов, участников…", en: "Search lots, orders, bidders…" },
  "sh.searchHint": { lv: "Ievadiet vismaz 2 rakstzīmes — diakritika nav obligāta (skruvgriezis atrod skrūvgriezi).", ru: "Введите минимум 2 символа — диакритика необязательна (skruvgriezis найдёт skrūvgriezis).", en: "Type at least 2 characters — diacritics optional (skruvgriezis finds skrūvgriezis)." },
  "sh.noMatches": { lv: "Nekas nav atrasts.", ru: "Ничего не найдено.", en: "Nothing matches." },
  "sh.metaScreen": { lv: "ekrāns", ru: "экран", en: "screen" },
  "sh.grp.lots": { lv: "Lotes", ru: "Лоты", en: "Lots" },
  "sh.grp.auctions": { lv: "Izsoles", ru: "Аукционы", en: "Auctions" },
  "sh.grp.orders": { lv: "Pasūtījumi", ru: "Заказы", en: "Orders" },
  "sh.grp.bidders": { lv: "Solītāji", ru: "Участники", en: "Bidders" },
  "sh.grp.goto": { lv: "Pāriet uz", ru: "Перейти к", en: "Go to" },

  // ── Confirm dialog / shared UI-kit defaults (ui.tsx) ───────────────────────
  "sh.confirm": { lv: "Apstiprināt", ru: "Подтвердить", en: "Confirm" },
  "sh.typeToConfirmPre": { lv: "Ierakstiet", ru: "Введите", en: "Type" },
  "sh.typeToConfirmPost": { lv: ", lai apstiprinātu", ru: ", чтобы подтвердить", en: " to confirm" },
  "sh.reasonAudit": { lv: "Iemesls (obligāts, nonāk audita žurnālā)", ru: "Причина (обязательно, попадает в журнал аудита)", en: "Reason (required, goes to the audit log)" },
  "sh.reasonWhy": { lv: "Kāpēc?", ru: "Почему?", en: "Why?" },
  "sh.ended": { lv: "beigusies", ru: "завершён", en: "ended" },
} satisfies Record<string, Entry>;
