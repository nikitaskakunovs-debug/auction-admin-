import type { Entry } from "./types.js";

/** Listings screen — catalogue drafts, publish/archive, ready-to-list queue. */
export const LISTINGS = {
  // ── Heading / top actions ──────────────────────────────────────────────────
  "lst.heading": { lv: "Sludinājumi", ru: "Объявления", en: "Listings" },
  "lst.readyToList": { lv: "Gatavi publicēšanai", ru: "Готовы к публикации", en: "Ready to list" },
  "lst.newListing": { lv: "Jauns sludinājums", ru: "Новое объявление", en: "New listing" },
  "lst.exportNoun": { lv: "sludinājumi", ru: "объявлений", en: "listings" },

  // ── Stats ──────────────────────────────────────────────────────────────────
  "lst.needPhotosSuffix": { lv: "melnrakstiem vēl trūkst foto", ru: "черновиков ещё без фото", en: "drafts still need photos" },

  // ── Filter bar ─────────────────────────────────────────────────────────────
  "lst.searchPlaceholder": { lv: "Meklēt nosaukumu vai SKU…", ru: "Поиск по названию или SKU…", en: "Search title or SKU…" },
  "lst.allTypes": { lv: "Visi tipi", ru: "Все типы", en: "All types" },
  "lst.allMarkets": { lv: "Visi tirgi", ru: "Все рынки", en: "All markets" },
  "lst.typeAuction": { lv: "Izsole", ru: "Аукцион", en: "Auction" },
  "lst.typeFixed": { lv: "Fiksēta cena", ru: "Фиксированная цена", en: "Fixed price" },
  "lst.sortNewest": { lv: "Jaunākie vispirms", ru: "Сначала новые", en: "Newest first" },
  "lst.sortOldest": { lv: "Vecākie vispirms", ru: "Сначала старые", en: "Oldest first" },
  "lst.sortTitle": { lv: "Nosaukums A→Z", ru: "Название A→Z", en: "Title A→Z" },
  "lst.type": { lv: "Tips", ru: "Тип", en: "Type" },
  "lst.chipFrom": { lv: "No", ru: "С", en: "From" },
  "lst.chipTo": { lv: "Līdz", ru: "По", en: "To" },

  // ── Table ──────────────────────────────────────────────────────────────────
  "lst.item": { lv: "Prece", ru: "Товар", en: "Item" },
  "lst.price": { lv: "Cena", ru: "Цена", en: "Price" },
  "lst.reserve": { lv: "Rezerve", ru: "Резерв", en: "Reserve" },
  "lst.created": { lv: "Izveidots", ru: "Создано", en: "Created" },
  "lst.selectAll": { lv: "Atzīmēt visus redzamos sludinājumus", ru: "Выбрать все видимые объявления", en: "Select all visible listings" },
  "lst.select": { lv: "Atzīmēt", ru: "Выбрать", en: "Select" },
  "lst.emptyFiltered": { lv: "Neviens sludinājums neatbilst šiem filtriem.", ru: "Ни одно объявление не подходит под эти фильтры.", en: "No listings match these filters." },
  "lst.loadMoreFailed": { lv: "Neizdevās ielādēt vairāk", ru: "Не удалось загрузить ещё", en: "Failed to load more" },

  // ── Export ─────────────────────────────────────────────────────────────────
  "lst.itemSku": { lv: "Preces SKU", ru: "SKU товара", en: "Item SKU" },
  "lst.itemStatus": { lv: "Preces statuss", ru: "Статус товара", en: "Item status" },
  "lst.nothingToExport": { lv: "Nav ko eksportēt", ru: "Нечего экспортировать", en: "Nothing to export" },
  "lst.exportedToast": { lv: "Eksportēti sludinājumi:", ru: "Экспортировано объявлений:", en: "Exported listings:" },
  "lst.exportFailed": { lv: "Eksports neizdevās", ru: "Экспорт не удался", en: "Export failed" },
  "lst.exportCsv": { lv: "Eksportēt CSV", ru: "Экспорт CSV", en: "Export CSV" },

  // ── Create / edit drawer ───────────────────────────────────────────────────
  "lst.noItems": { lv: "Nav pieejamu preču (melnraksts vai publicēta). Vispirms pievienojiet preci krājumos.", ru: "Нет доступных товаров (черновик или опубликован). Сначала добавьте товар в разделе склада.", en: "No draft or listed items available. Add one under Inventory first." },
  "lst.startPrice": { lv: "Sākumcena €", ru: "Стартовая цена €", en: "Start price €" },
  "lst.reserveEur": { lv: "Rezerves cena €", ru: "Резервная цена €", en: "Reserve €" },
  "lst.reserveHint": { lv: "Solītājiem nav redzama — viņi redz tikai “rezerve nav sasniegta”.", ru: "Скрыта от участников — они видят только «резерв не достигнут».", en: "Hidden from bidders — “reserve not met” is all they see." },
  "lst.priceEur": { lv: "Cena €", ru: "Цена €", en: "Price €" },
  "lst.nonePlaceholder": { lv: "nav", ru: "нет", en: "none" },
  "lst.antiSnipe": { lv: "Anti-snipe laiks (sekundēs)", ru: "Анти-снайпинг (секунды)", en: "Anti-snipe override (seconds)" },
  "lst.antiSnipeHint": { lv: "Tukšs = tirgus noklusējums (60 s).", ru: "Пусто = значение рынка по умолчанию (60 с).", en: "Empty = market default (60s)." },
  "lst.createdToast": { lv: "Sludinājums izveidots", ru: "Объявление создано", en: "Listing created" },
  "lst.createFailed": { lv: "Neizdevās izveidot", ru: "Не удалось создать", en: "Create failed" },
  "lst.loadItemsFailed": { lv: "Neizdevās ielādēt preces", ru: "Не удалось загрузить товары", en: "Failed to load items" },
  "lst.editListing": { lv: "Labot sludinājumu", ru: "Изменить объявление", en: "Edit listing" },
  "lst.savedToast": { lv: "Sludinājums saglabāts", ru: "Объявление сохранено", en: "Listing saved" },
  "lst.saveFailed": { lv: "Saglabāšana neizdevās", ru: "Сохранение не удалось", en: "Save failed" },
  "lst.pricingGate": { lv: "Cenu laukiem nepieciešama pārdošanas vadītāja atļauja (listings.set_pricing).", ru: "Для полей цен нужно право менеджера продаж (listings.set_pricing).", en: "Pricing fields need the Sales Manager permission (listings.set_pricing)." },
  "lst.readyToRun": { lv: "Gatavs izsolei?", ru: "Готово к торгам?", en: "Ready to run?" },
  "lst.scheduleAuction": { lv: "Ieplānot izsoli →", ru: "Запланировать аукцион →", en: "Schedule an auction →" },
  "lst.auctionHistory": { lv: "Izsoļu vēsture", ru: "История аукционов", en: "Auction history" },

  // ── Publish / archive ──────────────────────────────────────────────────────
  "lst.publish": { lv: "Publicēt", ru: "Опубликовать", en: "Publish" },
  "lst.publishedItemListed": { lv: "Publicēts — prece tagad izlikta", ru: "Опубликовано — товар теперь выставлен", en: "Published — item is now listed" },
  "lst.publishFailed": { lv: "Publicēšana neizdevās", ru: "Публикация не удалась", en: "Publish failed" },
  "lst.publishEllipsis": { lv: "Publicēt…", ru: "Опубликовать…", en: "Publish…" },
  "lst.archive": { lv: "Arhivēt", ru: "В архив", en: "Archive" },
  "lst.archiveDrafts": { lv: "Arhivēt melnrakstus", ru: "Архивировать черновики", en: "Archive drafts" },
  "lst.archiveConfirmBody": { lv: "Tiek arhivēti tikai melnraksti — publicētie sludinājumi netiek skarti. Preces paliek noliktavā.", ru: "Архивируются только черновики — опубликованные объявления пропускаются. Товары остаются на складе.", en: "Only drafts are archived — published listings are skipped. The items stay in stock." },
  "lst.archivedCount": { lv: "arhivēti", ru: "архивировано", en: "archived" },
  "lst.skippedCount": { lv: "izlaisti", ru: "пропущено", en: "skipped" },
  "lst.bulkArchiveFailed": { lv: "Masveida arhivēšana neizdevās", ru: "Массовое архивирование не удалось", en: "Bulk archive failed" },

  // ── Bulk publish dialog ────────────────────────────────────────────────────
  "lst.bulkPubTitle": { lv: "Publicēt melnrakstus", ru: "Опубликовать черновики", en: "Publish drafts" },
  "lst.bulkPubBody": { lv: "Preces iegūst statusu “publicēta”. Pēc izvēles ieplānojiet izsoles norisi izsoles tipa sludinājumiem — fiksētas cenas sludinājumi uzreiz kļūst aktīvi.", ru: "Товары переходят в статус «опубликован». При желании запланируйте торги для лотов-аукционов — объявления с фиксированной ценой сразу становятся активными.", en: "Items go to \"listed\". Optionally schedule an auction run for the auction-type listings — fixed-price listings just go live." },
  "lst.auctionStarts": { lv: "Izsoles sākums", ru: "Начало аукциона", en: "Auction starts" },
  "lst.auctionEnds": { lv: "Izsoles beigas", ru: "Конец аукциона", en: "Auction ends" },
  "lst.publishOnly": { lv: "Tikai publicēt", ru: "Только опубликовать", en: "Publish only" },
  "lst.publishSchedule": { lv: "Publicēt + ieplānot", ru: "Опубликовать + запланировать", en: "Publish + schedule" },
  "lst.bulkPublished": { lv: "publicēti", ru: "опубликовано", en: "published" },
  "lst.bulkScheduled": { lv: "izsoles ieplānotas", ru: "аукционов запланировано", en: "auctions scheduled" },
  "lst.bulkFailedCount": { lv: "neizdevās", ru: "с ошибкой", en: "failed" },
  "lst.bulkPublishFailed": { lv: "Masveida publicēšana neizdevās", ru: "Массовая публикация не удалась", en: "Bulk publish failed" },

  // ── Ready-to-list queue ────────────────────────────────────────────────────
  "lst.listItem": { lv: "Izlikt", ru: "Выставить", en: "List" },
  "lst.backToQueue": { lv: "← Atpakaļ uz rindu", ru: "← Назад к очереди", en: "← Back to queue" },
  "lst.publishAndSchedule": { lv: "Publicēt un ieplānot", ru: "Опубликовать и запланировать", en: "Publish & schedule" },
  "lst.photo1": { lv: "foto", ru: "фото", en: "photo" },
  "lst.photoN": { lv: "foto", ru: "фото", en: "photos" },
  "lst.descHint": { lv: "Pārkopēts no preces — šeit noslīpējiet pārdošanas tekstu.", ru: "Скопировано из товара — здесь доработайте продающий текст.", en: "Copied from the item — polish the selling copy here." },
  "lst.starts": { lv: "Sākums", ru: "Начало", en: "Starts" },
  "lst.ends": { lv: "Beigas", ru: "Конец", en: "Ends" },
  "lst.stickyHint": { lv: "Saglabājas visai partijai.", ru: "Сохраняется для всей партии.", en: "Sticky for the whole batch." },
  "lst.queueIntro": { lv: "Melnraksta preces ar foto un novērtējumu — viens klikšķis līdz publicēšanai.", ru: "Черновики с фото и оценкой состояния — один клик до публикации.", en: "Draft items with photos and a grade — one click from published." },
  "lst.morePrefix": { lv: "Vēl", ru: "Ещё", en: "Another" },
  "lst.moreSuffix": { lv: "melnrakstiem trūkst foto (nofotografējiet noliktavas režīmā).", ru: "черновикам не хватает фото (снимите их в режиме склада).", en: "drafts still need photos (shoot them in warehouse mode)." },
  "lst.queueEmpty": { lv: "Nekas nav gatavs — vispirms pieņemiet un nofotografējiet preces.", ru: "Ничего не готово — сначала примите и сфотографируйте товары.", en: "Nothing ready — receive and photograph items first." },
  "lst.publishedSuffix": { lv: "publicēts", ru: "опубликован", en: "published" },
  "lst.publishedScheduledSuffix": { lv: "publicēts un ieplānots", ru: "опубликован и запланирован", en: "published & scheduled" },
  "lst.quickFailed": { lv: "Izlikšana neizdevās — pārbaudiet sludinājumos palikušo melnrakstu", ru: "Выставить не удалось — проверьте, не остался ли черновик в объявлениях", en: "Listing failed — check Listings for a leftover draft" },
} satisfies Record<string, Entry>;
