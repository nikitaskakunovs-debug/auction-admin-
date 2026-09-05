import type { Entry } from "./types.js";

/**
 * «Откуда пришёл» и всё, что отвечает на вопрос «что мы про этого человека
 * знаем»: касания рекламы, согласия, способ входа, письма.
 *
 * Слова подобраны так, чтобы их понимал не маркетолог: не «атрибуция первого
 * касания», а «кто привёл» — вопрос, который на самом деле задают.
 */
export const ATTRIBUTION = {
  "attr.title": { lv: "No kurienes atnāca", ru: "Откуда пришёл", en: "Where they came from" },
  "attr.first": { lv: "Atveda", ru: "Привёл", en: "Brought them" },
  "attr.last": { lv: "Atgrieza", ru: "Вернуло", en: "Brought them back" },
  "attr.direct": { lv: "Tiešā ienākšana", ru: "Прямой заход", en: "Direct" },
  "attr.none": {
    lv: "Metku nav — cilvēks atnāca tieši vai reģistrējās pirms metku uzskaites.",
    ru: "Меток нет — человек пришёл напрямую либо зарегистрировался до учёта меток.",
    en: "No tags — they arrived directly, or signed up before tagging existed.",
  },
  "attr.content": { lv: "Sludinājums", ru: "Объявление", en: "Ad content" },
  "attr.term": { lv: "Atslēgvārds", ru: "Ключевое слово", en: "Keyword" },
  "attr.landing": { lv: "Ienāca lapā", ru: "Вошёл на страницу", en: "Landed on" },
  "attr.referrer": { lv: "Pārgāja no", ru: "Перешёл с", en: "Referred by" },
  "attr.when": { lv: "Kad", ru: "Когда", en: "When" },
  "attr.touches": { lv: "Apmeklējumi ar metku", ru: "Визитов по метке", en: "Tagged visits" },
  "attr.orderNote": {
    lv: "Momentuzņēmums pasūtījuma brīdī — vēlākas klienta izmaiņas šo skaitli nemaina.",
    ru: "Снимок на момент заказа — более поздние визиты клиента его уже не меняют.",
    en: "Snapshot taken when the order was placed — later visits do not change it.",
  },

  // ── Карточка клиента: согласия и связь ───────────────────────────────────
  "cd.consents": { lv: "Piekrišanas", ru: "Согласия", en: "Consents" },
  "cd.consent.cookies": { lv: "Sīkdatnes", ru: "Cookie", en: "Cookies" },
  "cd.consent.mode.accept": { lv: "Pieņemtas visas", ru: "Приняты все", en: "All accepted" },
  "cd.consent.mode.reject": { lv: "Noraidītas", ru: "Отклонены", en: "Rejected" },
  "cd.consent.mode.custom": { lv: "Izvēlētas", ru: "Выборочно", en: "Custom" },
  "cd.consent.analytics": { lv: "Analītika", ru: "Аналитика", en: "Analytics" },
  "cd.consent.marketing": { lv: "Reklāma", ru: "Реклама", en: "Marketing" },
  "cd.consent.version": { lv: "Redakcija", ru: "Редакция", en: "Policy version" },
  "cd.consent.beforeSignup": { lv: "pirms reģistrācijas", ru: "до регистрации", en: "before sign-up" },
  "cd.consent.none": {
    lv: "Sīkdatņu izvēle nav reģistrēta: paziņojums vēl nav parādīts vai izvēle veikta citā pārlūkā.",
    ru: "Выбор по cookie не записан: плашка ещё не показывалась либо решение принято в другом браузере.",
    en: "No cookie choice recorded: the banner has not been answered, or the choice was made in another browser.",
  },
  "cd.mail.subject": { lv: "Temats", ru: "Тема", en: "Subject" },
  "cd.mail.title": { lv: "Vēstules", ru: "Письма", en: "Emails" },
  "cd.mail.none": { lv: "Vēstules vēl nav sūtītas.", ru: "Письма ещё не отправлялись.", en: "No emails sent yet." },
  "cd.mail.scheduled": { lv: "gaida", ru: "ждёт", en: "scheduled" },
  "cd.mail.marketing": { lv: "reklāma", ru: "рассылка", en: "marketing" },
  "cd.unsubscribed": { lv: "Atteicies no jaunumiem", ru: "Отписался от рассылки", en: "Unsubscribed" },
  "cd.bounced": { lv: "Adrese neatbild", ru: "Адрес не отвечает", en: "Email bounced" },
  "cd.sessions": { lv: "Aktīvās sesijas", ru: "Активные сессии", en: "Active sessions" },
  "cd.sessions.none": { lv: "Nav aktīvu sesiju.", ru: "Активных сессий нет.", en: "No active sessions." },
  "cd.lastLogin": { lv: "Pēdējā ieiešana", ru: "Последний вход", en: "Last sign-in" },
  "cd.login.password": { lv: "ar paroli", ru: "по паролю", en: "with a password" },
  "cd.interests": { lv: "Intereses", ru: "Интересы", en: "Interests" },
  "cd.searches": { lv: "Saglabātie meklējumi", ru: "Сохранённые поиски", en: "Saved searches" },
  "cd.watchlist": { lv: "Vēlmju sarakstā", ru: "В списке желаний", en: "On the watchlist" },
  "cd.alertOn": { lv: "ar brīdinājumu", ru: "с оповещением", en: "with alerts" },
  "cd.lifetime": { lv: "Atnesis kopā", ru: "Принёс всего", en: "Lifetime value" },
  "cd.buyer": { lv: "Pircējs", ru: "Покупатель", en: "Buyer" },
  "cd.buyer.orders": { lv: "pasūtījumi", ru: "заказов", en: "orders" },
  "cd.openCustomer": { lv: "Atvērt klientu", ru: "Открыть клиента", en: "Open customer" },

  // ── Отчёт: модель атрибуции и расшифровка строки ─────────────────────────
  "mk.model": { lv: "Modelis", ru: "Модель", en: "Model" },
  "mk.model.first": { lv: "Kas atveda", ru: "Кто привёл", en: "First touch" },
  "mk.model.last": { lv: "Kas atgrieza", ru: "Что вернуло", en: "Last touch" },
  "mk.modelHint": {
    lv: "«Kas atveda» rāda, kurš kanāls klientu atradis. «Kas atgrieza» — kurš noveda līdz šim pirkumam: tikai tur redzama vēstuļu un remārketinga atdeve.",
    ru: "«Кто привёл» показывает, какой канал нашёл клиента. «Что вернуло» — что довело до этой покупки: только там видна отдача писем и ретаргетинга.",
    en: "“First touch” shows which channel found the customer. “Last touch” shows what closed this purchase — the only place email and retargeting show their worth.",
  },
  "mk.detail": { lv: "Kas tieši atnāca", ru: "Кто именно пришёл", en: "Who exactly came" },
  "mk.detail.regs": { lv: "Reģistrācijas", ru: "Регистрации", en: "Sign-ups" },
  "mk.detail.orders": { lv: "Pasūtījumi", ru: "Заказы", en: "Orders" },
  "mk.detail.empty": { lv: "Šajā rindā nav neviena ieraksta.", ru: "В этой строке ни одной записи.", en: "Nothing in this row." },
  "mk.detail.openOrders": { lv: "Atvērt sarakstā", ru: "Открыть в списке", en: "Open in the list" },
  "mk.rowHint": { lv: "Nospied rindu, lai redzētu, kas tieši atnāca.", ru: "Нажмите на строку, чтобы увидеть, кто именно пришёл.", en: "Click a row to see exactly who came." },
} satisfies Record<string, Entry>;
