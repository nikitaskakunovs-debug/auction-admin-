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
  "acc.pay": { lv: "Apmaksāt", ru: "Оплатить", en: "Pay now", et: "Maksa", lt: "Apmokėti" },
  "acc.payRedirecting": { lv: "Novirzām uz maksājumu…", ru: "Перенаправляем на оплату…", en: "Redirecting to payment…", et: "Suuname maksma…", lt: "Nukreipiame į mokėjimą…" },
  "acc.payConfirming": { lv: "Apstiprinām maksājumu…", ru: "Подтверждаем платёж…", en: "Confirming your payment…", et: "Kinnitame makset…", lt: "Tvirtiname mokėjimą…" },
  "acc.paySuccess": { lv: "Maksājums saņemts. Paldies!", ru: "Платёж получен. Спасибо!", en: "Payment received. Thank you!", et: "Makse laekus. Aitäh!", lt: "Mokėjimas gautas. Ačiū!" },
  "acc.payFailed": { lv: "Maksājums neizdevās. Lūdzu, mēģiniet vēlreiz.", ru: "Платёж не прошёл. Пожалуйста, попробуйте ещё раз.", en: "Payment failed. Please try again.", et: "Makse ebaõnnestus. Palun proovige uuesti.", lt: "Mokėjimas nepavyko. Bandykite dar kartą." },
  "acc.payCancelled": { lv: "Maksājums atcelts.", ru: "Платёж отменён.", en: "Payment cancelled.", et: "Makse tühistati.", lt: "Mokėjimas atšauktas." },
  "acc.payUnavailable": { lv: "Tiešsaistes maksājumi pagaidām nav pieejami — sazinieties ar mums par apmaksu.", ru: "Онлайн-оплата пока недоступна — свяжитесь с нами по поводу оплаты.", en: "Online payments are not available yet — contact us to arrange payment.", et: "Veebimaksed pole veel saadaval — võtke tasumiseks meiega ühendust.", lt: "Mokėjimai internetu kol kas negalimi — dėl apmokėjimo susisiekite su mumis." },
  "pickup.title": { lv: "Gatavs saņemšanai noliktavā", ru: "Готово к получению на складе", en: "Ready for warehouse pickup", et: "Valmis laost kättesaamiseks", lt: "Paruošta atsiimti sandėlyje" },
  "pickup.code": { lv: "Saņemšanas kods", ru: "Код получения", en: "Pickup code", et: "Kättesaamise kood", lt: "Atsiėmimo kodas" },
  "pickup.deadline": { lv: "Izņemt līdz", ru: "Забрать до", en: "Collect by", et: "Kätte saada hiljemalt", lt: "Atsiimti iki" },
  "pickup.feeNote": { lv: "Pēc termiņa pasūtījums tiek atcelts ar 5% maksu.", ru: "После срока заказ отменяется с комиссией 5%.", en: "After the deadline the order is cancelled with a 5% fee.", et: "Pärast tähtaega tellimus tühistatakse 5% tasuga.", lt: "Po termino užsakymas atšaukiamas su 5% mokesčiu." },
  "fees.banner": { lv: "Jūsu kontā ir nenokārtota uzglabāšanas maksa", ru: "На вашем счету неоплаченный сбор за возврат на склад", en: "Your account has an outstanding restocking fee", et: "Teie kontol on tasumata laotasu", lt: "Jūsų paskyroje yra neapmokėtas sandėliavimo mokestis" },
  "fees.note": { lv: "Solīšana un pirkšana ir apturēta, līdz maksa tiks nokārtota noliktavā vai ar pārskaitījumu.", ru: "Ставки и покупки приостановлены, пока сбор не будет оплачен на складе или переводом.", en: "Bidding and buying are paused until the fee is settled at the warehouse or by transfer.", et: "Pakkumine ja ostmine on peatatud, kuni tasu on laos või ülekandega tasutud.", lt: "Siūlymas ir pirkimas sustabdyti, kol mokestis bus sumokėtas sandėlyje arba pavedimu." },
  "fees.blockedShort": { lv: "Konts apturēts nenokārtotas maksas dēļ", ru: "Аккаунт приостановлен из-за неоплаченного сбора", en: "Account paused — outstanding fee", et: "Konto peatatud — tasumata tasu", lt: "Paskyra sustabdyta — neapmokėtas mokestis" },
  "pickup.inProgress": { lv: "Tiek gatavots izsniegšanai — jūsu talons ir rindā", ru: "Готовится к выдаче — ваш талон в очереди", en: "Being prepared — your ticket is in the queue", et: "Valmistatakse ette — teie pilet on järjekorras", lt: "Ruošiama išduoti — jūsų bilietas eilėje" },
  "acc.suspended": { lv: "Jūsu konts ir apturēts. Lūdzu, sazinieties ar atbalsta dienestu.", ru: "Ваш аккаунт приостановлен. Пожалуйста, свяжитесь со службой поддержки.", en: "Your account has been suspended. Please contact support.", et: "Teie konto on peatatud. Palun võtke ühendust klienditoega.", lt: "Jūsų paskyra sustabdyta. Susisiekite su klientų aptarnavimu." },
  // ── Catalog browse (search, category chips, paging) ──
  "catalog.search": { lv: "Meklēt izsolēs…", ru: "Поиск по лотам…", en: "Search lots…", et: "Otsi oksjoneid…", lt: "Ieškoti prekių…" },
  "catalog.all": { lv: "Visi", ru: "Все", en: "All", et: "Kõik", lt: "Visi" },
  "catalog.loadMore": { lv: "Rādīt vairāk", ru: "Показать ещё", en: "Show more", et: "Näita rohkem", lt: "Rodyti daugiau" },
  "catalog.noResults": { lv: "Nekas netika atrasts.", ru: "Ничего не найдено.", en: "Nothing found.", et: "Midagi ei leitud.", lt: "Nieko nerasta." },
  "cat.electronics": { lv: "Elektronika", ru: "Электроника", en: "Electronics", et: "Elektroonika", lt: "Elektronika" },
  "cat.appliances": { lv: "Sadzīves tehnika", ru: "Бытовая техника", en: "Home appliances", et: "Kodumasinad", lt: "Buitinė technika" },
  "cat.furniture": { lv: "Mēbeles", ru: "Мебель", en: "Furniture", et: "Mööbel", lt: "Baldai" },
  "cat.tools": { lv: "Instrumenti un garāža", ru: "Инструменты и гараж", en: "Tools & garage", et: "Tööriistad ja garaaž", lt: "Įrankiai ir garažas" },
  "cat.home_garden": { lv: "Mājai un dārzam", ru: "Дом и сад", en: "Home & garden", et: "Kodu ja aed", lt: "Namams ir sodui" },
  "cat.jewellery_watches": { lv: "Rotaslietas un pulksteņi", ru: "Украшения и часы", en: "Jewellery & watches", et: "Ehted ja kellad", lt: "Papuošalai ir laikrodžiai" },
  "cat.art_antiques": { lv: "Māksla un antikvariāts", ru: "Искусство и антиквариат", en: "Art & antiques", et: "Kunst ja antiik", lt: "Menas ir antikvariatas" },
  "cat.sports_outdoors": { lv: "Sports un aktīvā atpūta", ru: "Спорт и отдых", en: "Sports & outdoors", et: "Sport ja vaba aeg", lt: "Sportas ir laisvalaikis" },
  "cat.kids_toys": { lv: "Bērniem un rotaļlietas", ru: "Детям и игрушки", en: "Kids & toys", et: "Lastele ja mänguasjad", lt: "Vaikams ir žaislai" },
  "cat.fashion": { lv: "Apģērbs un mode", ru: "Одежда и мода", en: "Fashion", et: "Mood", lt: "Mada" },
  "cat.food_household": { lv: "Pārtika un saimniecība", ru: "Продукты и хозтовары", en: "Food & household", et: "Toit ja majapidamine", lt: "Maistas ir ūkio prekės" },
  "cat.other": { lv: "Citas preces", ru: "Прочее", en: "Other", et: "Muu", lt: "Kita" },
  // ── Condition taxonomy (labels + one-line descriptions; the /conditions page) ──
  "cond.title": { lv: "Stāvokļa apzīmējumi", ru: "Обозначения состояния", en: "Condition reference", et: "Seisukorra tähised", lt: "Būklės žymėjimai" },
  "cond.intro": { lv: "Katram lotam ir norādīts viens no šiem stāvokļiem. Atzīmes ar piezīmēm vienmēr ietver konkrētā defekta aprakstu.", ru: "Каждому лоту присвоено одно из этих состояний. Лоты с примечаниями всегда содержат описание конкретного недостатка.", en: "Every lot is graded with one of these conditions. Grades with notes always include a description of the specific issue.", et: "Igale osale on määratud üks neist seisukordadest. Märkustega osad sisaldavad alati konkreetse puuduse kirjeldust.", lt: "Kiekvienai prekei priskirta viena iš šių būklių. Prekės su pastabomis visada turi konkretaus trūkumo aprašymą." },
  "cond.notes": { lv: "Stāvokļa piezīmes", ru: "Примечания о состоянии", en: "Condition notes", et: "Seisukorra märkused", lt: "Būklės pastabos" },
  "cond.brand_new": { lv: "Pilnīgi jauns", ru: "Совершенно новый", en: "Brand new", et: "Täiesti uus", lt: "Visiškai naujas" },
  "cond.brand_new.d": { lv: "Neaiztikts — slēgtā iepakojumā vai ar veikala birkām, tieši kā veikalā.", ru: "Нетронутый — запечатан или с магазинными бирками, как в магазине.", en: "Untouched — sealed or with retail tags, exactly as in a store.", et: "Puutumata — suletud pakendis või poesiltidega, täpselt nagu poes.", lt: "Neliestas — sandarioje pakuotėje arba su parduotuvės etiketėmis, kaip parduotuvėje." },
  "cond.new_no_package": { lv: "Jauns bez iepakojuma", ru: "Новый без упаковки", en: "New — no packaging", et: "Uus ilma pakendita", lt: "Naujas be pakuotės" },
  "cond.new_no_package.d": { lv: "Bez iepakojuma, bet saturs nav lietots un nav bojāts.", ru: "Без упаковки, но содержимое не использовалось и не повреждено.", en: "No retail packaging, but the contents are unused and undamaged.", et: "Ilma pakendita, kuid sisu on kasutamata ja kahjustusteta.", lt: "Be pakuotės, tačiau turinys nenaudotas ir nepažeistas." },
  "cond.open_package_new": { lv: "Atvērts iepakojums — saturs jauns", ru: "Вскрытая упаковка — содержимое новое", en: "Open package — contents new", et: "Avatud pakend — sisu uus", lt: "Atidaryta pakuotė — turinys naujas" },
  "cond.open_package_new.d": { lv: "Iepakojums var būt bojāts; saturs iekšā ir pilnīgi jauns.", ru: "Упаковка может быть повреждена; содержимое совершенно новое.", en: "Packaging may be damaged; the contents inside are brand new.", et: "Pakend võib olla kahjustatud; sisu on täiesti uus.", lt: "Pakuotė gali būti pažeista; turinys visiškai naujas." },
  "cond.open_package_inspected": { lv: "Atvērts iepakojums — pārbaudīts", ru: "Вскрытая упаковка — проверено", en: "Open package — inspected", et: "Avatud pakend — kontrollitud", lt: "Atidaryta pakuotė — patikrinta" },
  "cond.open_package_inspected.d": { lv: "Atvērts un pārbaudīts, bet gandrīz jaunā stāvoklī.", ru: "Вскрыт и осматривался, но в состоянии как новый.", en: "Opened and handled, but in a like-new condition.", et: "Avatud ja käsitsetud, kuid nagu uus.", lt: "Atidarytas ir apžiūrėtas, bet kaip naujas." },
  "cond.new_with_issue": { lv: "Jauns — ar defektu", ru: "Новый — с недостатком", en: "New — with issue", et: "Uus — puudusega", lt: "Naujas — su trūkumu" },
  "cond.new_with_issue.d": { lv: "Jauns, bet ar defektu, piemēram, trūkst piederuma — skatīt piezīmes.", ru: "Новый, но с недостатком, например отсутствует аксессуар — см. примечания.", en: "New, but with an issue such as a missing accessory — see the notes.", et: "Uus, kuid puudusega, näiteks puuduv tarvik — vaata märkusi.", lt: "Naujas, bet su trūkumu, pvz., trūksta priedo — žr. pastabas." },
  "cond.lightly_used": { lv: "Nedaudz lietots", ru: "Слегка б/у", en: "Lightly used", et: "Kergelt kasutatud", lt: "Mažai naudotas" },
  "cond.lightly_used.d": { lv: "Vieglas lietošanas pēdas, ko var viegli notīrīt — skatīt piezīmes.", ru: "Лёгкие следы использования, легко устранимые — см. примечания.", en: "Light signs of use that could be cleaned with minor effort — see the notes.", et: "Kerged kasutusjäljed, mida saab hõlpsalt puhastada — vaata märkusi.", lt: "Nežymūs naudojimo požymiai, lengvai nuvalomi — žr. pastabas." },
  "cond.used": { lv: "Lietots", ru: "Б/у", en: "Used", et: "Kasutatud", lt: "Naudotas" },
  "cond.used.d": { lv: "Izteiktākas lietošanas pēdas: traipi, iespiedumi — skatīt piezīmes.", ru: "Заметные следы использования: пятна, вмятины — см. примечания.", en: "Heavier signs of use: stains, dents, harder to clean — see the notes.", et: "Tugevamad kasutusjäljed: plekid, mõlgid — vaata märkusi.", lt: "Ryškesni naudojimo požymiai: dėmės, įlenkimai — žr. pastabas." },
  "cond.previously_assembled": { lv: "Iepriekš salikts", ru: "Ранее собран", en: "Previously assembled", et: "Varem kokku pandud", lt: "Anksčiau surinktas" },
  "cond.previously_assembled.d": { lv: "Iepriekš salikts vai uzstādīts (galvenokārt mēbeles); var būt skrūvju pēdas.", ru: "Ранее собирался или устанавливался (в основном мебель); возможны следы шурупов.", en: "Previously built or installed (mostly furniture); may show screw marks.", et: "Varem kokku pandud või paigaldatud (peamiselt mööbel); võib olla kruvijälgi.", lt: "Anksčiau surinktas ar sumontuotas (dažniausiai baldai); gali būti varžtų žymių." },
  "cond.display_model": { lv: "Ekspozīcijas paraugs", ru: "Витринный образец", en: "Display model", et: "Näidiseksemplar", lt: "Ekspozicinis modelis" },
  "cond.display_model.d": { lv: "Izmantots kā veikala paraugs; var būt stiprinājumi.", ru: "Использовался как витринный образец; возможны крепления.", en: "Used as a store display; may have fixtures attached.", et: "Kasutatud poe väljapanekuna; võib olla kinnitusi.", lt: "Naudotas kaip parduotuvės eksponatas; gali būti tvirtinimų." },
  "cond.refurbished": { lv: "Atjaunots", ru: "Восстановленный", en: "Refurbished", et: "Taastatud", lt: "Atnaujintas" },
  "cond.refurbished.d": { lv: "Ražotāja atjaunots pilnā darba kārtībā; iespējami nelieli defekti.", ru: "Восстановлен производителем до полной работоспособности; возможны мелкие дефекты.", en: "Restored by the manufacturer to full working order; may have small blemishes.", et: "Tootja poolt täielikult töökorda taastatud; võib olla väikseid vigu.", lt: "Gamintojo atnaujintas iki visiškai veikiančios būklės; galimi smulkūs defektai." },
  "cond.as_is_untested": { lv: "Kā ir — nepārbaudīts", ru: "Как есть — не проверялся", en: "As-is — untested", et: "Nagu on — testimata", lt: "Kaip yra — netikrintas" },
  "cond.as_is_untested.d": { lv: "Nebija iespējams pārbaudīt — var darboties vai nedarboties; pārdod kā ir.", ru: "Не было возможности проверить — может работать или нет; продаётся как есть.", en: "Could not be tested — may be fully working or faulty; sold as-is.", et: "Ei olnud võimalik testida — võib töötada või mitte; müüakse nagu on.", lt: "Nebuvo galimybės patikrinti — gali veikti arba ne; parduodama kaip yra." },
  "cond.as_is_salvage": { lv: "Kā ir — rezerves daļām", ru: "Как есть — на запчасти", en: "As-is — salvage", et: "Nagu on — varuosadeks", lt: "Kaip yra — dalims" },
  "cond.as_is_salvage.d": { lv: "Pārdod rezerves daļām vai remontam — zināms, ka pilnībā nedarbojas.", ru: "Продаётся на запчасти или для ремонта — заведомо неисправен.", en: "Sold for parts or repair — known not to work fully.", et: "Müüakse varuosadeks või remondiks — teadaolevalt ei tööta täielikult.", lt: "Parduodama dalims arba remontui — žinoma, kad veikia ne visiškai." },
  "cond.as_is_expired": { lv: "Kā ir — beidzies termiņš", ru: "Как есть — истёк срок", en: "As-is — expired", et: "Nagu on — aegunud", lt: "Kaip yra — pasibaigęs galiojimas" },
  "cond.as_is_expired.d": { lv: "Beidzies derīguma termiņš (pārtika, ķīmija); var joprojām būt lietojams.", ru: "Истёк срок годности (продукты, химия); может ещё быть пригоден.", en: "Past its expiry date (foods, chemicals); may still be usable.", et: "Aegunud (toit, keemia); võib siiski olla kasutatav.", lt: "Pasibaigęs galiojimas (maistas, chemija); vis dar gali būti tinkamas." },
  "cond.used_with_issue": { lv: "Lietots — ar defektu", ru: "Б/у — с недостатком", en: "Used — with issue", et: "Kasutatud — puudusega", lt: "Naudotas — su trūkumu" },
  "cond.used_with_issue.d": { lv: "Lietots un ar papildu defektu (trūkst daļu, bojājumi) — skatīt piezīmes.", ru: "Б/у и с дополнительным недостатком (нет деталей, повреждения) — см. примечания.", en: "Used and with an issue on top (missing parts, damage) — see the notes.", et: "Kasutatud ja lisaks puudusega (puuduvad osad, kahjustused) — vaata märkusi.", lt: "Naudotas ir su papildomu trūkumu (trūksta dalių, pažeidimai) — žr. pastabas." },
  "cond.new_cosmetic_imperfection": { lv: "Jauns — kosmētisks defekts", ru: "Новый — косметический дефект", en: "New — cosmetic imperfection", et: "Uus — kosmeetiline viga", lt: "Naujas — kosmetinis defektas" },
  "cond.new_cosmetic_imperfection.d": { lv: "Jauns ar skrāpējumu, nobrāzumu vai robu — skatīt piezīmes.", ru: "Новый с царапиной, потёртостью или сколом — см. примечания.", en: "New with a scratch, scuff or chip — see the notes.", et: "Uus kriimu, hõõrdumise või täkkega — vaata märkusi.", lt: "Naujas su įbrėžimu, nutrynimu ar įskilimu — žr. pastabas." },
  "cond.as_is": { lv: "Kā ir", ru: "Как есть", en: "As-is", et: "Nagu on", lt: "Kaip yra" },
  "cond.as_is.d": { lv: "Pārdod kā ir — īpašiem gadījumiem, piemēram, antikvariātam.", ru: "Продаётся как есть — для особых случаев, например антиквариата.", en: "Sold as-is — for special cases such as antiques or memorabilia.", et: "Müüakse nagu on — erijuhtudel, näiteks antiikesemed.", lt: "Parduodama kaip yra — ypatingais atvejais, pvz., antikvariniams daiktams." },
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
