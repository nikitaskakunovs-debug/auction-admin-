import type { Entry } from "./types.js";

/** Filled by the Phase D translation pass — one module per screen area. */
export const CUSTOMERS = {
  // ── Header / toolbar ───────────────────────────────────────────────────────
  "cust.title": { lv: "Solītāji", ru: "Участники торгов", en: "Bidders" },
  "cust.new": { lv: "Jauns solītājs", ru: "Новый участник", en: "New bidder" },
  "cust.segments": { lv: "Segmenti", ru: "Сегменты", en: "Segments" },
  "cust.saveSegment": { lv: "+ Saglabāt segmentu", ru: "+ Сохранить сегмент", en: "+ Save segment" },
  "cust.nounSegment": { lv: "segments", ru: "сегмент", en: "segment" },
  "cust.nounBidders": { lv: "solītāji", ru: "участников", en: "bidders" },
  "cust.exportTitle": { lv: "Solītāju eksports", ru: "Экспорт участников", en: "Bidders export" },

  // ── Status pills ───────────────────────────────────────────────────────────
  "cust.pill.active": { lv: "Aktīvie", ru: "Активные", en: "Active" },
  "cust.pill.blocked": { lv: "Bloķētie", ru: "Заблокированные", en: "Blocked" },
  "cust.pill.strikes": { lv: "Brīdinājumi", ru: "Страйки", en: "Strikes" },
  "cust.pill.erased": { lv: "Dzēstie", ru: "Удалённые", en: "Erased" },

  // ── Sorts ──────────────────────────────────────────────────────────────────
  "cust.sort.newest": { lv: "Jaunākie vispirms", ru: "Сначала новые", en: "Newest first" },
  "cust.sort.oldest": { lv: "Vecākie vispirms", ru: "Сначала старые", en: "Oldest first" },
  "cust.sort.alias": { lv: "Segvārds A→Z", ru: "Псевдоним A→Z", en: "Alias A→Z" },
  "cust.sort.strikes": { lv: "Visvairāk brīdinājumu", ru: "Больше всего страйков", en: "Most strikes" },

  // ── Countries ──────────────────────────────────────────────────────────────
  "cust.country.lv": { lv: "Latvija", ru: "Латвия", en: "Latvia" },
  "cust.country.ee": { lv: "Igaunija", ru: "Эстония", en: "Estonia" },
  "cust.country.lt": { lv: "Lietuva", ru: "Литва", en: "Lithuania" },
  "cust.country.other": { lv: "Cita", ru: "Другая", en: "Other" },

  // ── Filter bar / chips ─────────────────────────────────────────────────────
  "cust.searchPh": { lv: "Meklēt segvārdu, e-pastu vai vārdu…", ru: "Поиск по псевдониму, почте или имени…", en: "Search alias, email or name…" },
  "cust.allTags": { lv: "Visas birkas", ru: "Все метки", en: "All tags" },
  "cust.allCountries": { lv: "Visas valstis", ru: "Все страны", en: "All countries" },
  "cust.anyBalance": { lv: "Jebkura bilance", ru: "Любой баланс", en: "Any balance" },
  "cust.hasFees": { lv: "Ir neapmaksātas maksas", ru: "Есть задолженность", en: "Has outstanding fees" },
  "cust.chip.tag": { lv: "Birka:", ru: "Метка:", en: "Tag:" },
  "cust.chip.country": { lv: "Valsts:", ru: "Страна:", en: "Country:" },
  "cust.chip.from": { lv: "No", ru: "С", en: "From" },
  "cust.chip.to": { lv: "Līdz", ru: "По", en: "To" },

  // ── Table ──────────────────────────────────────────────────────────────────
  "cust.th.bidder": { lv: "Solītājs", ru: "Участник", en: "Bidder" },
  "cust.th.tags": { lv: "Birkas", ru: "Метки", en: "Tags" },
  "cust.th.country": { lv: "Valsts", ru: "Страна", en: "Country" },
  "cust.th.strikes": { lv: "Brīdinājumi", ru: "Страйки", en: "Strikes" },
  "cust.th.feesDue": { lv: "Parāds", ru: "Долг", en: "Fees due" },
  // Журнал согласий на cookie
  "cons.title": { lv: "Sīkdatņu piekrišanas", ru: "Согласия на cookie", en: "Cookie consents" },
  "cons.intro": { lv: "Katrs lēmums ir atsevišķs ieraksts — tā redzama arī vēsture, ja cilvēks vispirms piekrita un pēc tam atsauca. Ierakstus nepārraksta.", ru: "Каждое решение — отдельная запись, поэтому видна и история: сперва согласился, потом отозвал. Записи не переписываются.", en: "Every decision is its own row, so the history stays visible when someone agrees and later withdraws. Rows are never rewritten." },
  "cons.all": { lv: "Visi", ru: "Все", en: "All" },
  "cons.accept": { lv: "Pieņēma visas", ru: "Принял все", en: "Accepted all" },
  "cons.reject": { lv: "Noraidīja visas", ru: "Отклонил все", en: "Rejected all" },
  "cons.custom": { lv: "Izvēlējās pats", ru: "Выбрал сам", en: "Chose their own" },
  "cons.search": { lv: "E-pasts vai pārlūka numurs…", ru: "Почта или номер браузера…", en: "Email or browser id…" },
  "cons.guest": { lv: "viesis", ru: "гость", en: "guest" },
  "cons.empty": { lv: "Piekrišanu vēl nav", ru: "Согласий пока нет", en: "No consents yet" },
  "cons.emptyHint": { lv: "Tās parādīsies, tiklīdz apmeklētāji atbildēs uz sīkdatņu paziņojumu.", ru: "Они появятся, как только посетители ответят на плашку о cookie.", en: "They appear as soon as visitors answer the cookie notice." },
  "cons.loadFailed": { lv: "Neizdevās ielādēt piekrišanas", ru: "Не удалось загрузить согласия", en: "Could not load consents" },
  "cons.th.when": { lv: "Kad", ru: "Когда", en: "When" },
  "cons.th.who": { lv: "Kas", ru: "Кто", en: "Who" },
  "cons.th.decision": { lv: "Lēmums", ru: "Решение", en: "Decision" },
  "cons.th.analytics": { lv: "Analītika", ru: "Аналитика", en: "Analytics" },
  "cons.th.marketing": { lv: "Mārketings", ru: "Маркетинг", en: "Marketing" },
  "cons.th.site": { lv: "Vietne", ru: "Сайт", en: "Site" },
  "cons.th.version": { lv: "Teksta redakcija", ru: "Редакция текста", en: "Policy version" },
  "cust.th.marketing": { lv: "Jaunumi", ru: "Рассылка", en: "Marketing" },
  "cust.mk.yes": { lv: "Piekritis", ru: "Согласен", en: "Opted in" },
  "cust.mk.no": { lv: "nav", ru: "нет", en: "no" },
  "cust.th.joined": { lv: "Reģistrējies", ru: "Регистрация", en: "Joined" },
  "cust.aria.selectAll": { lv: "Atzīmēt visus redzamos solītājus", ru: "Выбрать всех видимых участников", en: "Select all visible bidders" },
  "cust.aria.select": { lv: "Atzīmēt", ru: "Выбрать", en: "Select" },
  "cust.st.active": { lv: "aktīvs", ru: "активен", en: "active" },
  "cust.st.blocked": { lv: "bloķēts", ru: "заблокирован", en: "blocked" },
  "cust.st.erased": { lv: "dzēsts", ru: "удалён", en: "erased" },
  "cust.empty": { lv: "Neviens solītājs neatbilst šiem filtriem.", ru: "Ни один участник не подходит под фильтры.", en: "No bidders match these filters." },

  // ── Toasts / errors ────────────────────────────────────────────────────────
  "cust.loadMoreFailed": { lv: "Neizdevās ielādēt vairāk", ru: "Не удалось загрузить ещё", en: "Failed to load more" },
  "cust.nothingToExport": { lv: "Nav ko eksportēt", ru: "Нечего экспортировать", en: "Nothing to export" },
  "cust.exportFailed": { lv: "Eksports neizdevās", ru: "Экспорт не удался", en: "Export failed" },
  "cust.exported": { lv: "Eksportēti solītāji", ru: "Экспортировано участников", en: "Exported bidders" },
  "cust.bulkUpdated": { lv: "Solītāji atjaunināti", ru: "Участники обновлены", en: "Bidders updated" },
  "cust.tagFailed": { lv: "Birku piešķiršana neizdevās", ru: "Не удалось назначить метки", en: "Tagging failed" },
  "cust.created": { lv: "Solītājs izveidots", ru: "Участник создан", en: "Bidder created" },
  "cust.createFailed": { lv: "Neizdevās izveidot", ru: "Не удалось создать", en: "Create failed" },
  "cust.saved": { lv: "Solītājs saglabāts", ru: "Участник сохранён", en: "Bidder saved" },
  "cust.saveFailed": { lv: "Saglabāšana neizdevās", ru: "Не удалось сохранить", en: "Save failed" },
  "cust.tagUpdateFailed": { lv: "Birku atjaunināšana neizdevās", ru: "Не удалось обновить метки", en: "Tag update failed" },
  "cust.failed": { lv: "Neizdevās", ru: "Не удалось", en: "Failed" },

  // ── Bulk bar ───────────────────────────────────────────────────────────────
  "cust.bulk.addTag": { lv: "Pievienot birku ▾", ru: "Добавить метку ▾", en: "Add tag ▾" },
  "cust.bulk.removeTag": { lv: "Noņemt birku ▾", ru: "Убрать метку ▾", en: "Remove tag ▾" },
  "cust.bulk.exportCsv": { lv: "Eksportēt CSV", ru: "Экспорт CSV", en: "Export CSV" },

  // ── Create / edit form ─────────────────────────────────────────────────────
  "cust.f.email": { lv: "E-pasts", ru: "Эл. почта", en: "Email" },
  "cust.f.alias": { lv: "Segvārds", ru: "Псевдоним", en: "Alias" },
  "cust.f.aliasHint": { lv: "Publiskais vārds, kas redzams solījumu žurnālos.", ru: "Публичное имя, видимое в журнале ставок.", en: "Public display name shown in bid ledgers." },
  "cust.f.fullName": { lv: "Vārds, uzvārds", ru: "Полное имя", en: "Full name" },
  "cust.f.country": { lv: "Valsts", ru: "Страна", en: "Country" },
  "cust.f.company": { lv: "Uzņēmums", ru: "Компания", en: "Company" },
  "cust.f.vatNo": { lv: "PVN numurs", ru: "VAT-номер", en: "VAT number" },

  // ── Drawer: stats / tags ───────────────────────────────────────────────────
  "cust.stat.bids": { lv: "Solījumi", ru: "Ставки", en: "Bids" },
  "cust.stat.auctions": { lv: "Izsoles", ru: "Аукционы", en: "Auctions" },
  "cust.tagsHint": { lv: "Pieskarieties, lai ieslēgtu/izslēgtu. Birkas pārvalda Iestatījumi → Birkas.", ru: "Нажмите, чтобы переключить. Список меток — в Настройки → Метки.", en: "Tap to toggle. Manage the vocabulary in Settings → Tags." },
  "cust.noTagsDefined": { lv: "Vēl nav definētu birku.", ru: "Метки ещё не заданы.", en: "No tags defined yet." },

  // ── VIES ───────────────────────────────────────────────────────────────────
  "cust.vies.title": { lv: "VIES pārbaude", ru: "Проверка VIES", en: "VIES check" },
  "cust.vies.valid": { lv: "derīgs", ru: "действителен", en: "valid" },
  "cust.vies.invalid": { lv: "nederīgs", ru: "недействителен", en: "invalid" },
  "cust.vies.notVerified": { lv: "nav pārbaudīts", ru: "не проверен", en: "not verified" },
  "cust.vies.checked": { lv: "pārbaudīts", ru: "проверено", en: "checked" },
  "cust.vies.recheck": { lv: "Pārbaudīt vēlreiz", ru: "Проверить заново", en: "Re-check" },
  "cust.vies.validate": { lv: "Pārbaudīt", ru: "Проверить", en: "Validate" },
  "cust.vies.failed": { lv: "VIES pārbaude neizdevās", ru: "Проверка VIES не удалась", en: "VIES check failed" },
  "cust.vies.toastValidPre": { lv: "VIES: derīgs · konsultācija", ru: "VIES: действителен · консультация", en: "VIES: valid · consultation" },
  "cust.vies.toastInvalid": { lv: "VIES: numuru NEIZDEVĀS apstiprināt — nepiemērojiet 0% likmi", ru: "VIES: номер НЕ прошёл проверку — не применяйте ставку 0%", en: "VIES: number could NOT be validated — do not zero-rate" },

  // ── Suspend / reinstate / strike ───────────────────────────────────────────
  "cust.suspendedTitle": { lv: "Konts apturēts", ru: "Аккаунт заблокирован", en: "Account suspended" },
  "cust.noReason": { lv: "Iemesls nav norādīts", ru: "Причина не указана", en: "No reason recorded" },
  "cust.ban.titlePre": { lv: "Apturēt kontu", ru: "Заблокировать", en: "Suspend" },
  "cust.ban.body": { lv: "Konts vairs nevarēs pieteikties, lai solītu vai pirktu. Izmantojiet nulles tolerances gadījumos (draudi, rupjības, agresija pret darbiniekiem) vai pēc atkārtotiem brīdinājumiem. Iemesls nonāk audita žurnālā.", ru: "Аккаунт больше не сможет войти, чтобы делать ставки или покупать. Используйте при недопустимом поведении (угрозы, оскорбления, агрессия к персоналу) или при повторных страйках. Причина попадает в журнал аудита.", en: "The account can no longer sign in to bid or buy. Use for zero-tolerance behaviour (threats, verbal abuse, aggression towards staff) or repeated strikes. The reason goes to the audit log." },
  "cust.ban.confirm": { lv: "Apturēt kontu", ru: "Заблокировать аккаунт", en: "Suspend account" },
  "cust.ban.done": { lv: "Konts apturēts", ru: "Аккаунт заблокирован", en: "Account suspended" },
  "cust.unban.titlePre": { lv: "Atjaunot kontu", ru: "Разблокировать", en: "Reinstate" },
  "cust.unban.body": { lv: "Konts atkal varēs solīt un pirkt (neapmaksātas atgriešanas maksas joprojām aptur solīšanu, līdz tās nokārtotas). Iemesls nonāk audita žurnālā.", ru: "Аккаунт снова сможет делать ставки и покупать (непогашенные сборы за возврат всё ещё приостанавливают ставки до оплаты). Причина попадает в журнал аудита.", en: "The account can bid and buy again (outstanding restock fees still pause bidding until settled). The reason goes to the audit log." },
  "cust.unban.confirm": { lv: "Atjaunot", ru: "Разблокировать", en: "Reinstate" },
  "cust.unban.done": { lv: "Konts atjaunots", ru: "Аккаунт разблокирован", en: "Account reinstated" },
  "cust.strike.titlePre": { lv: "Pievienot brīdinājumu:", ru: "Добавить страйк:", en: "Add a strike to" },
  "cust.strike.body": { lv: "Brīdinājumi uzskaita neapmaksātu uzvaru gadījumus. Atkārtoti brīdinājumi parasti nozīmē konta bloķēšanu.", ru: "Страйки фиксируют неоплаченные выигрыши. Повторные страйки обычно ведут к блокировке аккаунта.", en: "Strikes track unpaid-winner behaviour. Repeated strikes usually mean blocking the account." },
  "cust.strike.confirm": { lv: "Pievienot brīdinājumu", ru: "Добавить страйк", en: "Add strike" },
  "cust.strike.added": { lv: "Brīdinājums pievienots", ru: "Страйк добавлен", en: "Strike added" },

  // ── GDPR erase ─────────────────────────────────────────────────────────────
  "cust.erase.btn": { lv: "GDPR dzēšana", ru: "GDPR-удаление", en: "GDPR erase" },
  "cust.erase.titlePre": { lv: "Dzēst (GDPR)", ru: "Стереть (GDPR)", en: "GDPR-erase" },
  "cust.erase.body": { lv: "Personas dati (vārds, uzņēmums, PVN numurs, e-pasts) tiek neatgriezeniski dzēsti, un konts tiek bloķēts. Iepriekšējie pasūtījumi saglabā anonimizētas kopijas grāmatvedībai. Šo darbību nevar atsaukt.", ru: "Персональные данные (имя, компания, VAT-номер, почта) удаляются безвозвратно, и аккаунт блокируется. Прошлые заказы сохраняют анонимизированные копии для бухгалтерии. Это действие нельзя отменить.", en: "Personal data (name, company, VAT number, email) is permanently removed and the account blocked. Past orders keep their anonymised snapshots for accounting. This cannot be undone." },
  "cust.erase.confirm": { lv: "Dzēst", ru: "Стереть", en: "Erase" },
  "cust.erase.done": { lv: "Personas dati dzēsti", ru: "Персональные данные удалены", en: "Personal data erased" },
  "cust.erase.failed": { lv: "Dzēšana neizdevās", ru: "Не удалось удалить", en: "Erase failed" },

  // ── Restock fees ───────────────────────────────────────────────────────────
  "cust.fees.title": { lv: "Atgriešanas maksas", ru: "Сборы за возврат", en: "Restock fees" },
  "cust.fees.order": { lv: "Pasūtījums", ru: "Заказ", en: "Order" },
  "cust.fees.type": { lv: "Tips", ru: "Тип", en: "Type" },
  "cust.fees.amount": { lv: "Summa", ru: "Сумма", en: "Amount" },
  "cust.fees.unpaid": { lv: "neapmaksāts", ru: "не оплачен", en: "unpaid" },
  "cust.fees.noPickup": { lv: "nav izņemts", ru: "не забран", en: "no pickup" },
  "cust.fees.st.outstanding": { lv: "neapmaksāta", ru: "к оплате", en: "outstanding" },
  "cust.fees.st.settled": { lv: "nokārtota", ru: "погашен", en: "settled" },
  "cust.fees.st.waived": { lv: "atlaista", ru: "списан", en: "waived" },
  "cust.fees.settle": { lv: "Nokārtot", ru: "Погасить", en: "Settle" },
  "cust.fees.waive": { lv: "Atlaist", ru: "Списать", en: "Waive" },
  "cust.fees.waiveTitlePre": { lv: "Atlaist", ru: "Списать", en: "Waive" },
  "cust.fees.waiveTitleFor": { lv: "par", ru: "за", en: "for" },
  "cust.fees.waiveBody": { lv: "Prasība tiek atcelta, un konts tiek atbloķēts. Iemesls nonāk audita žurnālā.", ru: "Требование снимается, и аккаунт разблокируется. Причина попадает в журнал аудита.", en: "The claim is dropped and the account unblocks. Reason goes to the audit log." },
  "cust.fees.waiveConfirm": { lv: "Atlaist maksu", ru: "Списать сбор", en: "Waive fee" },
  "cust.fees.settled": { lv: "Maksa nokārtota — konts atbloķēts", ru: "Сбор погашен — аккаунт разблокирован", en: "Fee settled — account unblocked" },
  "cust.fees.waived": { lv: "Maksa atlaista", ru: "Сбор списан", en: "Fee waived" },
  "cust.fees.actionFailed": { lv: "Darbība neizdevās", ru: "Действие не удалось", en: "Action failed" },

  // ── Orders section ─────────────────────────────────────────────────────────
  "cust.orders.title": { lv: "Pasūtījumi", ru: "Заказы", en: "Orders" },
  "cust.orders.ref": { lv: "Nr.", ru: "Реф.", en: "Ref" },
  "cust.orders.empty": { lv: "Vēl nav pasūtījumu.", ru: "Заказов пока нет.", en: "No orders yet." },
} satisfies Record<string, Entry>;
