import type { Entry } from "./types.js";

/**
 * Shared vocabulary: entity statuses (rendered as badges on many screens) and
 * the small words every screen needs. Screens use the c.* keys directly or via
 * the status-label helpers in ../i18n.ts. Owned by the core pass — screen
 * translation modules must not redefine these.
 */
export const COMMON = {
  // ── Auction statuses ───────────────────────────────────────────────────────
  "c.ast.scheduled": { lv: "Ieplānota", ru: "Запланирован", en: "Scheduled" },
  "c.ast.live": { lv: "Aktīva", ru: "Идёт", en: "Live" },
  "c.ast.ended_won": { lv: "Pārdota", ru: "Продан", en: "Won" },
  "c.ast.ended_reserve_not_met": { lv: "Rezerve nav sasniegta", ru: "Резерв не достигнут", en: "Reserve not met" },
  "c.ast.ended_no_bids": { lv: "Bez solījumiem", ru: "Без ставок", en: "No bids" },
  "c.ast.cancelled": { lv: "Atcelta", ru: "Отменён", en: "Cancelled" },

  // ── Item statuses ──────────────────────────────────────────────────────────
  "c.ist.draft": { lv: "Melnraksts", ru: "Черновик", en: "Draft" },
  "c.ist.listed": { lv: "Publicēta", ru: "Опубликован", en: "Listed" },
  "c.ist.live": { lv: "Izsolē", ru: "На торгах", en: "Live" },
  "c.ist.won": { lv: "Pārdota", ru: "Продан", en: "Won" },
  "c.ist.awaiting_payment": { lv: "Gaida apmaksu", ru: "Ждёт оплаты", en: "Awaiting payment" },
  "c.ist.paid": { lv: "Apmaksāta", ru: "Оплачен", en: "Paid" },
  "c.ist.picking": { lv: "Komplektē", ru: "Сборка", en: "Picking" },
  "c.ist.packed": { lv: "Iepakota", ru: "Упакован", en: "Packed" },
  "c.ist.shipped": { lv: "Nosūtīta", ru: "Отправлен", en: "Shipped" },
  "c.ist.delivered": { lv: "Piegādāta", ru: "Доставлен", en: "Delivered" },
  "c.ist.closed": { lv: "Pabeigta", ru: "Закрыт", en: "Closed" },
  "c.ist.unsold": { lv: "Nepārdota", ru: "Не продан", en: "Unsold" },
  "c.ist.unpaid_cancelled": { lv: "Atcelta (neapmaksāta)", ru: "Отменён (не оплачен)", en: "Unpaid · cancelled" },
  "c.ist.no_pickup_cancelled": { lv: "Atcelta (neizņemta)", ru: "Отменён (не забран)", en: "No pickup · cancelled" },
  "c.ist.returned": { lv: "Atgriezta", ru: "Возвращён", en: "Returned" },

  // ── Order statuses ─────────────────────────────────────────────────────────
  "c.ost.awaiting_payment": { lv: "Gaida apmaksu", ru: "Ждёт оплаты", en: "Awaiting payment" },
  "c.ost.paid": { lv: "Apmaksāts", ru: "Оплачен", en: "Paid" },
  "c.ost.cancelled": { lv: "Atcelts", ru: "Отменён", en: "Cancelled" },
  "c.ost.refunded": { lv: "Atmaksāts", ru: "Возврат", en: "Refunded" },

  // ── Listing statuses ───────────────────────────────────────────────────────
  "c.lst.draft": { lv: "Melnraksts", ru: "Черновик", en: "Draft" },
  "c.lst.published": { lv: "Publicēts", ru: "Опубликован", en: "Published" },
  "c.lst.archived": { lv: "Arhivēts", ru: "В архиве", en: "Archived" },

  // ── Common words ───────────────────────────────────────────────────────────
  "c.save": { lv: "Saglabāt", ru: "Сохранить", en: "Save" },
  "c.saving": { lv: "Saglabā…", ru: "Сохранение…", en: "Saving…" },
  "c.cancel": { lv: "Atcelt", ru: "Отмена", en: "Cancel" },
  "c.close": { lv: "Aizvērt", ru: "Закрыть", en: "Close" },
  "c.delete": { lv: "Dzēst", ru: "Удалить", en: "Delete" },
  "c.edit": { lv: "Labot", ru: "Изменить", en: "Edit" },
  "c.create": { lv: "Izveidot", ru: "Создать", en: "Create" },
  "c.add": { lv: "Pievienot", ru: "Добавить", en: "Add" },
  "c.remove": { lv: "Noņemt", ru: "Убрать", en: "Remove" },
  "c.search": { lv: "Meklēt", ru: "Поиск", en: "Search" },
  "c.loading": { lv: "Ielādē…", ru: "Загрузка…", en: "Loading…" },
  "c.loadMore": { lv: "Ielādēt vairāk", ru: "Показать ещё", en: "Load more" },
  "c.all": { lv: "Visi", ru: "Все", en: "All" },
  "c.none": { lv: "Nav", ru: "Нет", en: "None" },
  "c.yes": { lv: "Jā", ru: "Да", en: "Yes" },
  "c.no": { lv: "Nē", ru: "Нет", en: "No" },
  "c.ok": { lv: "Labi", ru: "Ок", en: "OK" },
  "c.export": { lv: "Eksportēt", ru: "Экспорт", en: "Export" },
  "c.refresh": { lv: "Atjaunot", ru: "Обновить", en: "Refresh" },
  "c.actions": { lv: "Darbības", ru: "Действия", en: "Actions" },
  "c.status": { lv: "Statuss", ru: "Статус", en: "Status" },
  "c.date": { lv: "Datums", ru: "Дата", en: "Date" },
  "c.total": { lv: "Kopā", ru: "Итого", en: "Total" },
  "c.market": { lv: "Tirgus", ru: "Рынок", en: "Market" },
  "c.title": { lv: "Nosaukums", ru: "Название", en: "Title" },
  "c.description": { lv: "Apraksts", ru: "Описание", en: "Description" },
  "c.condition": { lv: "Stāvoklis", ru: "Состояние", en: "Condition" },
  "c.location": { lv: "Vieta", ru: "Место", en: "Location" },
  "c.notes": { lv: "Piezīmes", ru: "Заметки", en: "Notes" },
  "c.reason": { lv: "Iemesls", ru: "Причина", en: "Reason" },
  "c.optional": { lv: "neobligāti", ru: "необязательно", en: "optional" },
  "c.required": { lv: "obligāti", ru: "обязательно", en: "required" },
  "c.error": { lv: "Kaut kas nogāja greizi", ru: "Что-то пошло не так", en: "Something went wrong" },
  "c.saved": { lv: "Saglabāts", ru: "Сохранено", en: "Saved" },
  "c.copied": { lv: "Nokopēts", ru: "Скопировано", en: "Copied" },
  "c.today": { lv: "Šodien", ru: "Сегодня", en: "Today" },
  "c.of": { lv: "no", ru: "из", en: "of" },
} satisfies Record<string, Entry>;
