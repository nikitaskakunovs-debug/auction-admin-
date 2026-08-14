import type { Entry } from "./types.js";

/** Filled by the Phase D translation pass — one module per screen area. */
export const INVENTORY = {
  // ── Heading & stat tiles ───────────────────────────────────────────────────
  "inv.title": { lv: "Inventārs", ru: "Инвентарь", en: "Inventory" },
  "inv.stat.items": { lv: "Preces", ru: "Товары", en: "Items" },
  "inv.stat.fulfilment": { lv: "Izpildē", ru: "В обработке", en: "In fulfilment" },
  "inv.stat.awaiting": { lv: "Gaida apmaksu", ru: "Ждут оплаты", en: "Awaiting payment" },
  "inv.stat.attention": { lv: "Jāpievērš uzmanība", ru: "Требуют внимания", en: "Needs attention" },
  "inv.stat.attentionSub": { lv: "nepārdotas / atceltas", ru: "не проданы / отменены", en: "unsold / cancelled" },

  // ── Group pills ────────────────────────────────────────────────────────────
  "inv.g.intake": { lv: "Pieņemšana", ru: "Приёмка", en: "Intake" },
  "inv.g.selling": { lv: "Pārdošana", ru: "Продажа", en: "Selling" },
  "inv.g.fulfilment": { lv: "Izpilde", ru: "Исполнение", en: "Fulfilment" },
  "inv.g.attention": { lv: "Uzmanība", ru: "Внимание", en: "Attention" },
  "inv.g.restock": { lv: "Atgrieztās", ru: "Возвраты", en: "Returned" },
  "inv.g.closed": { lv: "Pabeigtās", ru: "Закрытые", en: "Closed" },

  // ── New item / drawer titles ───────────────────────────────────────────────
  "inv.new": { lv: "Jauna prece", ru: "Новый товар", en: "New item" },
  "inv.editItem": { lv: "Labot preci", ru: "Изменить товар", en: "Edit item" },
  "inv.itemsNoun": { lv: "preces", ru: "товаров", en: "items" },
  "inv.tab.details": { lv: "Dati", ru: "Данные", en: "Details" },

  // ── Filter bar ─────────────────────────────────────────────────────────────
  "inv.searchPh": { lv: "Meklēt SKU vai nosaukumu…", ru: "Поиск по SKU или названию…", en: "Search sku or title…" },
  "inv.allMarkets": { lv: "Visi tirgi", ru: "Все рынки", en: "All markets" },
  "inv.allCategories": { lv: "Visas kategorijas", ru: "Все категории", en: "All categories" },
  "inv.anyBin": { lv: "Jebkurš plaukts", ru: "Любая полка", en: "Any bin" },
  "inv.noBin": { lv: "Bez plaukta", ru: "Без полки", en: "No bin" },
  "inv.unassigned": { lv: "nav piešķirts", ru: "не назначена", en: "unassigned" },
  "inv.from": { lv: "No", ru: "С", en: "From" },
  "inv.to": { lv: "Līdz", ru: "По", en: "To" },
  "inv.sort.newest": { lv: "Jaunākās vispirms", ru: "Сначала новые", en: "Newest first" },
  "inv.sort.oldest": { lv: "Vecākās vispirms", ru: "Сначала старые", en: "Oldest first" },
  "inv.sort.updated": { lv: "Nesen atjaunotās", ru: "Недавно обновлённые", en: "Recently updated" },
  "inv.sort.title": { lv: "Nosaukums A→Z", ru: "Название A→Z", en: "Title A→Z" },

  // ── Table / card list ──────────────────────────────────────────────────────
  "inv.category": { lv: "Kategorija", ru: "Категория", en: "Category" },
  "inv.weight": { lv: "Svars", ru: "Вес", en: "Weight" },
  "inv.updated": { lv: "Atjaunots", ru: "Обновлён", en: "Updated" },
  "inv.received": { lv: "Saņemts", ru: "Принят", en: "Received" },
  "inv.weightG": { lv: "Svars g", ru: "Вес г", en: "Weight g" },
  "inv.empty": { lv: "Neviena prece neatbilst šiem filtriem.", ru: "Ни один товар не соответствует этим фильтрам.", en: "No items match these filters." },
  "inv.loadMoreFailed": { lv: "Neizdevās ielādēt vairāk", ru: "Не удалось загрузить ещё", en: "Failed to load more" },
  "inv.selectAllAria": { lv: "Atzīmēt visas redzamās preces", ru: "Выбрать все видимые товары", en: "Select all visible items" },
  "inv.selectAria": { lv: "Atzīmēt", ru: "Выбрать", en: "Select" },

  // ── Toasts ─────────────────────────────────────────────────────────────────
  "inv.saved": { lv: "Prece saglabāta", ru: "Товар сохранён", en: "Item saved" },
  "inv.created": { lv: "Prece izveidota", ru: "Товар создан", en: "Item created" },
  "inv.deleted": { lv: "Prece dzēsta", ru: "Товар удалён", en: "Item deleted" },
  "inv.deleteFailed": { lv: "Dzēšana neizdevās", ru: "Удаление не удалось", en: "Delete failed" },
  "inv.deleteBody": { lv: "Dzēst var tikai melnraksta preces. To nevar atsaukt.", ru: "Удалять можно только черновики. Это нельзя отменить.", en: "Only draft items can be deleted. This cannot be undone." },
  "inv.transitionFailed": { lv: "Statusa maiņa neizdevās", ru: "Не удалось сменить статус", en: "Transition failed" },

  // ── Export ─────────────────────────────────────────────────────────────────
  "inv.nothingExport": { lv: "Nav ko eksportēt", ru: "Нечего экспортировать", en: "Nothing to export" },
  "inv.exportFailed": { lv: "Eksports neizdevās", ru: "Экспорт не удался", en: "Export failed" },
  "inv.exportedSuffix": { lv: "preces eksportētas", ru: "товаров экспортировано", en: "items exported" },
  "inv.exportTitle": { lv: "Inventāra eksports", ru: "Экспорт инвентаря", en: "Inventory export" },

  // ── Bulk bar ───────────────────────────────────────────────────────────────
  "inv.printLabel": { lv: "Drukāt etiķeti", ru: "Печать этикетки", en: "Print label" },
  "inv.printLabels": { lv: "Drukāt etiķetes", ru: "Печать этикеток", en: "Print labels" },
  "inv.warehouseBin": { lv: "Noliktavas plaukts", ru: "Полка на складе", en: "Warehouse bin" },
  "inv.binHint": { lv: "Plaukta maiņa tiek ierakstīta krājumu žurnālā.", ru: "Смена полки записывается в журнал склада.", en: "Changing the bin writes a putaway/move into the stock ledger." },
  "inv.noBinDash": { lv: "— bez plaukta —", ru: "— без полки —", en: "— no bin —" },
  "inv.setCategory": { lv: "Piešķirt kategoriju", ru: "Назначить категорию", en: "Set category" },
  "inv.pickCategory": { lv: "Izvēlieties kategoriju…", ru: "Выберите категорию…", en: "Pick a category…" },
  "inv.condition": { lv: "Stāvoklis", ru: "Состояние", en: "Condition" },
  "inv.conditionNotes": { lv: "Piezīmes par stāvokli", ru: "Заметки о состоянии", en: "Condition notes" },
  "inv.moveToBin": { lv: "Pārvietot uz plauktu", ru: "Переместить на полку", en: "Move to bin" },
  "inv.pickBin": { lv: "Izvēlieties plauktu…", ru: "Выберите полку…", en: "Pick a bin…" },
  "inv.movedOne": { lv: "prece pārvietota", ru: "товар перемещён", en: "item moved" },
  "inv.movedMany": { lv: "preces pārvietotas", ru: "товаров перемещено", en: "items moved" },
  "inv.failedSuffix": { lv: "neizdevās", ru: "с ошибкой", en: "failed" },

  // ── Lifecycle next-step buttons ────────────────────────────────────────────
  "inv.step.returnStock": { lv: "Atgriezt noliktavā", ru: "Вернуть на склад", en: "Return to stock" },
  "inv.step.startPicking": { lv: "Sākt komplektēšanu", ru: "Начать сборку", en: "Start picking" },
  "inv.step.markPacked": { lv: "Atzīmēt kā iepakotu", ru: "Отметить упакованным", en: "Mark packed" },
  "inv.step.markShipped": { lv: "Atzīmēt kā nosūtītu", ru: "Отметить отправленным", en: "Mark shipped" },
  "inv.step.markDelivered": { lv: "Atzīmēt kā piegādātu", ru: "Отметить доставленным", en: "Mark delivered" },
  "inv.step.close": { lv: "Pabeigt", ru: "Закрыть", en: "Close" },

  // ── Form fields ────────────────────────────────────────────────────────────
  "inv.locationNote": { lv: "Vieta (piezīme)", ru: "Место (заметка)", en: "Location (note)" },
  "inv.weightGrams": { lv: "Svars (gramos)", ru: "Вес (в граммах)", en: "Weight (grams)" },
  "inv.legacy": { lv: "vēsturisks", ru: "устаревшее", en: "legacy" },
  "inv.seeNotes": { lv: "— skat. piezīmes", ru: "— см. заметки", en: "— see notes" },
  "inv.condNotesHintReq": { lv: "Šis ir “SKAT. PIEZĪMES” novērtējums — aprakstiet konkrēto problēmu (redzams solītājiem).", ru: "Это оценка «СМ. ЗАМЕТКИ» — опишите конкретную проблему (видно участникам торгов).", en: "This is a SEE NOTES grade — describe the specific issue (shown to bidders)." },
  "inv.condNotesHint": { lv: "Neobligātas detaļas, ko redz solītāji.", ru: "Необязательные детали, видимые участникам торгов.", en: "Optional details shown to bidders." },

  // ── Photos ─────────────────────────────────────────────────────────────────
  "inv.photosHint": { lv: "Pirmais foto ir galvenais veikala skatā. Augšupielādētie faili tiek samazināti serverī.", ru: "Первое фото — обложка в витрине. Загруженные файлы сжимаются на сервере.", en: "The first photo is the storefront cover. Uploads are resized server-side." },
  "inv.cover": { lv: "galvenais", ru: "обложка", en: "cover" },

  // ── Warehouse bin (putaway) ────────────────────────────────────────────────
  "inv.whBin": { lv: "Noliktavas plaukts", ru: "Полка на складе", en: "Warehouse bin" },
  "inv.whBinHint": { lv: "Plaukta maiņa ieraksta novietošanu/pārvietošanu krājumu žurnālā.", ru: "Смена полки записывает размещение/перемещение в складской журнал.", en: "Changing the bin writes a putaway/move into the stock ledger." },
  "inv.noBinOpt": { lv: "— bez plaukta —", ru: "— без полки —", en: "— no bin —" },

  // ── W6: purchase cost (finance-only) ───────────────────────────────────────
  "inv.cost.label": { lv: "Iepirkuma cena (EUR)", ru: "Закупочная цена (EUR)", en: "Purchase cost (EUR)" },
  "inv.cost.unknown": { lv: "nav datu", ru: "нет данных", en: "no data" },
  "inv.cost.private": { lv: "Redzams tikai finansēm — atstājiet tukšu, ja iepirkuma cena nav zināma.", ru: "Видно только финансам — оставьте пустым, если закупочная цена неизвестна.", en: "Visible to finance only — leave empty if the purchase cost is unknown." },
  "inv.cost.invalid": { lv: "Ievadiet summu, piemēram 12,50 (bez mīnusa). Tukšs lauks nozīmē “nav datu”.", ru: "Введите сумму, например 12,50 (без минуса). Пустое поле означает «нет данных».", en: "Enter an amount like 12.50 (no minus). An empty field means “no data”." },
  "inv.cost.invalidToast": { lv: "Iepirkuma cena nav derīga — labojiet lauku vai atstājiet to tukšu", ru: "Закупочная цена введена неверно — исправьте поле или оставьте его пустым", en: "The purchase cost isn't valid — fix the field or leave it empty" },
  "inv.cost.onlyCost": { lv: "Ar savām tiesībām šeit varat saglabāt tikai iepirkuma cenu — pārējie labojumi netiks saglabāti.", ru: "С вашими правами здесь сохраняется только закупочная цена — остальные правки не сохранятся.", en: "With your permissions only the purchase cost is saved here — other edits will not be saved." },

  // ── Category names (mapped by @auction/domain category code) ──────────────
  "inv.cat.electronics": { lv: "Elektronika", ru: "Электроника", en: "Electronics" },
  "inv.cat.appliances": { lv: "Sadzīves tehnika", ru: "Бытовая техника", en: "Home appliances" },
  "inv.cat.furniture": { lv: "Mēbeles", ru: "Мебель", en: "Furniture" },
  "inv.cat.tools": { lv: "Instrumenti un garāža", ru: "Инструменты и гараж", en: "Tools & garage" },
  "inv.cat.home_garden": { lv: "Māja un dārzs", ru: "Дом и сад", en: "Home & garden" },
  "inv.cat.jewellery_watches": { lv: "Rotaslietas un pulksteņi", ru: "Украшения и часы", en: "Jewellery & watches" },
  "inv.cat.art_antiques": { lv: "Māksla un antikvariāts", ru: "Искусство и антиквариат", en: "Art & antiques" },
  "inv.cat.sports_outdoors": { lv: "Sports un aktīvā atpūta", ru: "Спорт и отдых", en: "Sports & outdoors" },
  "inv.cat.kids_toys": { lv: "Bērniem un rotaļlietas", ru: "Детям и игрушки", en: "Kids & toys" },
  "inv.cat.fashion": { lv: "Mode", ru: "Одежда и мода", en: "Fashion" },
  "inv.cat.food_household": { lv: "Pārtika un saimniecības preces", ru: "Продукты и хозтовары", en: "Food & household" },
  "inv.cat.other": { lv: "Cits", ru: "Другое", en: "Other" },
} satisfies Record<string, Entry>;
