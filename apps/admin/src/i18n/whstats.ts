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

  // ── R3 — "Kas pārdodas, kas stāv" tab ──────────────────────────────────────
  // Sell-through, category health, auction outcomes, shelf ageing. Column and
  // tile names reuse inv.category / c.title / c.total where they already fit.
  "whs.st.tabWork": { lv: "Darbs noliktavā", ru: "Работа склада", en: "Warehouse work" },
  "whs.st.tab": { lv: "Kas pārdodas", ru: "Что продаётся", en: "What sells" },
  "whs.st.90d": { lv: "90 dienas", ru: "90 дней", en: "90 days" },
  "whs.st.12m": { lv: "12 mēneši", ru: "12 месяцев", en: "12 months" },
  "whs.st.forbidden": { lv: "Šī sadaļa prasa atskaišu tiesības (reports.view). Palūdziet tās vadītājam.", ru: "Для этого раздела нужны права на отчёты (reports.view). Попросите их у руководителя.", en: "This section needs report access (reports.view). Ask your manager for it." },

  // Tiles
  "whs.st.soldInPeriod": { lv: "Pārdots periodā", ru: "Продано за период", en: "Sold in period" },
  "whs.st.offered": { lv: "Izliktas", ru: "Выставлено", en: "Offered" },
  "whs.st.soldFromOffered": { lv: "No izliktajām pārdotas", ru: "Из выставленного продано", en: "Sold of those offered" },
  "whs.st.revenue": { lv: "Apgrozījums", ru: "Оборот", en: "Revenue" },
  "whs.st.ofOffered": { lv: "no izliktajām", ru: "из выставленного", en: "of those offered" },

  // Category bar chart
  "whs.st.chartTitle": { lv: "Cik daudz aiziet — pa kategorijām", ru: "Сколько уходит — по категориям", en: "How much sells — by category" },
  "whs.st.chartAria": { lv: "Sell-through procenti pa kategorijām, joslu diagramma", ru: "Проценты sell-through по категориям, столбчатая диаграмма", en: "Sell-through percentage by category, bar chart" },
  "whs.st.healthGood": { lv: "labi (70%+)", ru: "хорошо (70%+)", en: "good (70%+)" },
  "whs.st.healthWarn": { lv: "viduvēji (40–69%)", ru: "средне (40–69%)", en: "middling (40–69%)" },
  "whs.st.healthBad": { lv: "vāji (zem 40%)", ru: "слабо (ниже 40%)", en: "weak (below 40%)" },
  "whs.st.noOffers": { lv: "šajā periodā nekas nebija izlikts", ru: "в этот период ничего не выставлялось", en: "nothing was offered in this period" },
  "whs.st.windowNote": { lv: "Pašā perioda beigās izliktajām precēm vēl nav bijis laika pārdoties — īsā periodā procents vienmēr izskatās zemāks.", ru: "Товару, выставленному в самом конце периода, ещё не хватило времени продаться — на коротком периоде процент всегда ниже.", en: "Lots offered right at the end of the period have had less time to sell — a short period always shows a lower percentage." },

  // Category table
  "whs.st.byCategory": { lv: "Pa kategorijām", ru: "По категориям", en: "By category" },
  "whs.st.thSold": { lv: "Pārdotas", ru: "Продано", en: "Sold" },
  "whs.st.thSellThrough": { lv: "Sell-through %", ru: "Sell-through %", en: "Sell-through %" },
  "whs.st.thAvgDays": { lv: "Vidēji dienas", ru: "В среднем дней", en: "Avg days" },
  "whs.st.thAvgPrice": { lv: "Vidējā cena", ru: "Средняя цена", en: "Avg price" },
  "whs.st.thProfit": { lv: "Peļņa", ru: "Прибыль", en: "Profit" },
  "whs.st.noCost": { lv: "nav datu", ru: "нет данных", en: "no data" },
  "whs.st.noCostNote": { lv: "bez datiem: {n}", ru: "без данных: {n}", en: "no cost data: {n}" },
  "whs.st.catEmpty": { lv: "Šajā periodā nekas nav ne izlikts, ne pārdots. Pamēģiniet garāku periodu.", ru: "За этот период ничего не выставлено и не продано. Попробуйте период подлиннее.", en: "Nothing was offered or sold in this period. Try a longer period." },

  // Auction outcomes
  "whs.st.outcomesTitle": { lv: "Kā beidzās izsoles", ru: "Чем закончились аукционы", en: "How auctions ended" },
  "whs.st.outcomeEnded": { lv: "Beigušās izsoles", ru: "Завершилось аукционов", en: "Auctions ended" },
  "whs.st.outcomeWon": { lv: "Nosolīts", ru: "Продано с торгов", en: "Won" },
  "whs.st.outcomeNoBids": { lv: "Neviens nesolīja", ru: "Никто не торговался", en: "No bids" },
  "whs.st.outcomeReserve": { lv: "Rezerve nav sasniegta", ru: "Резерв не достигнут", en: "Reserve not met" },
  "whs.st.outcomeCancelled": { lv: "Atceltās izsoles ({n}) šeit nav skaitītas.", ru: "Отменённые аукционы ({n}) здесь не учтены.", en: "Cancelled runs ({n}) are not counted here." },
  "whs.st.outcomesEmpty": { lv: "Šajā periodā neviena izsole nebeidzās.", ru: "За этот период не завершился ни один аукцион.", en: "No auction ended in this period." },

  // Shelf ageing
  "whs.st.agingTitle": { lv: "Cik ilgi krājumi stāv", ru: "Сколько товар лежит на полке", en: "How long stock sits" },
  "whs.st.age0_30": { lv: "līdz 30 d.", ru: "до 30 дн.", en: "up to 30 d" },
  "whs.st.age31_60": { lv: "31–60 d.", ru: "31–60 дн.", en: "31–60 d" },
  "whs.st.age61_90": { lv: "61–90 d.", ru: "61–90 дн.", en: "61–90 d" },
  "whs.st.age90plus": { lv: "90+ d.", ru: "90+ дн.", en: "90+ d" },
  "whs.st.units": { lv: "gab.", ru: "шт.", en: "units" },
  "whs.st.agingNote": { lv: "Rādīts uz šodienu — neatkarīgi no izvēlētā perioda.", ru: "Показано на сегодня — независимо от выбранного периода.", en: "Shown as of today — regardless of the period picked." },
  "whs.st.agingEmpty": { lv: "Plauktos pašlaik nav preču.", ru: "На полках сейчас ничего нет.", en: "Nothing on the shelves right now." },

  // Sitting longest
  "whs.st.sittingTitle": { lv: "Stāv visilgāk", ru: "Лежит дольше всего", en: "Sitting longest" },
  "whs.st.thDaysOnShelf": { lv: "Dienas plauktā", ru: "Дней на полке", en: "Days on shelf" },
  "whs.st.timesListed": { lv: "{n}× izlikta", ru: "выставляли {n}×", en: "listed {n}×" },
  "whs.st.sittingHint": { lv: "klikšķis uz rindas atver preci", ru: "клик по строке открывает товар", en: "click a row to open the item" },
  "whs.st.sittingEmpty": { lv: "Plauktos pašlaik nav preču, kas stāvētu.", ru: "На полках сейчас нет залежавшегося товара.", en: "Nothing is sitting on the shelves right now." },

  // Server-stated basis footnote
  "whs.st.basisCounted": { lv: "Kā skaitīts:", ru: "Как считалось:", en: "How this is counted:" },
  "whs.st.basisExcluded": { lv: "Nav ieskaitīts:", ru: "Не учтено:", en: "Excluded:" },
} satisfies Record<string, Entry>;
