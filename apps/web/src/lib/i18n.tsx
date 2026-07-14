"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

/**
 * Flat key→{lv,ru,en,et,lt} dictionary — the Shhh i18n mechanism, auction-keyed.
 * The default language is chosen per country from the request domain (see
 * lib/country.ts); each country offers its national language + Russian +
 * English. Estonian/Lithuanian strings should be reviewed by native speakers
 * before launch (like the per-country VAT rates).
 */

export type Lang = "lv" | "ru" | "en" | "et" | "lt";
export const ALL_LANGS: Lang[] = ["lv", "ru", "en", "et", "lt"];

const STRINGS: Record<string, Record<Lang, string>> = {
  "nav.auctions": { lv: "Izsoles", ru: "Аукционы", en: "Auctions", et: "Oksjonid", lt: "Aukcionai" },
  "nav.account": { lv: "Mans konts", ru: "Мой счёт", en: "My account", et: "Minu konto", lt: "Mano paskyra" },
  "nav.signin": { lv: "Ienākt", ru: "Войти", en: "Sign in", et: "Logi sisse", lt: "Prisijungti" },
  "nav.signout": { lv: "Iziet", ru: "Выйти", en: "Sign out", et: "Logi välja", lt: "Atsijungti" },
  "nav.register": { lv: "Reģistrēties", ru: "Регистрация", en: "Register", et: "Registreeru", lt: "Registruotis" },
  "home.live": { lv: "Notiek tagad", ru: "Идут сейчас", en: "Live now", et: "Praegu käib", lt: "Vyksta dabar" },
  "home.upcoming": { lv: "Drīzumā", ru: "Скоро", en: "Upcoming", et: "Tulekul", lt: "Netrukus" },
  "home.buyNow": { lv: "Pērc uzreiz", ru: "Купить сейчас", en: "Buy now", et: "Osta kohe", lt: "Pirkti dabar" },
  "home.empty": { lv: "Šobrīd izsoļu nav.", ru: "Сейчас аукционов нет.", en: "No auctions right now.", et: "Praegu oksjoneid pole.", lt: "Šiuo metu aukcionų nėra." },
  "buy.badge": { lv: "Pērc uzreiz", ru: "Купить сейчас", en: "Buy now", et: "Osta kohe", lt: "Pirkti dabar" },
  "buy.price": { lv: "Cena", ru: "Цена", en: "Price", et: "Hind", lt: "Kaina" },
  "buy.vatNote": { lv: "Cenai tiek pievienots PVN.", ru: "К цене добавляется НДС.", en: "VAT is added to the price.", et: "Hinnale lisandub käibemaks.", lt: "Prie kainos pridedamas PVM." },
  "buy.now": { lv: "Pirkt tagad", ru: "Купить сейчас", en: "Buy now", et: "Osta kohe", lt: "Pirkti dabar" },
  "buy.signin": { lv: "Ienāciet, lai pirktu", ru: "Войдите, чтобы купить", en: "Sign in to buy", et: "Ostmiseks logi sisse", lt: "Prisijunkite, kad pirktumėte" },
  "buy.soldOut": { lv: "Pārdots", ru: "Продано", en: "Sold out", et: "Müüdud", lt: "Parduota" },
  "buy.blocked": { lv: "Jūsu konts ir bloķēts.", ru: "Ваш аккаунт заблокирован.", en: "Your account is blocked.", et: "Teie konto on blokeeritud.", lt: "Jūsų paskyra užblokuota." },
  "card.currentBid": { lv: "Pašreizējā cena", ru: "Текущая цена", en: "Current bid", et: "Praegune hind", lt: "Dabartinė kaina" },
  "card.startPrice": { lv: "Sākumcena", ru: "Начальная цена", en: "Starting price", et: "Alghind", lt: "Pradinė kaina" },
  "card.bids": { lv: "solījumi", ru: "ставок", en: "bids", et: "pakkumist", lt: "pasiūlymai" },
  "card.endsIn": { lv: "Beidzas pēc", ru: "До конца", en: "Ends in", et: "Lõpeb", lt: "Baigiasi po" },
  "card.startsAt": { lv: "Sākas", ru: "Начало", en: "Starts", et: "Algab", lt: "Prasideda" },
  "card.ended": { lv: "Beigusies", ru: "Завершён", en: "Ended", et: "Lõppenud", lt: "Pasibaigė" },
  "a.reserveNotMet": { lv: "Rezerves cena nav sasniegta", ru: "Резервная цена не достигнута", en: "Reserve not met", et: "Reservhinda ei saavutatud", lt: "Rezervinė kaina nepasiekta" },
  "a.reserveMet": { lv: "Rezerves cena sasniegta", ru: "Резервная цена достигнута", en: "Reserve met", et: "Reservhind saavutatud", lt: "Rezervinė kaina pasiekta" },
  "a.leader": { lv: "Vada", ru: "Лидирует", en: "Leading", et: "Juhib", lt: "Pirmauja" },
  "a.youLead": { lv: "Jūs vadāt!", ru: "Вы лидируете!", en: "You are leading!", et: "Te juhite!", lt: "Jūs pirmaujate!" },
  "a.outbid": { lv: "Jūsu solījums pārsolīts", ru: "Вашу ставку перебили", en: "You have been outbid", et: "Teie pakkumine on ületatud", lt: "Jūsų pasiūlymas perviršytas" },
  "a.yourMax": { lv: "Jūsu maksimālā cena", ru: "Ваша максимальная ставка", en: "Your maximum bid", et: "Teie maksimumhind", lt: "Jūsų maksimali kaina" },
  "a.minBid": { lv: "Minimālais solījums", ru: "Минимальная ставка", en: "Minimum bid", et: "Väikseim pakkumine", lt: "Mažiausias pasiūlymas" },
  "a.placeBid": { lv: "Solīt", ru: "Сделать ставку", en: "Place bid", et: "Paku", lt: "Siūlyti" },
  "a.signinToBid": { lv: "Ienāciet, lai solītu", ru: "Войдите, чтобы делать ставки", en: "Sign in to bid", et: "Pakkumiseks logi sisse", lt: "Prisijunkite, kad siūlytumėte" },
  "a.bidHistory": { lv: "Solījumu vēsture", ru: "История ставок", en: "Bid history", et: "Pakkumiste ajalugu", lt: "Pasiūlymų istorija" },
  "a.proxyNote": {
    lv: "Norādiet savu maksimālo cenu — sistēma solīs jūsu vietā ar minimālo soli.",
    ru: "Укажите максимум — система будет ставить за вас с минимальным шагом.",
    en: "Set your maximum — the system bids for you by the minimum increment.",
    et: "Määrake oma maksimumhind — süsteem pakub teie eest väikseima sammuga.",
    lt: "Nurodykite savo maksimalią kainą — sistema siūlys už jus minimaliu žingsniu.",
  },
  "a.extended": { lv: "Izsole pagarināta", ru: "Аукцион продлён", en: "Auction extended", et: "Oksjonit pikendati", lt: "Aukcionas pratęstas" },
  "a.proxy": { lv: "auto", ru: "авто", en: "proxy", et: "auto", lt: "auto" },
  "a.you": { lv: "jūs", ru: "вы", en: "you", et: "teie", lt: "jūs" },
  "auth.email": { lv: "E-pasts", ru: "Эл. почта", en: "Email", et: "E-post", lt: "El. paštas" },
  "auth.password": { lv: "Parole", ru: "Пароль", en: "Password", et: "Parool", lt: "Slaptažodis" },
  "auth.alias": { lv: "Segvārds (publisks)", ru: "Псевдоним (публичный)", en: "Alias (public)", et: "Hüüdnimi (avalik)", lt: "Slapyvardis (viešas)" },
  "auth.country": { lv: "Valsts", ru: "Страна", en: "Country", et: "Riik", lt: "Šalis" },
  "auth.signin": { lv: "Ienākt", ru: "Войти", en: "Sign in", et: "Logi sisse", lt: "Prisijungti" },
  "auth.register": { lv: "Izveidot kontu", ru: "Создать аккаунт", en: "Create account", et: "Loo konto", lt: "Sukurti paskyrą" },
  "auth.haveAccount": { lv: "Jau ir konts?", ru: "Уже есть аккаунт?", en: "Already have an account?", et: "Konto on juba olemas?", lt: "Jau turite paskyrą?" },
  "auth.noAccount": { lv: "Nav konta?", ru: "Нет аккаунта?", en: "No account?", et: "Kontot pole?", lt: "Neturite paskyros?" },
  "auth.failed": { lv: "Nepareizs e-pasts vai parole.", ru: "Неверная почта или пароль.", en: "Invalid email or password.", et: "Vale e-post või parool.", lt: "Neteisingas el. paštas arba slaptažodis." },
  "acc.myBids": { lv: "Manas izsoles", ru: "Мои аукционы", en: "My auctions", et: "Minu oksjonid", lt: "Mano aukcionai" },
  "acc.myOrders": { lv: "Mani pirkumi", ru: "Мои покупки", en: "My orders", et: "Minu ostud", lt: "Mano pirkiniai" },
  "acc.leading": { lv: "Vadāt", ru: "Лидируете", en: "Leading", et: "Juhite", lt: "Pirmaujate" },
  "acc.outbid": { lv: "Pārsolīts", ru: "Перебита", en: "Outbid", et: "Ületatud", lt: "Perviršyta" },
  "acc.total": { lv: "Kopā", ru: "Итого", en: "Total", et: "Kokku", lt: "Iš viso" },
  "acc.awaiting": { lv: "Gaida apmaksu", ru: "Ожидает оплаты", en: "Awaiting payment", et: "Ootab maksmist", lt: "Laukiama apmokėjimo" },
  "acc.paid": { lv: "Apmaksāts", ru: "Оплачен", en: "Paid", et: "Makstud", lt: "Apmokėta" },
  "acc.empty": { lv: "Vēl nav aktivitātes.", ru: "Пока нет активности.", en: "No activity yet.", et: "Tegevust veel pole.", lt: "Kol kas nėra veiklos." },
  "pickup.title": { lv: "Gatavs saņemšanai noliktavā", ru: "Готово к получению на складе", en: "Ready for warehouse pickup", et: "Valmis laost kättesaamiseks", lt: "Paruošta atsiimti sandėlyje" },
  "pickup.code": { lv: "Saņemšanas kods", ru: "Код получения", en: "Pickup code", et: "Kättesaamise kood", lt: "Atsiėmimo kodas" },
  "pickup.deadline": { lv: "Izņemt līdz", ru: "Забрать до", en: "Collect by", et: "Kätte saada hiljemalt", lt: "Atsiimti iki" },
  "pickup.feeNote": { lv: "Pēc termiņa pasūtījums tiek atcelts ar 5% maksu.", ru: "После срока заказ отменяется с комиссией 5%.", en: "After the deadline the order is cancelled with a 5% fee.", et: "Pärast tähtaega tellimus tühistatakse 5% tasuga.", lt: "Po termino užsakymas atšaukiamas su 5% mokesčiu." },
  "pickup.inProgress": { lv: "Tiek gatavots izsniegšanai — jūsu talons ir rindā", ru: "Готовится к выдаче — ваш талон в очереди", en: "Being prepared — your ticket is in the queue", et: "Valmistatakse ette — teie pilet on järjekorras", lt: "Ruošiama išduoti — jūsų bilietas eilėje" },
};

interface I18n {
  lang: Lang;
  setLang: (l: Lang) => void;
  /** Languages offered on the current country's domain. */
  available: Lang[];
  t: (key: string) => string;
}

const I18nContext = createContext<I18n>({ lang: "lv", setLang: () => undefined, available: ["lv", "ru", "en"], t: (k) => k });
export const useT = () => useContext(I18nContext);

export function I18nProvider({
  children,
  initialLang = "lv",
  available = ["lv", "ru", "en"],
}: {
  children: ReactNode;
  initialLang?: Lang;
  available?: Lang[];
}) {
  const [lang, setLangState] = useState<Lang>(initialLang);
  useEffect(() => {
    // A stored preference wins, but only if the domain offers that language.
    const stored = localStorage.getItem("auction_lang") as Lang | null;
    if (stored && available.includes(stored)) setLangState(stored);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const setLang = (l: Lang) => {
    setLangState(l);
    localStorage.setItem("auction_lang", l);
    document.documentElement.lang = l;
  };
  const t = (key: string): string => STRINGS[key]?.[lang] ?? STRINGS[key]?.en ?? key;
  return <I18nContext.Provider value={{ lang, setLang, available, t }}>{children}</I18nContext.Provider>;
}
