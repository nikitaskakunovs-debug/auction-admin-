import type { Entry } from "./types.js";

/** Filled by the Phase D translation pass — one module per screen area. */
export const FINANCE = {
  // ── Screen / tabs ──────────────────────────────────────────────────────────
  "fin.title": { lv: "Finanses", ru: "Финансы", en: "Finance" },
  "fin.tab.payments": { lv: "Maksājumi", ru: "Платежи", en: "Payments" },
  "fin.tab.invoices": { lv: "Rēķini", ru: "Счета", en: "Invoices" },
  "fin.tab.vat": { lv: "PVN atskaite", ru: "Отчёт НДС", en: "VAT report" },

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
} satisfies Record<string, Entry>;
