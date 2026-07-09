"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

/**
 * Flat key→{lv,ru,en} dictionary — the Shhh i18n mechanism, auction-keyed.
 * Latvian is the default per the primary market; per-country domain routing
 * lands in the SEO phase.
 */

export type Lang = "lv" | "ru" | "en";
export const LANGS: Lang[] = ["lv", "ru", "en"];

const STRINGS: Record<string, Record<Lang, string>> = {
  "nav.auctions": { lv: "Izsoles", ru: "Аукционы", en: "Auctions" },
  "nav.account": { lv: "Mans konts", ru: "Мой счёт", en: "My account" },
  "nav.signin": { lv: "Ienākt", ru: "Войти", en: "Sign in" },
  "nav.signout": { lv: "Iziet", ru: "Выйти", en: "Sign out" },
  "nav.register": { lv: "Reģistrēties", ru: "Регистрация", en: "Register" },
  "home.live": { lv: "Notiek tagad", ru: "Идут сейчас", en: "Live now" },
  "home.upcoming": { lv: "Drīzumā", ru: "Скоро", en: "Upcoming" },
  "home.empty": { lv: "Šobrīd izsoļu nav.", ru: "Сейчас аукционов нет.", en: "No auctions right now." },
  "card.currentBid": { lv: "Pašreizējā cena", ru: "Текущая цена", en: "Current bid" },
  "card.startPrice": { lv: "Sākumcena", ru: "Начальная цена", en: "Starting price" },
  "card.bids": { lv: "solījumi", ru: "ставок", en: "bids" },
  "card.endsIn": { lv: "Beidzas pēc", ru: "До конца", en: "Ends in" },
  "card.startsAt": { lv: "Sākas", ru: "Начало", en: "Starts" },
  "card.ended": { lv: "Beigusies", ru: "Завершён", en: "Ended" },
  "a.reserveNotMet": { lv: "Rezerves cena nav sasniegta", ru: "Резервная цена не достигнута", en: "Reserve not met" },
  "a.reserveMet": { lv: "Rezerves cena sasniegta", ru: "Резервная цена достигнута", en: "Reserve met" },
  "a.leader": { lv: "Vada", ru: "Лидирует", en: "Leading" },
  "a.youLead": { lv: "Jūs vadāt!", ru: "Вы лидируете!", en: "You are leading!" },
  "a.outbid": { lv: "Jūsu solījums pārsolīts", ru: "Вашу ставку перебили", en: "You have been outbid" },
  "a.yourMax": { lv: "Jūsu maksimālā cena", ru: "Ваша максимальная ставка", en: "Your maximum bid" },
  "a.minBid": { lv: "Minimālais solījums", ru: "Минимальная ставка", en: "Minimum bid" },
  "a.placeBid": { lv: "Solīt", ru: "Сделать ставку", en: "Place bid" },
  "a.signinToBid": { lv: "Ienāciet, lai solītu", ru: "Войдите, чтобы делать ставки", en: "Sign in to bid" },
  "a.bidHistory": { lv: "Solījumu vēsture", ru: "История ставок", en: "Bid history" },
  "a.proxyNote": {
    lv: "Norādiet savu maksimālo cenu — sistēma solīs jūsu vietā ar minimālo soli.",
    ru: "Укажите максимум — система будет ставить за вас с минимальным шагом.",
    en: "Set your maximum — the system bids for you by the minimum increment.",
  },
  "a.extended": { lv: "Izsole pagarināta", ru: "Аукцион продлён", en: "Auction extended" },
  "a.proxy": { lv: "auto", ru: "авто", en: "proxy" },
  "a.you": { lv: "jūs", ru: "вы", en: "you" },
  "auth.email": { lv: "E-pasts", ru: "Эл. почта", en: "Email" },
  "auth.password": { lv: "Parole", ru: "Пароль", en: "Password" },
  "auth.alias": { lv: "Segvārds (publisks)", ru: "Псевдоним (публичный)", en: "Alias (public)" },
  "auth.country": { lv: "Valsts", ru: "Страна", en: "Country" },
  "auth.signin": { lv: "Ienākt", ru: "Войти", en: "Sign in" },
  "auth.register": { lv: "Izveidot kontu", ru: "Создать аккаунт", en: "Create account" },
  "auth.haveAccount": { lv: "Jau ir konts?", ru: "Уже есть аккаунт?", en: "Already have an account?" },
  "auth.noAccount": { lv: "Nav konta?", ru: "Нет аккаунта?", en: "No account?" },
  "auth.failed": { lv: "Nepareizs e-pasts vai parole.", ru: "Неверная почта или пароль.", en: "Invalid email or password." },
  "acc.myBids": { lv: "Manas izsoles", ru: "Мои аукционы", en: "My auctions" },
  "acc.myOrders": { lv: "Mani pirkumi", ru: "Мои покупки", en: "My orders" },
  "acc.leading": { lv: "Vadāt", ru: "Лидируете", en: "Leading" },
  "acc.outbid": { lv: "Pārsolīts", ru: "Перебита", en: "Outbid" },
  "acc.total": { lv: "Kopā", ru: "Итого", en: "Total" },
  "acc.awaiting": { lv: "Gaida apmaksu", ru: "Ожидает оплаты", en: "Awaiting payment" },
  "acc.paid": { lv: "Apmaksāts", ru: "Оплачен", en: "Paid" },
  "acc.empty": { lv: "Vēl nav aktivitātes.", ru: "Пока нет активности.", en: "No activity yet." },
};

interface I18n {
  lang: Lang;
  setLang: (l: Lang) => void;
  t: (key: string) => string;
}

const I18nContext = createContext<I18n>({ lang: "lv", setLang: () => undefined, t: (k) => k });
export const useT = () => useContext(I18nContext);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>("lv");
  useEffect(() => {
    const stored = localStorage.getItem("auction_lang") as Lang | null;
    if (stored && LANGS.includes(stored)) setLangState(stored);
  }, []);
  const setLang = (l: Lang) => {
    setLangState(l);
    localStorage.setItem("auction_lang", l);
    document.documentElement.lang = l;
  };
  const t = (key: string): string => STRINGS[key]?.[lang] ?? STRINGS[key]?.en ?? key;
  return <I18nContext.Provider value={{ lang, setLang, t }}>{children}</I18nContext.Provider>;
}
