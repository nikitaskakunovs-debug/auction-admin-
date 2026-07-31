import type { Entry } from "./types.js";

/** Warehouse stats — team totals, per-day activity chart, per-worker table,
 * day timeline, and the CSV export. Tile/column names reuse rcv.received. */
export const WHSTATS = {
  // ── Header + period pickers ────────────────────────────────────────────────
  "ws.title": { lv: "Noliktavas statistika", ru: "Статистика склада", en: "Warehouse stats" },
  "ws.7d": { lv: "7 dienas", ru: "7 дней", en: "7 days" },
  "ws.30d": { lv: "30 dienas", ru: "30 дней", en: "30 days" },
  "ws.custom": { lv: "Pielāgots", ru: "Свой период", en: "Custom" },
  "ws.exportCsv": { lv: "Eksportēt CSV", ru: "Экспорт CSV", en: "Export CSV" },
  "ws.loadFailed": { lv: "Neizdevās ielādēt statistiku — pārbaudiet savienojumu un mēģiniet citu periodu.", ru: "Не удалось загрузить статистику — проверьте соединение и попробуйте другой период.", en: "Could not load stats — check your connection and try another period." },

  // ── Totals tiles + table columns ───────────────────────────────────────────
  "ws.putaways": { lv: "Novietošanas", ru: "Размещения", en: "Putaways" },
  "ws.putaway": { lv: "Novietošana", ru: "Размещение", en: "Putaway" },
  "ws.moved": { lv: "Pārvietots", ru: "Перемещено", en: "Moved" },
  "ws.graded": { lv: "Novērtēts", ru: "Оценено", en: "Graded" },
  "ws.picks": { lv: "Paņemšanas", ru: "Сборки", en: "Picks" },
  "ws.tickets": { lv: "Taloni", ru: "Талоны", en: "Tickets" },
  "ws.ticketsClosed": { lv: "Pabeigtie taloni", ru: "Закрытые талоны", en: "Tickets closed" },
  "ws.avgPick": { lv: "Vid. paņemšana", ru: "Ср. сборка", en: "Avg pick" },
  "ws.picksPerHour": { lv: "Paņemšanas/h", ru: "Сборки/ч", en: "Picks/hr" },
  "ws.breaks": { lv: "Pauzes", ru: "Перерывы", en: "Breaks" },
  "ws.worker": { lv: "Darbinieks", ru: "Работник", en: "Worker" },
  "ws.vsPrev": { lv: "pret iepr.", ru: "к пред.", en: "vs prev" },
  "ws.prev": { lv: "iepr.", ru: "пред.", en: "prev" },

  // ── Chart + per-worker table ───────────────────────────────────────────────
  "ws.activityByDay": { lv: "Aktivitāte pa dienām", ru: "Активность по дням", en: "Activity by day" },
  "ws.chartAria": { lv: "Noliktavas darbības pa dienām, grupētas pēc veida", ru: "Действия склада по дням, сгруппированные по типу", en: "Warehouse actions per day, stacked by type" },
  "ws.perWorker": { lv: "Pa darbiniekiem", ru: "По работникам", en: "Per worker" },
  "ws.sortHint": { lv: "klikšķis uz kolonnas kārto · klikšķis uz rindas atver dienas gaitu", ru: "клик по колонке — сортировка · клик по строке — хронология дня", en: "click a column to sort · click a row for the day timeline" },
  "ws.empty": { lv: "Šajā periodā nav noliktavas aktivitātes. Pieņemšana, novietošana, novērtēšana un paņemšanas šeit nonāk automātiski.", ru: "За этот период нет складской активности. Приёмка, размещение, оценка и сборки попадают сюда автоматически.", en: "No warehouse activity in this period. Receiving, putaways, grading, and picks all land here automatically." },

  // ── Worker day timeline ────────────────────────────────────────────────────
  "ws.actionsWord": { lv: "darbības", ru: "действий", en: "actions" },
  "ws.noActions": { lv: "Šajā dienā nav reģistrētu darbību.", ru: "В этот день нет записанных действий.", en: "No recorded actions on this day." },
  "ws.k.intake": { lv: "pieņemts", ru: "принято", en: "received" },
  "ws.k.putaway": { lv: "novietots", ru: "размещено", en: "putaway" },
  "ws.k.move": { lv: "pārvietots", ru: "перемещено", en: "moved" },
  "ws.k.restock": { lv: "atgriezts plauktā", ru: "возврат на полку", en: "restocked" },
  "ws.k.adjust": { lv: "noņemts", ru: "снято", en: "pulled" },
  "ws.k.handover": { lv: "izsniegts", ru: "выдано", en: "handover" },
  "ws.k.pick": { lv: "paņemts", ru: "взято", en: "pick" },
  "ws.k.grade": { lv: "novērtēts", ru: "оценено", en: "graded" },
  "ws.k.ticket_done": { lv: "talons pabeigts", ru: "талон закрыт", en: "ticket done" },
  "ws.k.status": { lv: "statuss", ru: "статус", en: "status" },
} satisfies Record<string, Entry>;
