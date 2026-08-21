import type { Entry } from "./types.js";

/** Отдача рекламы: регистрации, заказы и выручка по кампаниям (атрибуция
 * первого касания). */
export const MARKETING = {
  "sh.nav.marketing": { lv: "Mārketings", ru: "Маркетинг", en: "Marketing" },
  "mk.title": { lv: "Reklāmas atdeve", ru: "Отдача рекламы", en: "Marketing performance" },
  "mk.intro": {
    lv: "No kurienes nāk reģistrācijas un pirkumi: utm-metkas no reklāmas saitēm un pirmā apmeklējuma avots. Ieņēmumi — tikai apmaksātie pasūtījumi.",
    ru: "Откуда приходят регистрации и покупки: utm-метки рекламных ссылок и источник первого визита. Выручка — только оплаченные заказы.",
    en: "Where registrations and purchases come from: utm tags from ad links and the first-visit source. Revenue counts paid orders only.",
  },
  "mk.from": { lv: "No", ru: "С", en: "From" },
  "mk.to": { lv: "Līdz", ru: "По", en: "To" },
  "mk.source": { lv: "Avots", ru: "Источник", en: "Source" },
  "mk.campaign": { lv: "Kampaņa", ru: "Кампания", en: "Campaign" },
  "mk.registrations": { lv: "Reģistrācijas", ru: "Регистрации", en: "Sign-ups" },
  "mk.orders": { lv: "Pasūtījumi", ru: "Заказы", en: "Orders" },
  "mk.paid": { lv: "Apmaksāti", ru: "Оплачено", en: "Paid" },
  "mk.revenue": { lv: "Ieņēmumi", ru: "Выручка", en: "Revenue" },
  "mk.revPerReg": { lv: "€ / reģ.", ru: "€ / рег.", en: "€ / sign-up" },
  "mk.direct": { lv: "Tiešā ienākšana / bez metkām", ru: "Прямые заходы / без меток", en: "Direct / untagged" },
  "mk.total": { lv: "Kopā", ru: "Итого", en: "Total" },
  "mk.empty": {
    lv: "Šajā periodā datu nav. Metkas parādās, kad reklāmas saites satur utm_source/utm_campaign.",
    ru: "За период данных нет. Метки появляются, когда рекламные ссылки содержат utm_source/utm_campaign.",
    en: "No data for this period. Tags appear when ad links carry utm_source/utm_campaign.",
  },
  "mk.loadFailed": { lv: "Neizdevās ielādēt atskaiti", ru: "Не удалось загрузить отчёт", en: "Could not load the report" },
  "mk.hint": {
    lv: "ROI: ieņēmumi pret iztērēto reklāmā — tēriņus redzi reklāmas kabinetā (Meta/Google), šeit ir mūsu puses patiesās reģistrācijas un nauda.",
    ru: "ROI: выручка против потраченного на рекламу — расходы видны в рекламном кабинете (Meta/Google), здесь — честные регистрации и деньги с нашей стороны.",
    en: "ROI: revenue against ad spend — spend lives in the ad manager (Meta/Google); this side shows our true sign-ups and money.",
  },
} satisfies Record<string, Entry>;
