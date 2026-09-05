/**
 * Тексты кабинета поставщика — три языка, как и письма ему. Свой словарь,
 * а не общий витринный: у витрины пять языков и другая аудитория, а здесь
 * язык берётся из карточки поставщика, чтобы кабинет и письма говорили
 * одинаково.
 */
export type SupLang = "lv" | "ru" | "en";
export const SUP_LANGS: SupLang[] = ["lv", "ru", "en"];

export const SUP: Record<string, Record<SupLang, string>> = {
  // ── Вход ──
  "p.title": { lv: "Piegādātāja kabinets", ru: "Кабинет поставщика", en: "Supplier portal" },
  "p.loginSub": {
    lv: "Piekļuve tikai pēc uzaicinājuma. Ja saites nav — raksti savam menedžerim.",
    ru: "Доступ только по приглашению. Нет ссылки — напишите своему менеджеру.",
    en: "Access is by invitation only. No link? Write to your manager.",
  },
  "p.email": { lv: "E-pasts", ru: "Электронная почта", en: "E-mail" },
  "p.password": { lv: "Parole", ru: "Пароль", en: "Password" },
  "p.newPassword": { lv: "Jaunā parole", ru: "Новый пароль", en: "New password" },
  "p.login": { lv: "Ienākt", ru: "Войти", en: "Sign in" },
  "p.forgot": { lv: "Aizmirsu paroli", ru: "Забыли пароль", en: "Forgot password" },
  "p.forgotSent": {
    lv: "Ja tāds konts pastāv, saite ir nosūtīta uz e-pastu.",
    ru: "Если такой аккаунт есть, ссылка отправлена на почту.",
    en: "If that account exists, a link has been sent by e-mail.",
  },
  "p.badLogin": { lv: "Nepareizs e-pasts vai parole", ru: "Неверная почта или пароль", en: "Wrong e-mail or password" },
  "p.setPassword": { lv: "Izveidot paroli", ru: "Задать пароль", en: "Set your password" },
  "p.setPasswordSub": {
    lv: "Izvēlies paroli — vismaz 8 zīmes. Pēc tam varēsi ienākt kabinetā ar savu e-pastu.",
    ru: "Придумайте пароль — не короче 8 знаков. После этого вход в кабинет по вашей почте.",
    en: "Choose a password of at least 8 characters. After that you sign in with your e-mail.",
  },
  "p.inviteInvalid": {
    lv: "Saite vairs nav derīga. Palūdz menedžerim jaunu uzaicinājumu.",
    ru: "Ссылка больше не действует. Попросите менеджера прислать новое приглашение.",
    en: "This link is no longer valid. Ask your manager for a new invitation.",
  },
  "p.logout": { lv: "Iziet", ru: "Выйти", en: "Sign out" },
  "p.saved": { lv: "Saglabāts", ru: "Сохранено", en: "Saved" },
  "p.error": { lv: "Neizdevās. Mēģini vēlreiz.", ru: "Не получилось. Попробуйте ещё раз.", en: "That did not work. Try again." },
  "p.loading": { lv: "Ielādē…", ru: "Загружаем…", en: "Loading…" },

  // ── Вкладки ──
  "p.tab.home": { lv: "Sākums", ru: "Главная", en: "Home" },
  "p.tab.deliveries": { lv: "Piegādes", ru: "Поставки", en: "Deliveries" },
  "p.tab.sales": { lv: "Realizācija", ru: "Реализация", en: "Sales" },
  "p.tab.invoices": { lv: "Rēķini", ru: "Счета", en: "Invoices" },
  "p.tab.profile": { lv: "Profils", ru: "Профиль", en: "Profile" },

  // ── Главная ──
  "p.h.announced": { lv: "Pieteiktās piegādes", ru: "Заявленные поставки", en: "Announced deliveries" },
  "p.h.open": { lv: "Notiek pieņemšana", ru: "Идёт приёмка", en: "Being received" },
  "p.h.awaiting": { lv: "Gaida tavu atbildi", ru: "Ждут вашего ответа", en: "Awaiting your reply" },
  "p.h.inStock": { lv: "Noliktavā", ru: "На складе", en: "In stock" },
  "p.h.sold": { lv: "Pārdots", ru: "Продано", en: "Sold" },
  "p.h.owed": { lv: "Mēs esam parādā", ru: "Мы должны", en: "We owe you" },
  "p.h.nextDue": { lv: "Tuvākā apmaksa", ru: "Ближайшая оплата", en: "Next payment" },
  "p.h.model": { lv: "Sadarbības veids", ru: "Модель работы", en: "Model" },
  "p.h.buyout": { lv: "izpirkums", ru: "выкуп", en: "buy-out" },
  "p.h.commission": { lv: "komisija", ru: "комиссия", en: "commission" },
  "p.h.terms": { lv: "Apmaksas termiņš", ru: "Срок оплаты", en: "Payment terms" },
  "p.h.days": { lv: "dienas", ru: "дн.", en: "days" },

  // ── Поставки ──
  "p.d.new": { lv: "Pieteikt piegādi", ru: "Заявить поставку", en: "Announce a delivery" },
  "p.d.count": { lv: "Vienību skaits", ru: "Количество единиц", en: "Number of units" },
  "p.d.when": { lv: "Plānotais datums", ru: "Планируемая дата", en: "Planned date" },
  "p.d.notes": { lv: "Piezīmes (nav obligāti)", ru: "Примечания (необязательно)", en: "Notes (optional)" },
  "p.d.send": { lv: "Nosūtīt pieteikumu", ru: "Отправить заявку", en: "Send the announcement" },
  "p.d.ref": { lv: "Piegāde", ru: "Поставка", en: "Delivery" },
  "p.d.declared": { lv: "Pieteikts", ru: "Заявлено", en: "Declared" },
  "p.d.received": { lv: "Pieņemts", ru: "Принято", en: "Accepted" },
  "p.d.empty": { lv: "Piegāžu vēl nav.", ru: "Поставок пока нет.", en: "No deliveries yet." },
  "p.d.st.announced": { lv: "Pieteikta", ru: "Заявлена", en: "Announced" },
  "p.d.st.open": { lv: "Notiek pieņemšana", ru: "Идёт приёмка", en: "Being received" },
  "p.d.st.closed": { lv: "Pieņemta", ru: "Принята", en: "Accepted" },
  "p.d.discrepancy": { lv: "Neatbilstība", ru: "Расхождение", en: "Discrepancy" },
  "p.d.replyBy": { lv: "Atbildēt līdz", ru: "Ответить до", en: "Reply by" },
  "p.d.accept": { lv: "Piekrītu aktam", ru: "Согласен с актом", en: "I accept the report" },
  "p.d.dispute": { lv: "Apstrīdu", ru: "Оспариваю", en: "I dispute it" },
  "p.d.disputeNote": { lv: "Kas tieši nesakrīt?", ru: "Что именно не сходится?", en: "What exactly does not add up?" },
  "p.d.replied": { lv: "Atbilde nosūtīta", ru: "Ответ отправлен", en: "Reply sent" },
  "p.d.noteRequired": { lv: "Aprakstiet, kas nesakrīt.", ru: "Опишите, что не сходится.", en: "Describe what does not add up." },

  // ── Реализация ──
  "p.s.sold": { lv: "Pārdotās vienības", ru: "Продано единиц", en: "Units sold" },
  "p.s.gross": { lv: "Pārdošanas apjoms", ru: "Объём продаж", en: "Sales volume" },
  "p.s.commission": { lv: "Mūsu komisija", ru: "Наша комиссия", en: "Our commission" },
  "p.s.payout": { lv: "Tev izmaksai", ru: "К выплате вам", en: "Due to you" },
  "p.s.sellThrough": { lv: "Pārdošanas īpatsvars", ru: "Процент продажи", en: "Sell-through" },
  "p.s.item": { lv: "Prece", ru: "Товар", en: "Item" },
  "p.s.price": { lv: "Pārdošanas cena", ru: "Цена продажи", en: "Sale price" },
  "p.s.date": { lv: "Datums", ru: "Дата", en: "Date" },
  "p.s.empty": { lv: "Periodā nekas nav pārdots.", ru: "За период ничего не продано.", en: "Nothing sold in this period." },

  // ── Счета ──
  "p.i.upload": { lv: "Iesniegt rēķinu", ru: "Загрузить счёт", en: "Submit an invoice" },
  "p.i.number": { lv: "Rēķina numurs", ru: "Номер счёта", en: "Invoice number" },
  "p.i.date": { lv: "Rēķina datums", ru: "Дата счёта", en: "Invoice date" },
  "p.i.amount": { lv: "Summa, €", ru: "Сумма, €", en: "Amount, €" },
  "p.i.delivery": { lv: "Par piegādi", ru: "За поставку", en: "For delivery" },
  "p.i.file": { lv: "PDF vai foto", ru: "PDF или фото", en: "PDF or photo" },
  "p.i.send": { lv: "Iesniegt", ru: "Отправить", en: "Submit" },
  "p.i.due": { lv: "Apmaksa", ru: "Оплата", en: "Payment" },
  "p.i.status": { lv: "Statuss", ru: "Статус", en: "Status" },
  "p.i.paid": { lv: "Apmaksāts", ru: "Оплачено", en: "Paid" },
  "p.i.payments": { lv: "Maksājumi", ru: "Платежи", en: "Payments" },
  "p.i.empty": { lv: "Rēķinu vēl nav.", ru: "Счетов пока нет.", en: "No invoices yet." },
  "p.i.dup": { lv: "Rēķins ar šādu numuru jau ir iesniegts.", ru: "Счёт с таким номером уже загружен.", en: "An invoice with that number already exists." },
  "p.i.ap.pending": { lv: "Pārbaudē", ru: "На проверке", en: "In review" },
  "p.i.ap.approved": { lv: "Apstiprināts", ru: "Согласован", en: "Approved" },
  "p.i.ap.auto": { lv: "Apstiprināts", ru: "Согласован", en: "Approved" },
  "p.i.ap.rejected": { lv: "Noraidīts", ru: "Отклонён", en: "Rejected" },
  "p.i.st.unpaid": { lv: "Gaida apmaksu", ru: "Ожидает оплаты", en: "Awaiting payment" },
  "p.i.st.partly_paid": { lv: "Daļēji apmaksāts", ru: "Оплачен частично", en: "Partly paid" },
  "p.i.st.paid": { lv: "Apmaksāts", ru: "Оплачен", en: "Paid" },
  "p.i.st.cancelled": { lv: "Atcelts", ru: "Отменён", en: "Cancelled" },

  // ── Профиль ──
  "p.pr.company": { lv: "Uzņēmums", ru: "Компания", en: "Company" },
  "p.pr.contact": { lv: "Kontaktpersona", ru: "Контактное лицо", en: "Contact person" },
  "p.pr.phone": { lv: "Tālrunis", ru: "Телефон", en: "Phone" },
  "p.pr.address": { lv: "Adrese", ru: "Адрес", en: "Address" },
  "p.pr.lang": { lv: "Sarakstes valoda", ru: "Язык переписки", en: "Correspondence language" },
  "p.pr.bank": { lv: "Bankas konts", ru: "Банковский счёт", en: "Bank account" },
  "p.pr.bankPending": {
    lv: "Jaunais konts gaida apstiprinājumu no menedžera. Līdz tam maksājam uz veco.",
    ru: "Новый счёт ждёт подтверждения менеджера. До этого платим на старый.",
    en: "The new account is awaiting your manager's confirmation. Until then we pay to the old one.",
  },
  "p.pr.bankNote": {
    lv: "Konta maiņa stājas spēkā tikai pēc mūsu apstiprinājuma — tā mēs pasargājam abus no krāpniecības.",
    ru: "Смена счёта вступает в силу только после нашего подтверждения — так мы защищаем обе стороны от мошенничества.",
    en: "A bank-account change takes effect only after we confirm it — that protects both sides from fraud.",
  },
  "p.pr.save": { lv: "Saglabāt", ru: "Сохранить", en: "Save" },
  "p.pr.changePassword": { lv: "Nomainīt paroli", ru: "Сменить пароль", en: "Change password" },
  "p.pr.currentPassword": { lv: "Pašreizējā parole", ru: "Текущий пароль", en: "Current password" },
};

export const supT = (lang: SupLang) => (key: string, vars?: Record<string, string | number>): string => {
  const raw = SUP[key]?.[lang] ?? key;
  return vars ? raw.replace(/\{(\w+)\}/g, (m, k: string) => String(vars[k] ?? m)) : raw;
};
