import type { Entry } from "./types.js";

/** Pickup desk — the warehouse side of the waiting room: live "now picking"
 * strip, front-desk check-in, today's queue, and the ticket drawer. Ticket
 * statuses reuse the wh.status.* keys; only completed/cancelled live here. */
export const PICKUP = {
  // ── Header ─────────────────────────────────────────────────────────────────
  "pick.title": { lv: "Izsniegšanas lete", ru: "Стойка выдачи", en: "Pickup desk" },
  "pick.openBoard": { lv: "Atvērt TV tablo", ru: "Открыть ТВ-табло", en: "Open TV board" },

  // ── "Now picking" live strip ───────────────────────────────────────────────
  "pick.nowPicking": { lv: "Šobrīd komplektē", ru: "Сейчас собирают", en: "Now picking" },
  "pick.target": { lv: "Mērķis", ru: "Цель", en: "Target" },
  "pick.min": { lv: "min", ru: "мин", en: "min" },
  "pick.bellNew": { lv: "jauni", ru: "новых", en: "new" },
  "pick.bellTitle": { lv: "Jaunas reģistrācijas kopš pēdējās notīrīšanas — klikšķis notīra", ru: "Новые регистрации с последнего сброса — нажмите, чтобы сбросить", en: "New check-ins since last cleared — click to clear" },
  "pick.soundOn": { lv: "Skaņa: ieslēgta", ru: "Звук: вкл.", en: "Sound: on" },
  "pick.soundOff": { lv: "Skaņa: izslēgta", ru: "Звук: выкл.", en: "Sound: off" },
  "pick.noLive": { lv: "Šobrīd neviens negaida un nekomplektē.", ru: "Сейчас никто не ждёт и не собирает.", en: "No one is waiting or picking right now." },
  "pick.unclaimed": { lv: "Nav pārņemts", ru: "Не взят", en: "Unclaimed" },
  "pick.pickedSuffix": { lv: "paņemtas", ru: "собрано", en: "picked" },
  "pick.offeredTo": { lv: "piedāvāts:", ru: "предложен:", en: "offered to" },

  // ── Workers-today card ─────────────────────────────────────────────────────
  "pick.workersToday": { lv: "Darbinieki šodien", ru: "Работники сегодня", en: "Workers today" },
  "pick.noWorkers": { lv: "Šodien vēl nav darbinieku statusu.", ru: "Сегодня ещё нет статусов работников.", en: "No worker statuses yet today." },

  // ── Front-desk check-in ────────────────────────────────────────────────────
  "pick.checkinTitle": { lv: "Reģistrācija pie letes", ru: "Регистрация на стойке", en: "Front-desk check-in" },
  "pick.checkinPh": { lv: "Talona nr. (119), pasūtījums (A-1042), kods, e-pasts vai SKU…", ru: "Талон (119), заказ (A-1042), код, почта или SKU…", en: "Ticket (119), order (A-1042), code, email or SKU…" },
  "pick.checkinBtn": { lv: "Reģistrēt", ru: "Зарегистрировать", en: "Check in" },
  "pick.checkedIn": { lv: "Reģistrēts", ru: "Зарегистрирован", en: "Checked in" },
  "pick.alreadyIn": { lv: "Jau reģistrēts — talons", ru: "Уже зарегистрирован — талон", en: "Already checked in — ticket" },
  "pick.tCreated": { lv: "izveidots", ru: "создан", en: "created" },

  // ── Expected arrivals (paid, still on the shelf) ───────────────────────────
  "pick.awaitingTitle": { lv: "Gaida ierašanos", ru: "Ожидают прихода", en: "Expecting to arrive" },
  "pick.awaitingHint": {
    lv: "Apmaksāts un noliktavā. Rindā nonāk tikai tad, kad klients ierodas.",
    ru: "Оплачено и на складе. В очередь попадает только когда клиент придёт.",
    en: "Paid and in the warehouse. It joins the queue only when the client arrives.",
  },
  "pick.awaitingEmpty": { lv: "Nav neviena apmaksāta pasūtījuma, kas gaidītu izņemšanu.", ru: "Нет оплаченных заказов, ожидающих выдачи.", en: "No paid orders are waiting to be collected." },
  "pick.awaitingUnits": { lv: "Preces", ru: "Товары", en: "Units" },
  "pick.awaitingWhat": { lv: "Kas jāizsniedz", ru: "Что выдать", en: "What to hand over" },
  "pick.awaitingSince": { lv: "Apmaksāts", ru: "Оплачено", en: "Paid" },
  "pick.awaitingDays": { lv: "d.", ru: "дн.", en: "d" },
  "pick.awaitingArrived": { lv: "Ieradās → talons", ru: "Пришёл → талон", en: "Arrived → ticket" },

  // ── Queue tables ───────────────────────────────────────────────────────────
  "pick.todaysQueue": { lv: "Šodienas rinda", ru: "Очередь за сегодня", en: "Today's queue" },
  "pick.queueEmpty": { lv: "Neviens negaida. Talonus izveido gan kiosks, gan šī lete.", ru: "Никто не ждёт. Талоны создаёт и киоск, и эта стойка.", en: "No one is waiting. The kiosk and this desk both create tickets." },
  "pick.client": { lv: "Klients", ru: "Клиент", en: "Client" },
  "pick.progress": { lv: "Progress", ru: "Прогресс", en: "Progress" },
  "pick.checkedInCol": { lv: "Reģistrēts", ru: "Регистрация", en: "Checked in" },
  "pick.claim": { lv: "Pārņemt", ru: "Взять", en: "Claim" },
  "pick.tClaimed": { lv: "Pārņemts", ru: "Взят", en: "Claimed" },
  "pick.finishedToday": { lv: "Šodien pabeigtie", ru: "Завершено сегодня", en: "Finished today" },
  "pick.lines": { lv: "Pozīcijas", ru: "Позиции", en: "Lines" },

  // ── Ticket statuses not covered by wh.status.* ─────────────────────────────
  "pick.st.completed": { lv: "pabeigts", ru: "завершён", en: "completed" },
  "pick.st.cancelled": { lv: "atcelts", ru: "отменён", en: "cancelled" },

  // ── Ticket drawer ──────────────────────────────────────────────────────────
  "pick.via": { lv: "caur", ru: "через", en: "via" },
  "pick.pickList": { lv: "Komplektēšanas saraksts", ru: "Список сборки", en: "Pick list" },
  "pick.walkingOrder": { lv: "staigāšanas secībā", ru: "в порядке маршрута", en: "walking order" },
  "pick.noBin": { lv: "— nav plaukta —", ru: "— без полки —", en: "— no bin —" },
  "pick.tPicked": { lv: "paņemts", ru: "взят", en: "picked" },
  "pick.allPicked": { lv: "Viss paņemts → Izsniegšana", ru: "Всё собрано → Выдача", en: "All picked → Delivering" },
  "pick.clientCode": { lv: "Klienta kods", ru: "Код клиента", en: "Client code" },
  "pick.verifyHandOver": { lv: "Pārbaudīt un izsniegt", ru: "Проверить и выдать", en: "Verify & hand over" },
  "pick.cancelTicket": { lv: "Atcelt talonu", ru: "Отменить талон", en: "Cancel ticket" },
  "pick.cancelBody": { lv: "Preces atgriežas statusā “Apmaksāta”; saņemšanas termiņš turpina tecēt.", ru: "Товары вернутся в статус «Оплачен»; срок выдачи продолжает идти.", en: "Items roll back to Paid; the pickup deadline keeps running." },
  "pick.tCancelled": { lv: "Talons atcelts", ru: "Талон отменён", en: "Ticket cancelled" },
} satisfies Record<string, Entry>;
