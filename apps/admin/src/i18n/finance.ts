import type { Entry } from "./types.js";

/** Filled by the Phase D translation pass — one module per screen area. */
export const FINANCE = {
  // ── Screen / tabs ──────────────────────────────────────────────────────────
  "fin.title": { lv: "Finanses", ru: "Финансы", en: "Finance" },
  "fin.tab.payments": { lv: "Maksājumi", ru: "Платежи", en: "Payments" },
  "fin.tab.invoices": { lv: "Rēķini", ru: "Счета", en: "Invoices" },
  "fin.tab.vat": { lv: "PVN atskaite", ru: "Отчёт НДС", en: "VAT report" },
  "fin.noTabs": { lv: "Jūsu lomai šeit nav pieejamu sadaļu.", ru: "Для вашей роли здесь нет доступных разделов.", en: "No section here is available to your role." },

  // ── Payments: pills / stats ────────────────────────────────────────────────
  "fin.ps.paid": { lv: "Apmaksāti", ru: "Оплачены", en: "Paid" },
  "fin.ps.created": { lv: "Procesā", ru: "В процессе", en: "In flight" },
  "fin.ps.failed": { lv: "Neizdevušies", ru: "Неуспешные", en: "Failed" },
  "fin.ps.expired": { lv: "Beigušies", ru: "Истёкшие", en: "Expired" },
  "fin.allProviders": { lv: "Visi sniedzēji", ru: "Все провайдеры", en: "All providers" },
  "fin.stat.today": { lv: "Iekasēts šodien", ru: "Получено сегодня", en: "Collected today" },
  "fin.stat.week": { lv: "Pēdējās 7 dienās", ru: "За последние 7 дней", en: "Last 7 days" },
  "fin.stat.inFlight": { lv: "Apmaksas procesā", ru: "Оплаты в процессе", en: "Checkouts in flight" },

  // ── Payments: table ────────────────────────────────────────────────────────
  "fin.paySearchPh": { lv: "Meklēt pasūtījuma nr. vai solītāju…", ru: "Поиск по номеру заказа или участнику…", en: "Search order ref or bidder…" },
  "fin.th.when": { lv: "Kad", ru: "Когда", en: "When" },
  "fin.th.order": { lv: "Pasūtījums", ru: "Заказ", en: "Order" },
  "fin.th.customer": { lv: "Klients", ru: "Клиент", en: "Customer" },
  "fin.th.provider": { lv: "Sniedzējs", ru: "Провайдер", en: "Provider" },
  "fin.th.method": { lv: "Metode", ru: "Способ", en: "Method" },
  "fin.th.via": { lv: "Kanāls", ru: "Канал", en: "Via" },
  "fin.th.amount": { lv: "Summa", ru: "Сумма", en: "Amount" },
  "fin.via.email": { lv: "E-pasta saite", ru: "Ссылка из письма", en: "Email link" },
  "fin.via.web": { lv: "Vietne", ru: "Сайт", en: "Web" },
  "fin.pst.paid": { lv: "apmaksāts", ru: "оплачен", en: "paid" },
  "fin.pst.created": { lv: "izveidots", ru: "создан", en: "created" },
  "fin.pst.failed": { lv: "neizdevās", ru: "неуспешен", en: "failed" },
  "fin.pst.expired": { lv: "beidzies", ru: "истёк", en: "expired" },
  "fin.details": { lv: "detaļas", ru: "детали", en: "details" },
  "fin.providerRef": { lv: "sniedzēja ref:", ru: "реф. провайдера:", en: "provider ref:" },
  "fin.payEmpty": { lv: "Neviens tiešsaistes maksājuma mēģinājums neatbilst — tie parādās šeit, tiklīdz klients atver apmaksu.", ru: "Нет подходящих онлайн-платежей — они появляются здесь, как только клиент открывает оплату.", en: "No online payment attempts match — they appear here the moment a customer opens a checkout." },

  // ── Exports / toasts ───────────────────────────────────────────────────────
  "fin.nothingToExport": { lv: "Nav ko eksportēt", ru: "Нечего экспортировать", en: "Nothing to export" },
  "fin.exportFailed": { lv: "Eksports neizdevās", ru: "Экспорт не удался", en: "Export failed" },
  "fin.exportedPayments": { lv: "Eksportēti maksājumi", ru: "Экспортировано платежей", en: "Exported payments" },
  "fin.exportedInvoices": { lv: "Eksportēti rēķini", ru: "Экспортировано счетов", en: "Exported invoices" },
  "fin.payExportTitle": { lv: "Maksājumu eksports", ru: "Экспорт платежей", en: "Payments export" },
  "fin.invExportTitle": { lv: "Rēķinu eksports", ru: "Экспорт счетов", en: "Invoices export" },
  "fin.nounPayments": { lv: "maksājumi", ru: "платежей", en: "payments" },
  "fin.nounInvoices": { lv: "rēķini", ru: "счетов", en: "invoices" },
  "fin.nounMarkets": { lv: "tirgi", ru: "рынков", en: "markets" },

  // ── Invoices ───────────────────────────────────────────────────────────────
  "fin.invSearchPh": { lv: "Meklēt rēķina nr., pasūtījumu, pircēju…", ru: "Поиск: номер счёта, заказ, покупатель…", en: "Search invoice no., order, buyer…" },
  "fin.invEmpty": { lv: "Vēl nav izrakstītu rēķinu — tie tiek izveidoti automātiski, kad izsole noslēdzas ar uzvarētāju.", ru: "Счета ещё не выставлены — они создаются автоматически, когда аукцион завершается с победителем.", en: "No invoices issued yet — they are created automatically when an auction closes with a winner." },
  "fin.th.invoiceNo": { lv: "Rēķina nr.", ru: "Номер счёта", en: "Invoice no." },
  "fin.th.buyer": { lv: "Pircējs", ru: "Покупатель", en: "Buyer" },
  "fin.th.issued": { lv: "Izrakstīts", ru: "Выставлен", en: "Issued" },
  "fin.th.vat": { lv: "PVN", ru: "НДС", en: "VAT" },
  "fin.th.reverseCharge": { lv: "Reversais PVN", ru: "Обратное начисление", en: "Reverse charge" },
  "fin.open": { lv: "Atvērt", ru: "Открыть", en: "Open" },

  // ── VAT report ─────────────────────────────────────────────────────────────
  "fin.vat.from": { lv: "No", ru: "С", en: "From" },
  "fin.vat.toIncl": { lv: "Līdz (ieskaitot)", ru: "По (включительно)", en: "To (inclusive)" },
  "fin.vat.run": { lv: "Veidot atskaiti", ru: "Сформировать отчёт", en: "Run report" },
  "fin.vat.basis": { lv: "Pamats: periodā izrakstītie rēķini · precizējiet piemērošanu ar grāmatvedi", ru: "Основа: счета, выставленные за период · уточните трактовку у бухгалтера", en: "Basis: invoices issued in period · confirm treatment with your accountant" },
  "fin.vat.empty": { lv: "Šajā periodā nav rēķinu.", ru: "За этот период счетов нет.", en: "No invoices in this period." },
  "fin.vat.invoices": { lv: "Rēķini", ru: "Счета", en: "Invoices" },
  "fin.vat.net": { lv: "Neto", ru: "Нетто", en: "Net" },
  "fin.vat.vatDue": { lv: "Maksājamais PVN", ru: "НДС к уплате", en: "VAT due" },
  "fin.vat.gross": { lv: "Bruto", ru: "Брутто", en: "Gross" },
  "fin.vat.rcNet": { lv: "Reversā PVN neto", ru: "Нетто (обратное начисление)", en: "Reverse-charge net" },
  "fin.vat.rcInvoices": { lv: "RC rēķini", ru: "Счета RC", en: "RC invoices" },
  "fin.vat.loadFailed": { lv: "Neizdevās ielādēt atskaiti", ru: "Не удалось загрузить отчёт", en: "Failed to load the report" },
  "fin.vat.reportTitle": { lv: "PVN atskaite", ru: "Отчёт НДС", en: "VAT report" },

  // ── W6: Profit & stock value ───────────────────────────────────────────────
  "fin.pf.tab": { lv: "Peļņa un vērtība", ru: "Прибыль и стоимость", en: "Profit & value" },
  "fin.pf.from": { lv: "No", ru: "С", en: "From" },
  "fin.pf.toIncl": { lv: "Līdz (ieskaitot)", ru: "По (включительно)", en: "To (inclusive)" },
  "fin.pf.run": { lv: "Veidot atskaiti", ru: "Сформировать отчёт", en: "Run report" },
  "fin.pf.loadFailed": { lv: "Neizdevās ielādēt peļņas atskaiti", ru: "Не удалось загрузить отчёт о прибыли", en: "Failed to load the profit report" },
  "fin.pf.basis": { lv: "Peļņa = āmura cena − iepirkuma cena, pirms pircēja piemaksas un PVN", ru: "Прибыль = цена молотка − закупочная цена, до комиссии покупателя и НДС", en: "Profit = hammer price − purchase cost, before buyer premium and VAT" },
  "fin.pf.stat.sold": { lv: "Pārdots", ru: "Продано", en: "Sold" },
  "fin.pf.itemsSuffix": { lv: "preces", ru: "товаров", en: "items" },
  "fin.pf.revenue": { lv: "apgrozījums", ru: "выручка", en: "revenue" },
  "fin.pf.stat.profit": { lv: "Peļņa", ru: "Прибыль", en: "Profit" },
  // The API divides profit by COST, so this is a markup, not a margin —
  // all three languages must say markup or the number reads ~20% too high.
  "fin.pf.stat.margin": { lv: "Vidējais uzcenojums", ru: "Средняя наценка", en: "Average markup" },
  "fin.pf.stat.marginHint": { lv: "peļņa ÷ iepirkuma cena", ru: "прибыль ÷ закупочная цена", en: "profit ÷ purchase cost" },
  "fin.pf.stat.noData": { lv: "Bez izmaksu datiem", ru: "Без данных о закупке", en: "No cost data" },
  "fin.pf.noDataHint": { lv: "peļņas summa neietver preces bez iepirkuma cenas", ru: "сумма прибыли не включает товары без закупочной цены", en: "profit totals exclude items without a purchase cost" },
  "fin.pf.th.item": { lv: "Prece", ru: "Товар", en: "Item" },
  "fin.pf.th.sold": { lv: "Pārdots", ru: "Продано", en: "Sold" },
  "fin.pf.th.cost": { lv: "Iepirkts", ru: "Закупка", en: "Cost" },
  "fin.pf.th.profit": { lv: "Peļņa", ru: "Прибыль", en: "Profit" },
  // Per-line percentage is profit ÷ cost as well — markup, like the stat tile.
  "fin.pf.th.markupPct": { lv: "Uzcenojums %", ru: "Наценка %", en: "Markup %" },
  "fin.pf.noCost": { lv: "nav datu", ru: "нет данных", en: "no data" },
  "fin.pf.linesEmpty": { lv: "Šajā periodā nav apmaksātu pārdošanu.", ru: "За этот период нет оплаченных продаж.", en: "No paid sales in this period." },
  "fin.pf.exportCsv": { lv: "Eksportēt CSV", ru: "Экспорт CSV", en: "Export CSV" },
  "fin.pf.exportCsvVisible": { lv: "Eksportēt CSV (redzamās rindas)", ru: "Экспорт CSV (видимые строки)", en: "Export CSV (visible rows)" },
  "fin.pf.exportTitle": { lv: "Peļņas atskaite", ru: "Отчёт о прибыли", en: "Profit report" },
  // Shown when the API caps `lines` but still totals the whole period.
  "fin.pf.truncated": { lv: "Tabulā redzami tikai perioda jaunākie {n} pārdevumi. Kopsavilkuma skaitļi augstāk aptver visu periodu; arī CSV eksports satur tikai šīs redzamās rindas.", ru: "В таблице показаны только последние {n} продаж периода. Итоги выше охватывают весь период; экспорт CSV тоже содержит только эти видимые строки.", en: "The table lists only the newest {n} sales of the period. The totals above cover the whole period; the CSV export likewise contains only these visible rows." },
  "fin.pf.exportedPartial": { lv: "Eksportētas tikai redzamās rindas — ne viss periods", ru: "Экспортированы только видимые строки — не весь период", en: "Exported the visible rows only — not the whole period" },
  "fin.pf.stock.title": { lv: "Krājumu vērtība šodien", ru: "Стоимость запасов на сегодня", en: "Stock value today" },
  "fin.pf.stock.ready": { lv: "Plauktos (gatavs pārdošanai)", ru: "На полках (готово к продаже)", en: "On shelves (ready to sell)" },
  "fin.pf.stock.drafts": { lv: "Melnraksti", ru: "Черновики", en: "Drafts" },
  "fin.pf.stock.quarantine": { lv: "Karantīnā vai bojāti", ru: "В карантине или повреждены", en: "Quarantined or damaged" },
  "fin.pf.stock.units": { lv: "gab.", ru: "шт.", en: "pcs" },
  "fin.pf.stock.noData": { lv: "bez datiem", ru: "без данных", en: "no data" },
  "fin.pf.cons.title": { lv: "Piegāžu rentabilitāte", ru: "Рентабельность поставок", en: "Consignment profitability" },
  "fin.pf.cons.sold": { lv: "pārdoti", ru: "продано", en: "sold" },
  "fin.pf.cons.empty": { lv: "Šajā periodā nav piegāžu ar pārdotām precēm.", ru: "За этот период нет поставок с проданными товарами.", en: "No consignments with sold items in this period." },

  // ── R1: supplier invoices / payables ───────────────────────────────────────
  "fin.pay.tab": { lv: "Piegādātāju rēķini", ru: "Счета поставщиков", en: "Supplier invoices" },
  "fin.pay.loadFailed": { lv: "Neizdevās ielādēt piegādātāju rēķinus", ru: "Не удалось загрузить счета поставщиков", en: "Failed to load supplier invoices" },
  "fin.pay.basis": { lv: "Atlikums = rēķina summa − reģistrētie maksājumi · atceltie rēķini parādā neieskaitās", ru: "Остаток = сумма счёта − зарегистрированные платежи · отменённые счета в долг не входят", en: "Outstanding = invoice amount − recorded payments · cancelled invoices are excluded" },

  // Stat tiles — the payables position right now, whatever the list filter says.
  "fin.pay.stat.outstanding": { lv: "Jāmaksā kopā", ru: "К оплате всего", en: "Total payable" },
  "fin.pay.stat.overdue": { lv: "Kavēts", ru: "Просрочено", en: "Overdue" },
  "fin.pay.stat.week": { lv: "Šonedēļ", ru: "На этой неделе", en: "Due this week" },
  "fin.pay.stat.paidMonth": { lv: "Samaksāts šomēnes", ru: "Оплачено в этом месяце", en: "Paid this month" },
  "fin.pay.sub.open": { lv: "atvērti rēķini", ru: "открытых счетов", en: "open invoices" },
  "fin.pay.sub.overdue": { lv: "kavēti rēķini", ru: "просроченных счетов", en: "overdue invoices" },

  // Filter pills
  "fin.pay.f.unpaid": { lv: "Neapmaksātie", ru: "Неоплаченные", en: "Unpaid" },
  "fin.pay.f.overdue": { lv: "Kavētie", ru: "Просроченные", en: "Overdue" },
  "fin.pay.f.paid": { lv: "Apmaksātie", ru: "Оплаченные", en: "Paid" },

  // Invoice table
  "fin.pay.th.invoice": { lv: "Rēķins", ru: "Счёт", en: "Invoice" },
  "fin.pay.th.supplier": { lv: "Piegādātājs", ru: "Поставщик", en: "Supplier" },
  "fin.pay.th.delivery": { lv: "Piegāde", ru: "Поставка", en: "Delivery" },
  "fin.pay.th.due": { lv: "Termiņš", ru: "Срок", en: "Due" },
  "fin.pay.th.amount": { lv: "Summa", ru: "Сумма", en: "Amount" },
  "fin.pay.th.outstanding": { lv: "Atlikums", ru: "Остаток", en: "Outstanding" },
  "fin.pay.th.invoiceDate": { lv: "Rēķina datums", ru: "Дата счёта", en: "Invoice date" },
  "fin.pay.th.overdueDays": { lv: "Kavējums (d.)", ru: "Просрочка (дн.)", en: "Overdue (days)" },
  "fin.pay.empty": { lv: "Neviens rēķins neatbilst šim filtram.", ru: "По этому фильтру счетов нет.", en: "No invoices match this filter." },
  "fin.pay.truncated": { lv: "Tabulā redzami {n} no {m} rēķiniem. Kopsavilkums augstāk aptver visus neapmaksātos rēķinus; CSV eksportā nonāk tikai redzamās rindas.", ru: "В таблице показаны {n} из {m} счетов. Сводка выше учитывает все неоплаченные счета; в CSV попадают только видимые строки.", en: "The table lists {n} of {m} invoices. The summary above covers every unpaid invoice; the CSV export contains only these visible rows." },
  "fin.pay.exported": { lv: "Eksportēti piegādātāju rēķini", ru: "Экспортировано счетов поставщиков", en: "Exported supplier invoices" },

  // Invoice status
  "fin.pay.st.unpaid": { lv: "Neapmaksāts", ru: "Не оплачен", en: "Unpaid" },
  "fin.pay.st.partly": { lv: "Daļēji", ru: "Частично", en: "Partly paid" },
  "fin.pay.st.paid": { lv: "Apmaksāts", ru: "Оплачен", en: "Paid" },
  "fin.pay.st.cancelled": { lv: "Atcelts", ru: "Отменён", en: "Cancelled" },
  "fin.pay.st.overdue": { lv: "Kavēts {n} d.", ru: "Просрочен {n} дн.", en: "Overdue {n} d" },

  // Drawer
  "fin.pay.dr.paid": { lv: "Samaksāts", ru: "Оплачено", en: "Paid" },
  "fin.pay.dr.recon": { lv: "Reģistrēts preču iepirkumā {cost} · starpība {variance}", ru: "Учтено в закупке товаров {cost} · разница {variance}", en: "Recorded in purchase costs {cost} · variance {variance}" },
  "fin.pay.dr.reconIncomplete": { lv: "Salīdzinājums nav pilnīgs: {n} vienībām nav ievadīta iepirkuma cena.", ru: "Сравнение неполное: у {n} единиц не указана закупочная цена.", en: "The comparison is incomplete: {n} units have no purchase price recorded." },
  "fin.pay.dr.payments": { lv: "Maksājumi", ru: "Платежи", en: "Payments" },
  "fin.pay.dr.noPayments": { lv: "Vēl nav neviena maksājuma.", ru: "Платежей пока нет.", en: "No payments recorded yet." },
  "fin.pay.dr.deletePayment": { lv: "Dzēst maksājumu", ru: "Удалить платёж", en: "Delete payment" },
  "fin.pay.dr.deleteBody": { lv: "Maksājums {amount} tiks dzēsts un rēķina atlikums pieaugs atpakaļ. To nevar atsaukt.", ru: "Платёж {amount} будет удалён, остаток по счёту вырастет обратно. Отменить это нельзя.", en: "The {amount} payment will be removed and the invoice's outstanding balance grows back. This cannot be undone." },
  "fin.pay.dr.paymentDeleted": { lv: "Maksājums dzēsts", ru: "Платёж удалён", en: "Payment deleted" },

  // Record a payment
  "fin.pay.rec.title": { lv: "Reģistrēt maksājumu", ru: "Зарегистрировать платёж", en: "Record a payment" },
  "fin.pay.rec.amount": { lv: "Summa (EUR)", ru: "Сумма (EUR)", en: "Amount (EUR)" },
  "fin.pay.rec.amountHint": { lv: "Ne vairāk par atlikumu {amount}", ru: "Не больше остатка {amount}", en: "No more than the {amount} outstanding" },
  "fin.pay.rec.method": { lv: "Veids", ru: "Способ", en: "Method" },
  "fin.pay.rec.note": { lv: "Piezīme (neobligāti)", ru: "Заметка (необязательно)", en: "Note (optional)" },
  "fin.pay.rec.notePh": { lv: "Maksājuma uzdevuma nr., komentārs…", ru: "Номер платёжки, комментарий…", en: "Payment reference, comment…" },
  "fin.pay.rec.badAmount": { lv: "Ievadiet summu, kas lielāka par nulli — piem. 125,40", ru: "Введите сумму больше нуля — например 125,40", en: "Enter an amount greater than zero — e.g. 125.40" },
  "fin.pay.rec.tooMuch": { lv: "Vairāk nekā atlikums {amount}", ru: "Больше остатка {amount}", en: "More than the {amount} outstanding" },
  "fin.pay.rec.saved": { lv: "Maksājums reģistrēts", ru: "Платёж зарегистрирован", en: "Payment recorded" },
  "fin.pay.rec.failed": { lv: "Neizdevās reģistrēt maksājumu", ru: "Не удалось зарегистрировать платёж", en: "Couldn't record the payment" },
  "fin.pay.rec.invoiceCancelled": { lv: "Rēķins ir atcelts — maksājumus tam reģistrēt nevar.", ru: "Счёт отменён — платежи по нему регистрировать нельзя.", en: "This invoice is cancelled — payments can't be recorded against it." },
  "fin.pay.m.bank_transfer": { lv: "Pārskaitījums", ru: "Перечисление", en: "Bank transfer" },
  "fin.pay.m.cash": { lv: "Skaidra nauda", ru: "Наличные", en: "Cash" },
  "fin.pay.m.card": { lv: "Karte", ru: "Карта", en: "Card" },
  "fin.pay.m.other": { lv: "Cits", ru: "Другое", en: "Other" },

  // Cancel an invoice
  "fin.pay.cancel": { lv: "Atcelt rēķinu", ru: "Отменить счёт", en: "Cancel invoice" },
  "fin.pay.cancelBody": { lv: "Rēķins {number} vairs neieskaitīsies parādā. Tas paliek sarakstā ar atzīmi “Atcelts”.", ru: "Счёт {number} перестанет учитываться в задолженности. Он останется в списке с пометкой «Отменён».", en: "Invoice {number} stops counting towards what you owe. It stays in the list marked “Cancelled”." },
  "fin.pay.cancelDone": { lv: "Rēķins atcelts", ru: "Счёт отменён", en: "Invoice cancelled" },
  "fin.pay.cancelHasPayments": { lv: "Rēķinu nevar atcelt — tam jau ir reģistrēti maksājumi.", ru: "Счёт нельзя отменить — по нему уже есть платежи.", en: "This invoice can't be cancelled — it already has payments." },
  "fin.pay.actionFailed": { lv: "Darbība neizdevās", ru: "Действие не удалось", en: "Action failed" },

  // By supplier
  "fin.pay.sup.title": { lv: "Pa piegādātājiem", ru: "По поставщикам", en: "By supplier" },
  "fin.pay.sup.empty": { lv: "Nav neapmaksātu rēķinu.", ru: "Неоплаченных счетов нет.", en: "Nothing outstanding." },
  "fin.pay.sup.invoices": { lv: "rēķini", ru: "счетов", en: "invoices" },
  "fin.pay.sup.oldest": { lv: "vecākais termiņš", ru: "самый ранний срок", en: "oldest due" },
  "fin.pay.sup.overdue": { lv: "kavēts", ru: "просрочено", en: "overdue" },

  // Ageing
  "fin.pay.age.title": { lv: "Parāda vecums", ru: "Возраст задолженности", en: "Ageing" },
  "fin.pay.age.current": { lv: "Termiņā", ru: "В срок", en: "Current" },
  "fin.pay.age.d1_30": { lv: "1–30 d.", ru: "1–30 дн.", en: "1–30 d" },
  "fin.pay.age.d31_60": { lv: "31–60 d.", ru: "31–60 дн.", en: "31–60 d" },
  "fin.pay.age.d60plus": { lv: "60+ d.", ru: "60+ дн.", en: "60+ d" },

  // Invoice ↔ recorded cost reconciliation
  "fin.pay.rc.title": { lv: "Rēķini nesakrīt ar izmaksām", ru: "Счета расходятся с расходами", en: "Invoices that don't match recorded costs" },
  "fin.pay.rc.summary": { lv: "Pārbaudītas {n} piegādes · sakrīt {m}", ru: "Проверено поставок: {n} · совпадает: {m}", en: "{n} deliveries checked · {m} match" },
  "fin.pay.rc.invoiced": { lv: "Rēķinos", ru: "По счетам", en: "Invoiced" },
  "fin.pay.rc.recorded": { lv: "Reģistrēts", ru: "Учтено", en: "Recorded" },
  "fin.pay.rc.variance": { lv: "Starpība", ru: "Разница", en: "Variance" },
  "fin.pay.rc.noCost": { lv: "{n} vienībām nav iepirkuma cenas — starpība nav pilnīga", ru: "у {n} единиц нет закупочной цены — разница неполная", en: "{n} units have no purchase price — the variance is incomplete" },
} satisfies Record<string, Entry>;
