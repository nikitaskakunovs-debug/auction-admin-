# Кабинет izsoli.lv — передача в разработку

Документ описывает **всё, что мы утвердили на макетах** и что нужно закодить, чтобы выкатить в прод.
Написан так, чтобы другой чат/разработчик мог взять его и работать без нашей переписки.

Комплект макетов: **72 изображения**, в каждом слева веб 1440 px, справа мобильный 390 px.
Список — `00-SARAKSTS.md` в архиве. Ссылки на экраны в тексте даны по номерам: **№ 46**, **№ 65** и т. д.

---

## 0. Границы работы

**Не трогаем:** верхнюю панель (лого, поиск, категории), нижний док, каталог, страницу лота.
Единственное исключение, которое согласовано, — два выпадающих меню в шапке: уведомления и меню аккаунта (**№ 11**).

**Источник правды — движок.** Если макет расходится с расчётом в коде, прав код:
комиссия покупателя 10 %, НДС 21 % на (молоток + комиссия), деньги в центах целыми числами.
Макеты никогда не переопределяют бизнес-логику.

**Приоритет — мобильный.** 80 % трафика. Любой экран сначала проверяется на 390 px.

---

## 1. Что уже есть в движке (не надо изобретать заново)

### Таблицы (`packages/db/src/schema.ts`)

| Таблица | Ключевые поля, которые нам нужны |
|---|---|
| `customers` | `email, alias, name, country, lang, company, vatNo, vies, passwordHash, strikes, blocked, erasedAt` |
| `orders` | `ref, auctionId, itemId, customerId, hammerCents, premiumCents, vatCents, vatRateBp, shippingCents, handlingCents, totalCents, reverseCharge, status, paymentDeadlineAt, paidAt, cancelledAt, pickupCode, pickupDeadlineAt, fulfilment, shippingTo, recipientName, recipientPhone` |
| `payments` | `orderId, provider, channel, providerId, status, amountCents, checkoutUrl, method, raw` |
| `invoices` | `orderId, number, series, data, issuedAt, voidedAt` |
| `shipments` | `orderId, provider, barcode, status, providerStatus, events, labelPrintedAt` |
| `refunds` | `orderId, amountCents, reason, actorId` |
| `returnCases` | `ref, orderId, reason, photos, status, decision, refundCents, refundMethod, withinWindow` |
| `notifications` | `customerId, type, channel, toEmail, lang, subject, body, html, dedupeKey, status, attempts, sentAt` |
| `pickupTickets`, `pickupTicketItems` | выдача со склада |
| `customerFees` | начисления (хранение и пр.) |
| `trustedDevices` | доверенные устройства — переиспользуем для кода при входе |
| `appSettings` | key/value — сюда кладём все параметры политики (раздел 2) |

### Публичные эндпоинты (`apps/api/src/routes/public.ts`)

```
GET  /api/public/auctions            GET  /api/public/auctions/:id
POST /api/public/auctions/:id/bids   GET  /api/public/listings
GET  /api/public/listings/:id        POST /api/public/listings/:id/buy
GET  /api/public/auth/me             POST /api/public/auth/login
POST /api/public/auth/register       POST /api/public/auth/refresh
POST /api/public/auth/forgot-password POST /api/public/auth/reset-password
GET  /api/public/me/bids             GET  /api/public/me/orders
GET  /api/public/me/fees             GET  /api/public/me/pickup
```

`/api/public/me/bids` уже отдаёт `myMaxCents` (добавлено в этой ветке).

---

## 2. Параметры политики → админка (`appSettings`)

Все числа ниже **не хардкодить**. Они меняются в админке без релиза.
Раздел админки: «Pasūtījumu politika».

| Ключ | Значение сейчас | Где видно клиенту |
|---|---|---|
| `payment.deadlineDays` | 3 дня | № 65, письмо со счётом |
| `storage.freeDays` | 7 дней после оплаты | № 16, № 67 |
| `storage.feeCentsPerDay` | 200 (2,00 €) | № 67 |
| `storage.startsOnLateDay` | 3 | № 67 |
| `payment.extensionDays` | 7, один раз без вопросов | № 67 |
| `order.cancelOnLateDay` | 10 | № 67 |
| `bidding.blockDaysAfterCancel` | 30 | № 66b, № 67 |
| `credit.expiryMonths` | 12 | № 69b, № 71 |
| `return.windowDays` | 14 | № 68 |
| `refund.payoutDays` | до 14 | № 68, № 70 |
| `lot.reserveHoursAfterFailedPayment` | 48 | № 64, № 66 |
| `parcel.holdDays` | 7 | № 77 |
| `fee.buyerPremiumBp` | 1000 (10 %) | все счета |
| `vat.rateBp` | 2100 (21 %) | все счета |
| `shipping.omnivaCents` | 290 | № 28, № 46 |
| `shipping.dpdCents` | 340 | № 28, № 46 |
| `shipping.courierCents` | 490 | № 74 |
| `shipping.bulkyCents` | 3900 | № 75 |
| `shipping.bulkyExtraCarrierCents` | 1500 | № 75 |
| `shipping.bulkyFloorCents` | 1000 за этаж | № 75 |
| `insurance.tiers` | 0/100 € бесплатно, 1500 € → 480, 5000 € → 1500 | № 78 |
| `split.enabled` / `split.firstShareBp` / `split.secondTermDays` | вкл, 5000 (50 %), 7 | № 66b |

**Важно:** при отмене заказа комиссия покупателя (`premiumCents`) остаётся как компенсация — это
условие показано клиенту на № 66b и № 67. Проверить с юристом формулировку в правилах аукциона.

---

## 3. Дизайн-система

### 3.1 Шрифт — есть баг в проде, чинить обязательно

В `apps/web/src/app/fonts/` лежат `figtree-400…800.woff2` **по 6 КБ** — это только подмножество
`latin-ext` (136 глифов). В нём есть ā ē ī ū ķ ļ ņ ģ š ž č, но **нет a–z и цифр**.
Результат: браузер рисует Figtree только на диакритике, остальное падает в системный шрифт —
внутри слова «Rēķins» две разные гарнитуры.

Дополнительно:
* эстонских õ ä ö ü нет вообще;
* кириллицы в Figtree нет в принципе → русская версия идёт системным шрифтом.

**Что сделать:**
1. Заменить пять файлов на слитые `latin + latin-ext` (347 глифов, ~15 КБ на начертание).
   Источник: `npm pack @fontsource/figtree`, объединить `figtree-latin-N-normal.woff2` и
   `figtree-latin-ext-N-normal.woff2` (fontTools `Merger`), сохранить в woff2.
2. Для кириллицы подключить **Manrope** (`@fontsource/manrope`, subset `cyrillic`) вторым
   семейством: `font-family: var(--font-figtree), var(--font-manrope), system-ui`.
   Браузер сам возьмёт Manrope для символов, которых нет в Figtree.
3. Проверить на строках: `Rēķins · Izņemšana · Sąskaita · Väljastamine · Счёт · Получение`.

### 3.2 Иконки

Единый набор — **Phosphor Icons, вес regular** (MIT). Никаких самодельных путей.
`viewBox="0 0 256 256"`, заливка `currentColor`, обводки нет.
Внутри кнопок размер жёстко 18×18, иначе иконка разворачивается на весь блок (был такой баг).

Используемые имена: `house, gavel, package, heart, bell, map-pin, shield-check, gear, sign-out,
caret-right, timer, check, envelope-simple, share-network, file-text, magnifying-glass, watch, copy-simple`.

### 3.3 Знаки партнёров

Лежат в `apps/web/public/brands/`, подключаются компонентом `BrandMark`:

```tsx
<BrandMark name="swedbank" h={22} />   // чип банка
<BrandMark name="dpd" h={24} />        // строка доставки
<BrandMark name="applepay" h={26} />   // способ оплаты
```

Правила (условия брендбуков): не перекрашивать, не растягивать, не обводить, не добавлять тень;
DPD — минимум 60 px по ширине, охранное поле в половину «кубика», только четыре цветовые версии.
Полные правила и список файлов — `apps/web/public/brands/README.md`.

Набор: `swedbank, seb, citadele, luminor, revolut` (банклинк) · `klix, inbank` (рассрочка) ·
`applepay, googlepay, visa, mastercard` · `omniva, dpd` · `googlemaps, applemaps, waze` ·
`telegram, google, facebook, instagram, x-twitter, tiktok`.

Industra **не используем** — банка нет в списке. Waze сейчас глиф Font Awesome, покрашенный
в #33CCFF; при получении файла из брендбука заменить.

### 3.4 Токены

Работаем на существующих: `--surface, --surface-2, --surface-3, --text, --text-2, --text-3,
--accent (#9FE870), --brand (#163300), --live (#C43D05), --live-soft, --r-sm/md/lg/pill,
--shadow-1/2/3, --ease`. Фон страницы белый, контейнеры разделены рамкой и тенью.

---

## 4. Мобильные паттерны (обязательны к реализации)

1. **Боковое меню кабинета → лента чипов.** На ≤640 px `.acnav` превращается в горизонтальный
   скролл-ряд пилюль, аватар и статус — строкой над ней. Пункт «Iziet» на мобильном скрыт,
   выход живёт в настройках.
2. **Оплата — шаги-аккордеон** (**№ 28b, 46b, 46c, 48b**).
   Сначала все блоки открыты. Как только шаг выбран, он сворачивается в одну зелёную строку
   с галочкой, выбранным значением и ссылкой «Mainīt». Открыт только текущий шаг.
   Шаги: 1 «Saņemšana» → 2 «Rēķins» → 3 «Apmaksa».
3. **Сводка заказа — сверху**, в свёрнутом виде: номер, лот, сумма, шеврон.
   Тап раскрывает разбивку (молоток, комиссия, доставка, НДС, итог).
   На вебе сводка остаётся правой колонкой, мобильная полоса скрыта.
4. **Липкая нижняя полоса**: «Kopā apmaksai» + основная кнопка. Всегда под большим пальцем.
5. **Таблицы и строки данных** на мобильном разворачиваются в колонку: подпись сверху,
   значение под ней. Никаких двух узких колонок.
6. **Матрица уведомлений** (событие × 3 канала) на мобильном превращается в список:
   событие, под ним три подписанных переключателя.
7. **Счета**: шапка в колонку, колонка «PVN по строке» скрывается (НДС остаётся в итогах).

---

## 5. Экраны

### 5.1 Кабинет

| № | Экран | Что нужно от бэка |
|---|---|---|
| 01 | Manas izsoles — активные ставки | `GET /me/bids` (+`myMaxCents`, уже есть) |
| 02–04 | Живая консоль: 0 / 2 / 4 лота одновременно | SSE или polling цены и статуса по списку лотов |
| 07 | Brīdinājumi | `GET /me/notifications` (новый) |
| 11 | Выпадающие меню шапки: уведомления + аккаунт | счётчики в `/auth/me` |
| 14 / 15 | Verifikācija: e-mail подтверждён / нет | `POST /auth/email/resend`, `POST /auth/email/change` |
| 16 | Izņemšana: код, адрес, очередь, мои посылки | `GET /me/pickup` (есть), `GET /me/shipments` (новый) |
| 17 | Vēlmes — карточки лотов утверждённого вида | `GET /me/watchlist` (новый) |
| 18–23 | Пустые состояния всех шести вкладок | — |
| 79 | История ставок по лоту | `GET /auctions/:id/bids` (публичная, псевдонимы) |
| 80 | Сохранённые поиски с превью лотов | `GET/POST/DELETE /me/searches` (новый) |
| 81 | Несколько получателей счёта (физлицо + N компаний) | `GET/POST /me/billing-profiles` (новый) |

### 5.2 Оплата и документы

| № | Экран | Что нужно от бэка |
|---|---|---|
| 46 | Оплата, физлицо: получение → счёт → оплата | `POST /me/orders/:ref/checkout` |
| 42 | Оплата, компания: реквизиты SIA, счёт на фирму | то же + `billingProfileId` |
| 47 | «Корзина»: выбор нескольких лотов чекбоксами | `POST /me/orders/group` — объединение в один заказ |
| 48 | Оплата двух лотов одним заказом | тот же checkout с массивом заказов |
| 28 | Рассрочка: калькулятор Klix / Inbank | `GET /payments/bnpl/quote?amount&provider` |
| 29 | Выбор пакомата (только выбранный перевозчик) | `GET /shipping/points?carrier=&q=` |
| 26 | «Kā nokļūt»: Waze / Google Maps / Apple Maps / копировать адрес | статические ссылки |
| 33 | Покупки: карточка раскрывается с историей | `GET /me/orders/:ref` |
| 34 | Счёт физлицу (PDF) | `GET /me/orders/:ref/invoice.pdf` |
| 35 / 41 | Чек после оплаты (мобильный / веб) | `GET /me/orders/:ref/receipt` |
| 43 | Счёт латвийской SIA | генератор с реквизитами покупателя |
| 44 | Счёт компании ЕС — reverse charge, PVN 0 % | `orders.reverseCharge` уже есть |
| 45 | Реквизиты компании в настройках | `billing-profiles` |
| 51 | Оплата, когда не хватает телефона | инлайн-дозаполнение профиля |
| 72 | Оплата с зачётом аванса | `credits` (раздел 7) |

### 5.3 Деньги: ошибки и статусы

| № | Экран | Триггер |
|---|---|---|
| 64 | «Maksājums nav izdevies» | вебхук Klix: `failed` / `cancelled` |
| 65 | «Gaidām pārskaitījumu» — реквизиты + шкала | выбран банковский перевод, счёт выставлен |
| 66 | Отказ BNPL (первый провайдер) | вебхук провайдера: `rejected` |
| 66b | Отказали оба + дробление платежа + последствия отказа | второй `rejected` |
| 67 | Просрочка: график по дням, хранение, аннулирование | `paymentDeadlineAt` пройден |
| 68 | Возврат 14 дней + кредит-нота | `returnCases` |
| 69 | Недоплата: реквизиты для доплаты | сумма прихода < счёта |
| 69b | Переплата: вернуть / оставить авансом / закрыть доставку | сумма прихода > счёта |
| 70 | Возврат денег в процессе | `refunds` |
| 71 | Konta atlikums — движение денег | `credits` + `credit_entries` |
| 73 | Где это видно: полоса в «Pirkumi» + строка в заказе | — |

### 5.4 Получение

| № | Экран | Что нужно |
|---|---|---|
| 74 | Курьер на адрес: адрес, окно доставки, заметка | тарифы окон, валидация адреса |
| 75 | Крупногабарит: пакомат и DPD заблокированы с причиной | габариты и вес лота в API |
| 76 | Доверенное лицо забирает по коду | `POST /me/orders/:ref/proxy-pickup` |
| 77 | Не забрали из пакомата → возврат на склад | вебхук перевозчика `returned` |
| 77b | Оплата повторной пересылки | новый платёж на сумму доставки |
| 78 | Страховка отправления, три уровня | `insurance.tiers` |

### 5.5 Аккаунт, безопасность, настройки

| № | Экран | Что нужно |
|---|---|---|
| 50 | «Pabeidz profilu» после соцлогина | догрузка e-mail/телефона |
| 52 | Регистрация (как в движке, без страны) | `POST /auth/register` |
| 53 | E-mail уже занят → привязка аккаунта | `POST /auth/link` |
| 54 | Создать пароль для соцлогина | `POST /auth/password/set` |
| 55 / 55b | Восстановление пароля / новый пароль | есть |
| 56 | Код при входе с нового устройства | `trustedDevices` (таблица есть) |
| 57 | Drošība: способы входа, сессии, «выйти везде» | `GET/DELETE /me/sessions` |
| 58 | Konts un dati: согласия, выгрузка, удаление | `POST /me/export`, `POST /me/delete` |
| 59 | Хаб настроек — восемь плиток со статусами | агрегат из `/auth/me` |
| 60 | Уведомления: матрица каналов, Telegram-бот, тихие часы | `GET/PUT /me/notification-prefs` |
| 61 | Язык и регион | `customers.lang`, часовой пояс |
| 62 | Документы и история согласий | `consents` (новая таблица) |
| 63 | Куки по категориям | клиентское хранилище + лог согласия |
| 49 / 49b | Maksājumi un piegāde: значения по умолчанию (физлицо / SIA) | `me/preferences` |

---

## 6. Новые эндпоинты

Ниже — контракт. Все ответы в JSON, деньги в центах, ошибки в формате движка (`{code, message}`).

### 6.1 Заказы и оплата

```
POST /api/public/me/orders/group
  body: { refs: string[] }                     // объединяем оплату нескольких лотов
  400 DIFFERENT_WAREHOUSE — лоты с разных складов
  → { ref, totalCents, items[] }

POST /api/public/me/orders/:ref/checkout
  body: {
    fulfilment: "pickup" | "omniva" | "dpd" | "courier" | "bulky",
    pointId?: string, address?: {...}, slot?: string,
    insuranceTier?: 0 | 1500 | 5000,
    billingProfileId?: string,
    method: "applepay" | "googlepay" | "banklink" | "card" | "transfer" | "bnpl" | "onsite",
    bank?: "swedbank" | "seb" | "citadele" | "luminor" | "revolut",
    bnpl?: { provider: "klix" | "inbank", months: 3|6|12|24 },
    useCredit?: boolean,
    marketingOptIn?: boolean
  }
  → { paymentId, checkoutUrl? , status }

POST /api/public/me/orders/:ref/extend      // одноразовое продление срока оплаты
POST /api/public/me/orders/:ref/proxy-pickup  body: { name, phone }
POST /api/public/me/orders/:ref/reship      // повторная отправка, платная
GET  /api/public/me/orders/:ref/invoice.pdf
GET  /api/public/me/orders/:ref/receipt
```

### 6.2 Возвраты и деньги

```
POST /api/public/me/orders/:ref/return    body: { reason, note?, photos[] }
GET  /api/public/me/credit                → { balanceCents, expiresAt, entries[] }
POST /api/public/me/credit/withdraw       // вернуть остаток на счёт
```

### 6.3 Профиль, безопасность, уведомления

```
GET/POST/DELETE /api/public/me/billing-profiles
GET/PUT         /api/public/me/preferences        // способ оплаты, банк, пакомат, получатель счёта
GET/PUT         /api/public/me/notification-prefs
GET/DELETE      /api/public/me/sessions
POST            /api/public/me/export             // ZIP на почту
POST            /api/public/me/delete             // с проверками (раздел 11)
GET/POST/DELETE /api/public/me/searches           // сохранённые поиски
GET/POST/DELETE /api/public/me/watchlist
GET             /api/public/me/notifications
POST            /api/public/auth/link             // привязка соцсети к существующему аккаунту
POST            /api/public/auth/password/set
POST            /api/public/auth/device/verify    // код при входе с нового устройства
POST            /api/public/auth/telegram         // вход через Telegram Login Widget
```

### 6.4 Вебхуки провайдеров

```
POST /api/webhooks/klix        // paid | failed | cancelled | refunded | bnpl_rejected
POST /api/webhooks/omniva      // in_transit | delivered_to_point | picked_up | returned
POST /api/webhooks/dpd         // те же статусы
```

Требования: идемпотентность по `providerId`, подпись запроса, запись сырого тела в `payments.raw` /
`shipments.raw`, повтор при 5xx.

---

## 7. Новое в схеме БД

```sql
-- Аванс клиента (переплаты, отменённые лоты)
credits(id, customer_id, balance_cents, expires_at, created_at, updated_at)
credit_entries(id, credit_id, order_id, kind, amount_cents, note, created_at)
  kind: overpay | refund_to_credit | used_for_order | withdrawn | expired

-- Реквизиты получателя счёта (физлицо + компании)
billing_profiles(id, customer_id, kind, name, reg_no, vat_no, vies_checked_at,
                 address, contact_person, phone, invoice_email, is_default, created_at)
  kind: person | company

-- Предпочтения оформления
customer_preferences(customer_id, fulfilment, carrier, point_id, address_json,
                     pay_method, bank, billing_profile_id, remember, updated_at)

-- Каналы уведомлений
notification_prefs(customer_id, event, email, push, telegram, updated_at)
  event: outbid | ending | won | invoice | shipment | watchlist | marketing
telegram_links(customer_id, telegram_id, username, linked_at)

-- Сохранённые поиски
saved_searches(id, customer_id, title, filters_json, notify, last_seen_at, created_at)

-- Согласия с версиями
consents(id, customer_id, kind, version, granted, ip, user_agent, created_at)
  kind: terms | privacy | marketing | cookies_analytics | cookies_marketing | cookies_personal
```

Дополнить существующие:

```sql
orders += insurance_cents, proxy_name, proxy_phone, credit_applied_cents, reship_count
shipments += hold_until, returned_at
invoices += kind ('invoice' | 'credit_note' | 'prepayment'), parent_invoice_id
```

---

## 8. Платежи (Klix by Citadele)

**Методы на экране оплаты, в этом порядке:**
1. **Apple Pay / Google Pay** — показываем только тот, что доступен на устройстве
   (`ApplePaySession.canMakePayments()` / Google Pay `isReadyToPay`). Если ни одного — строки нет.
   Кнопку берём из SDK Klix, свою не рисуем: у Apple жёсткие правила по виду кнопки и порядку.
2. **Internetbanka** — Swedbank, SEB, Citadele, Luminor, Revolut. Последний банк запоминаем.
3. **Bankas karte** — Visa, Mastercard, Klix.
4. **Uz vietas, saņemot** — только при `fulfilment = pickup`.
5. **Bankas pārskaitījums** — счёт на почту, срок `payment.deadlineDays`.
6. **Maksāt pa daļām** — Klix и Inbank, сроки 3/6/12/24, расчёт через `bnpl/quote`.

**Правила:**
* один платёж — один `payments.providerId`, повторный вебхук игнорируем;
* при `failed` лот держим `lot.reserveHoursAfterFailedPayment` и показываем **№ 64**;
* деньги не списаны — так и пишем клиенту, резерв банк снимает 1–3 дня;
* при отказе обоих BNPL — **№ 66b**, предлагаем дробление 50/50 (`split.*`);
* переплата → `credits` (**№ 69b**), недоплата → доплата по реквизитам (**№ 69**);
* если `useCredit` — сначала списываем аванс, остаток идёт провайдеру.

---

## 9. Доставка

| Способ | Ограничения | Экран |
|---|---|---|
| Склад Krasta 68 | всегда доступен | № 16 |
| Omniva пакомат | до 60 × 36 × 60 см | № 29 |
| DPD | до 20 кг в точке | № 29 |
| Курьер на адрес | до 30 кг, окна: будни 9–18, вечер +2 €, суббота +3 € | № 74 |
| Крупногабарит | при превышении габаритов пакомат и DPD **блокируются с причиной** | № 75 |

Дополнительно: страховка (**№ 78**), доверенное лицо (**№ 76**), невыкуп из пакомата (**№ 77**) —
посылка возвращается на склад, бесплатное хранение `parcel.holdDays`, повторная отправка **платная**
и уходит только после оплаты (**№ 77b**).

Габариты и вес лота должны приходить в `/auctions/:id` и `/me/orders/:ref`, иначе экран 75 не построить.

---

## 10. Документы

* **Счёт физлицу** (№ 34) и **компании** (№ 43): продавец, покупатель, строки, PVN 21 %, итог,
  контакты бухгалтерии, «Rēķins sagatavots elektroniski un ir derīgs bez paraksta».
* **Счёт компании ЕС** (№ 44): PVN 0 %, отметка reverse charge, `orders.reverseCharge = true`.
* **Кредит-нота** (№ 68): `invoices.kind = credit_note`, ссылка на исходный счёт.
* **Чек** (№ 35 / 41): номер заказа, лот, дата, способ, ID платежа, код получения.
* Нумерация лотов `66-K7Q4C`, заказов `26-8F3KQ` — Crockford Base32, уже в движке.
* На всех счетах есть **мобильный телефон** покупателя; у юрлиц — плюс контактное лицо.

**Конверсии.** Экран чека (№ 41) один раз на заказ отправляет Meta Pixel `Purchase` и Google Ads
`conversion` с `transaction_id`, `value`, `currency`. Защита от повтора — серверный флаг на заказе,
не localStorage.

---

## 11. Аккаунт и вход

**Что даёт провайдер:**

| Поле | Google | Facebook | Telegram |
|---|---|---|---|
| E-mail | есть, подтверждён | иногда нет | нет никогда |
| Имя, фото | есть | есть | есть |
| Телефон | нет | нет | нет |

**Правило:** регистрация в один клик, данные добираем по мере надобности.
Для ставок нужен подтверждённый e-mail; для оплаты — имя и телефон; реквизиты компании — опционально.

* **№ 50** — экран догрузки после Telegram/Facebook: только недостающие поля.
* **№ 53** — e-mail уже занят: привязываем соцсеть к аккаунту, дубли не создаём.
* **№ 54** — пароль для тех, кто зашёл соцсетью.
* **№ 56** — код при входе с нового устройства, «доверять 30 дней» → `trustedDevices`.
* **№ 57** — активные сессии с городом и временем, «выйти на всех устройствах».
* **№ 58** — выгрузка данных (ZIP на почту, ссылка 7 дней) и удаление аккаунта.
  Удаление **запрещено**, пока есть активные ставки, неоплаченные лоты или неполученные покупки.
  Счета и транзакции хранятся 5 лет по закону — обезличиваем профиль, документы остаются
  (в движке для этого уже есть `customerAlias` / `customerEmail` снимки в `orders`).

**Телефон** вводится с кодом страны из выпадающего списка (маска по стране, № 50).

---

## 12. Уведомления и согласия

Матрица событие × канал (**№ 60**): e-mail / push / Telegram.
Юридически обязательные (выиграл лот, счёт и оплата) — только e-mail, выключить нельзя.
Тихие часы 22:00–08:00 для push и Telegram; предупреждения о конце аукциона идут всегда.

**Маркетинг.** Согласие спрашиваем одинаковым блоком: «Sūtiet man 3 interesantākos lotus nedēļā ·
bez surogātpasta · atteikties vienā klikšķī». Место: регистрация, догрузка профиля, экран оплаты,
чек. По умолчанию **выключено** — предотмеченное согласие юридически недействительно.
Как только согласие получено, блок исчезает везде.

Каждое согласие пишем в `consents` с версией документа, датой, IP. При смене версии правил —
просим подтвердить заново (**№ 62**).

---

## 13. Приёмка

* Все 72 экрана проверены на 390 px и 1440 px.
* Оплата: успех, отказ банка, отмена пользователем, отказ BNPL обоих провайдеров, просрочка,
  недоплата, переплата, возврат, повторная отправка.
* Соцлогин: Google (e-mail есть), Facebook (e-mail нет), Telegram (e-mail нет), привязка к существующему.
* Документы: счёт физлицу, счёт SIA, счёт ЕС с reverse charge, кредит-нота, чек.
* Проверить шрифт на всех пяти языках (раздел 3.1) — это регресс, который легко пропустить.
* e2e на стабильность хрома уже есть: `apps/e2e/tests/chrome-stability.spec.ts`.

---

## 14. Порядок выката

1. **Шрифт и иконки** — правка Figtree, Manrope, Phosphor, `BrandMark`. Без миграций, безопасно.
2. **Кабинет** — вкладки, пустые состояния, карточки лотов, выпадающие меню.
3. **Схема БД** — таблицы из раздела 7 + поля к существующим.
4. **Оплата** — checkout, Klix, кошельки, банклинк, BNPL, вебхуки.
5. **Доставка** — Omniva/DPD, курьер, крупногабарит, страховка, доверенное лицо, невыкуп.
6. **Документы** — счета, кредит-нота, чек, конверсии.
7. **Аккаунт** — соцлогин, привязка, сессии, GDPR.
8. **Уведомления и согласия** — матрица, Telegram-бот, `consents`.
9. **Админка** — раздел «Pasūtījumu политика» с параметрами из раздела 2.

Каждый этап — за фича-флагом, кабинет включаем целиком после этапа 2.

---

## 15. Открытые вопросы (блокеры для прода)

1. **Реквизиты SIA** для счетов: регистрационный номер, номер плательщика PVN, банк, IBAN,
   телефон и e-mail бухгалтерии. Сейчас в макетах заглушки `40203XXXXXX`, `+371 2X XXX XXX`.
2. **Правило НДС** подтвердить с бухгалтером: сейчас 21 % на (молоток + комиссия).
   Маржинальная схема из макетов убрана.
3. **Тарифы и сроки** из раздела 2 — подтвердить окончательные цифры.
4. **Санкции за отказ от лота** (комиссия остаётся + блокировка 30 дней) — согласовать с юристом
   и внести в правила аукциона, иначе показывать это клиенту нельзя.
5. **Waze** — нужен файл из брендбука вместо глифа.
6. **Klix**: боевые ключи, набор логотипов банков со страницы representation-guidelines,
   подтверждение доступности Apple Pay и Google Pay на аккаунте.
7. **Omniva и DPD**: API-ключи, договорные тарифы, лимиты габаритов.
