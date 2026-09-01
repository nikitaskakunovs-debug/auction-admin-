"use client";

/** Мост к Google Tag Manager.
 *
 *  События уходят в dataLayer; если GTM на этой сборке не подключён
 *  (нет NEXT_PUBLIC_GTM_ID) — вызовы тихо ничего не делают, поэтому
 *  инструментированные места не проверяют окружение сами.
 *
 *  Персональные данные сюда не попадают: только идентификаторы лотов,
 *  суммы и названия событий. Кто именно смотрел — решают пиксели после
 *  согласия, и это их зона ответственности, не наша.
 */

import { PUBLIC_API_URL } from "./config";

type DataLayer = Array<Record<string, unknown> | IArguments>;

const dl = (): DataLayer | null => {
  if (typeof window === "undefined") return null;
  return (window as unknown as { dataLayer?: DataLayer }).dataLayer ?? null;
};

/** События, у которых GA4 читает товары из ключа ecommerce. Перед КАЖДЫМ
 *  таким событием ключ обнуляется — даже если карточка товара не собралась:
 *  иначе GTM рекурсивно домешает товар из прошлого события (парка вместо
 *  зāģis — реальный случай с теста). */
const ECOM_EVENTS = new Set(["view_item", "add_to_cart", "view_cart", "begin_checkout", "purchase"]);

/** Поисковую строку человек пишет сам — иногда это его же почта или телефон.
 *  Отправлять такое в аналитику нельзя (политика Google и GDPR), поэтому
 *  заменяем на метку: сам факт поиска остаётся, личные данные — нет. */
function redact(value: string): string {
  return value
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "[email]")
    .replace(/(?:\+?\d[\s()-]?){7,}/g, "[phone]");
}

/** Наши события → стандартные имена Meta. Что не в таблице — серверной копии
 *  не имеет: у Meta нет подходящего стандартного события, а выдумывать своё
 *  ради одной строки в отчёте не стоит (view_cart считает GA4). */
const META_NAME: Record<string, string> = {
  page_view: "PageView",
  view_item: "ViewContent",
  search: "Search",
  add_to_cart: "AddToCart",
  begin_checkout: "InitiateCheckout",
  purchase: "Purchase",
  sign_up: "CompleteRegistration",
  login: "Login",
};

/** Идентификатор одного действия. Уходит и в пиксель (eventID), и на сервер:
 *  по нему Meta склеивает браузерную и серверную копии в одну конверсию.
 *  Не выводится из времени — два действия в одну секунду обязаны отличаться. */
function newEventId(event: string): string {
  const rnd =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2) + Date.now().toString(36);
  return `${event}-${rnd}`;
}

/** Cookie Meta: уходят без хеша, так требует сама Meta. `_fbc` собирается из
 *  fbclid, если пиксель ещё не успел записать cookie сам. */
function metaCookies(): { fbp?: string; fbc?: string } {
  if (typeof document === "undefined") return {};
  const get = (name: string) =>
    document.cookie.split("; ").find((c) => c.startsWith(`${name}=`))?.split("=")[1];
  const fbp = get("_fbp");
  let fbc = get("_fbc");
  if (!fbc) {
    const clid = new URLSearchParams(window.location.search).get("fbclid");
    if (clid) fbc = `fb.1.${Date.now()}.${clid}`;
  }
  return { ...(fbp ? { fbp } : {}), ...(fbc ? { fbc } : {}) };
}

/** Есть ли согласие на маркетинг. Без него ни пиксель, ни серверная копия не
 *  имеют права ни на событие, ни на данные человека. */
function marketingAllowed(): boolean {
  try {
    const c = JSON.parse(localStorage.getItem("izsoli_cc_v1") ?? "null") as { marketing?: boolean } | null;
    return c?.marketing === true;
  } catch {
    return false;
  }
}

/**
 * Серверная копия события (Meta CAPI).
 *
 * Личных данных отсюда не уходит вовсе: сервер берёт их из своей базы и
 * хеширует сам. Наружу идут только имя события, его идентификатор, адрес
 * страницы, товарные поля и cookie самой Meta.
 *
 * Purchase здесь не отправляется: покупку подтверждает движок после реальной
 * оплаты, и присылать её со слов браузера значило бы разрешить рисовать
 * конверсии.
 */
function mirrorToMeta(event: string, eventId: string, params: Record<string, unknown>): string {
  const name = META_NAME[event];
  if (!name) return "нет у Meta";
  if (name === "Purchase") return "только сервер";
  if (!marketingAllowed()) return "нет согласия";

  const ec = params.ecommerce as { items?: Array<Record<string, unknown>>; value?: number } | undefined;
  const items = ec?.items ?? [];
  const ids = items.map((i) => String(i.item_id)).filter(Boolean);
  const custom: Record<string, unknown> = {
    ...(ids.length ? { content_ids: ids, content_type: "product" } : {}),
    ...(items.length === 1 && items[0]!.item_name ? { content_name: String(items[0]!.item_name) } : {}),
    ...(items.length === 1 && items[0]!.item_category ? { content_category: String(items[0]!.item_category) } : {}),
    ...(items.length
      ? {
          contents: items.map((i) => ({
            id: String(i.item_id),
            quantity: 1,
            ...(typeof i.price === "number" ? { item_price: i.price } : {}),
          })),
          num_items: items.length,
        }
      : {}),
    ...(typeof params.value === "number" ? { value: params.value, currency: "EUR" } : {}),
    ...(typeof params.search_term === "string" ? { search_string: redact(params.search_term) } : {}),
    ...(name === "CompleteRegistration" ? { status: true } : {}),
  };

  let visitorId: string | null = null;
  try {
    visitorId = localStorage.getItem("izsoli_visitor_v1");
  } catch { /* приватный режим — сервер сверит согласие по аккаунту */ }

  const body = JSON.stringify({
    event_name: name,
    event_id: eventId,
    event_source_url: window.location.href,
    ...(visitorId ? { visitor_id: visitorId } : {}),
    ...metaCookies(),
    ...(Object.keys(custom).length ? { custom_data: custom } : {}),
  });

  // Токен сессии нужен, чтобы сервер узнал человека и подставил его данные;
  // сам запрос ничего не ждёт и никого не задерживает.
  void import("./api")
    .then(({ publicApi }) =>
      fetch(`${PUBLIC_API_URL}/api/public/meta/event`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(publicApi.accessToken ? { authorization: `Bearer ${publicApi.accessToken}` } : {}),
        },
        body,
        keepalive: true,
      }),
    )
    .catch(() => undefined);
  return "ушло";
}

/* ═══════════════════════ ДИАГНОСТИКА ═══════════════════════
 *
 * Дневник последних событий Meta: что ушло на сервер и был ли в этот момент
 * жив пиксель. Нужен ровно для одного вопроса — почему в Events Manager
 * появляются Server-only строки. Личных данных здесь нет, панель открывается
 * только вручную адресом ?metadebug=1 и видна лишь тому, кто её открыл.
 */
export interface MetaTrace {
  at: string;
  event: string;
  eventId: string;
  server: string;
  browser: string;
  /** Кто вызвал — для строк, снятых прямо с пикселя. */
  from?: string;
}
/** Дневник переживает полную перезагрузку страницы: половина воронки —
 *  оплата и возврат с неё — это уход с сайта и обратно, и без сохранения
 *  самые интересные строки исчезали бы ровно там, где их и надо смотреть.
 *  Пишем только при открытой панели: обычному посетителю это ни к чему. */
const TRACE_KEY = "izsoli_meta_trace_v1";
function loadTraces(): MetaTrace[] {
  try {
    const raw = JSON.parse(sessionStorage.getItem(TRACE_KEY) ?? "[]") as unknown;
    return Array.isArray(raw) ? (raw as MetaTrace[]) : [];
  } catch { return []; }
}
const traces: MetaTrace[] = typeof window === "undefined" ? [] : loadTraces();
const traceWatchers = new Set<() => void>();

/** Жив ли пиксель прямо сейчас. */
export function pixelReady(): boolean {
  return typeof window !== "undefined" && typeof (window as unknown as { fbq?: unknown }).fbq === "function";
}

/**
 * Наблюдатель за вызовами пикселя.
 *
 * Events Manager показывает, что событие пришло, но не показывает, кто его
 * отправил. Лишний PageView без eventID может прийти из базового тега Meta,
 * из второго тега в GTM или из автоматической настройки самой Meta — и
 * различить их по журналу Meta нельзя.
 *
 * Поэтому подменяем `fbq` обёрткой, которая записывает имя события, наличие
 * eventID и файл, откуда пришёл вызов, — и передаёт вызов дальше без единого
 * изменения. Ставится только при открытой панели: подмена глобальной функции
 * рекламной системы — не то, что стоит держать включённым для посетителей.
 */
type Fbq = ((...args: unknown[]) => unknown) & Record<string, unknown>;

/** По стеку вызова понять, чей это был fbq: тег GTM, наш код или сам пиксель. */
function callerOf(stack: string | undefined): string {
  const line = (stack ?? "")
    .split("\n")
    .slice(2)
    .find((l) => !l.includes("track.") && /https?:\/\//.test(l));
  const url = /(https?:\/\/[^\s)]+)/.exec(line ?? "")?.[1] ?? "";
  if (/gtm\.js|googletagmanager/.test(url)) return "тег GTM";
  if (/fbevents|connect\.facebook/.test(url)) return "сам пиксель";
  if (/\/_next\//.test(url)) return "код витрины";
  return url ? url.replace(/^https?:\/\/[^/]+/, "").slice(0, 40) : "неизвестно";
}

let pixelCalls = 0;
export function watchPixelCalls(): void {
  const w = window as unknown as { fbq?: Fbq; _fbq?: Fbq; __izsoliFbqWatch?: boolean };
  if (w.__izsoliFbqWatch) return;

  const install = (): boolean => {
    const orig = w.fbq;
    if (typeof orig !== "function") return false;
    const wrapped = function (this: unknown, ...args: unknown[]) {
      try {
        if (args[0] === "track" || args[0] === "trackCustom") {
          const opts = (args[3] ?? args[2]) as { eventID?: string } | undefined;
          const id = typeof opts?.eventID === "string" ? opts.eventID : "";
          pixelCalls += 1;
          noteTrace(
            `fbq: ${String(args[1] ?? "?")}`,
            id || `pixel-${pixelCalls}`,
            "—",
            id ? "ушло с eventID" : "БЕЗ eventID — дубль",
            callerOf(new Error().stack),
          );
        }
      } catch { /* диагностика не имеет права ломать пиксель */ }
      return (orig as (...a: unknown[]) => unknown).apply(this, args);
    } as unknown as Fbq;
    // Свойства пикселя (queue, callMethod, loaded, version) обязаны уехать
    // вместе с функцией: fbevents.js читает их с той же ссылки.
    for (const k of Object.keys(orig)) wrapped[k] = orig[k];
    w.fbq = wrapped;
    w._fbq = wrapped;
    w.__izsoliFbqWatch = true;
    return true;
  };

  if (install()) return;
  // Пикселя ещё нет — дожидаемся, но не вечно.
  let waited = 0;
  const timer = setInterval(() => {
    waited += 200;
    if (install() || waited >= PIXEL_WAIT_MS) clearInterval(timer);
  }, 200);
}

// Если панель уже открыта в этой вкладке — ставим наблюдателя сразу при
// загрузке кода, не дожидаясь отрисовки самой панели: базовый тег Meta
// отрабатывает рано, и поставленный позже наблюдатель его вызов пропустит.
if (typeof window !== "undefined") {
  try {
    if (sessionStorage.getItem("izsoli_metadebug") === "1") watchPixelCalls();
  } catch { /* нет хранилища — наблюдателя поставит панель */ }
}

export const metaTrace = {
  list: (): readonly MetaTrace[] => traces,
  subscribe(fn: () => void): () => void {
    traceWatchers.add(fn);
    return () => { traceWatchers.delete(fn); };
  },
};

function ping(): void {
  try {
    if (sessionStorage.getItem("izsoli_metadebug") === "1") {
      sessionStorage.setItem(TRACE_KEY, JSON.stringify(traces));
    }
  } catch { /* нет хранилища — дневник живёт только в памяти */ }
  for (const fn of traceWatchers) fn();
}

function noteTrace(event: string, eventId: string, server: string, browser: string, from?: string): MetaTrace {
  const row: MetaTrace = {
    at: new Date().toLocaleTimeString("lv-LV", { hour12: false }),
    event: META_NAME[event] ?? event,
    eventId,
    server,
    ...(from ? { from } : {}),
    browser,
  };
  traces.push(row);
  if (traces.length > 60) traces.shift();
  ping();
  return row;
}

/**
 * Дождаться готовности пикселя.
 *
 * Тег Meta в GTM вызывает fbq. Пока базовый тег не отработал, fbq не
 * существует, и любой тег Meta срабатывает вхолостую: в Meta приезжает одна
 * серверная копия, склеивать её не с чем.
 *
 * Базовый тег висит на загрузке контейнера, а она бывает раз на страницу.
 * Если в тот момент согласия на рекламу ещё не было, тег не сработал — и на
 * переходах внутри витрины fbq не появится вовсе, потому что контейнер
 * повторно не грузится. Отсюда и брались Server-only события целыми сериями:
 * не «первая секунда после загрузки», а весь отрезок до следующей полной
 * перезагрузки страницы.
 *
 * Поэтому ждём долго — но не вечно: у человека с блокировщиком fbq не
 * появится никогда, и держать таймер смысла нет. Событие в этом случае уже
 * учтено сервером, и это ровно тот случай, когда Server-only законен.
 */
const PIXEL_WAIT_MS = 20_000;
/** `run` возвращает false, если отправка отменена — тогда дневник не трогаем:
 *  причину отмены run записал сам. */
function whenPixelReady(run: () => boolean | void, trace?: MetaTrace): void {
  if (pixelReady()) {
    const sent = run() !== false;
    if (trace && sent) { trace.browser = "ушло сразу"; ping(); }
    return;
  }
  let waited = 0;
  const timer = setInterval(() => {
    waited += 100;
    if (pixelReady()) {
      clearInterval(timer);
      const sent = run() !== false;
      if (trace && sent) { trace.browser = `ушло через ${(waited / 1000).toFixed(1)} с`; ping(); }
    } else if (waited >= PIXEL_WAIT_MS) {
      clearInterval(timer);
      if (trace) { trace.browser = "fbq так и не появился"; ping(); }
    }
  }, 100);
}

/**
 * Дождаться, пока событие реально уйдёт из браузера, и только потом уходить
 * со страницы.
 *
 * Серверная копия переживает переход — она отправляется с keepalive. А запрос
 * пикселя обрывается вместе со страницей, и получалось, что у входа и у
 * добавления в корзину, после которых сразу идёт переход, до Meta доезжала
 * только серверная половина. GTM для этого и придумал eventCallback: он
 * вызывается, когда теги этого события отработали.
 *
 * Свой таймер обязателен: если GTM заблокирован расширением, eventCallback не
 * вызовет никто, и человек навсегда останется на странице входа.
 */
function navGuard(done: () => void, timeoutMs: number): Record<string, unknown> {
  let fired = false;
  const fire = () => {
    if (fired) return;
    fired = true;
    done();
  };
  setTimeout(fire, timeoutMs);
  return { eventCallback: fire, eventTimeout: timeoutMs };
}

export interface TrackOptions {
  /** Куда идти после того, как событие ушло из браузера. */
  onDone?: () => void;
  /** Сколько максимум ждать GTM, прежде чем идти дальше. */
  timeoutMs?: number;
}

export function track(event: string, params: Record<string, unknown> = {}, opts: TrackOptions = {}): void {
  const layer = dl();
  const safe = typeof params.search_term === "string"
    ? { ...params, search_term: redact(params.search_term) }
    : params;
  // Идентификатор действия: если вызывающая сторона задала свой (покупка —
  // `purchase-<номер заказа>`), берём его; иначе создаём новый.
  const eventId = typeof safe.event_id === "string" ? safe.event_id : newEventId(event);
  if (layer) {
    if ("ecommerce" in safe || ECOM_EVENTS.has(event)) layer.push({ ecommerce: null });
    // event_id уходит в dataLayer, чтобы тег Meta в GTM передал его пикселю
    // как eventID — без этого браузерная и серверная копии не склеятся.
    layer.push({
      event,
      event_id: eventId,
      ...safe,
      ...(opts.onDone ? navGuard(opts.onDone, opts.timeoutMs ?? 1200) : {}),
    });
  } else if (opts.onDone) {
    // GTM на этой сборке нет — задерживать человека незачем.
    opts.onDone();
  }
  const server = mirrorToMeta(event, eventId, safe);
  if (META_NAME[event]) {
    noteTrace(
      event, eventId, server,
      !layer ? "нет dataLayer" : pixelReady() ? "ушло в GTM, пиксель жив" : "GTM принял, но fbq нет",
    );
  }
}

/**
 * PageView для Meta.
 *
 * Единственное событие, чью браузерную половину шлёт базовый тег GTM, а не
 * наш код. Пока этот тег срабатывает на «All Pages» без eventID, склеить его
 * с серверной копией нечем — и Meta посчитала бы просмотр дважды. Поэтому
 * серверная копия выключена по умолчанию и включается флагом ПОСЛЕ того, как
 * базовый тег переведён на событие `meta_page_view` и получает из него
 * eventID. Имя события новое: ни один существующий триггер GA4 его не
 * слушает, так что настройка GA4 при этом не задета.
 */
let pageViewSeq = 0;
export function trackPageView(): void {
  if (process.env.NEXT_PUBLIC_META_PAGEVIEW !== "1") return;
  const eventId = newEventId("page_view");
  const seq = ++pageViewSeq;

  // Серверную копию отправляем сразу: она ни от чего в браузере не зависит и
  // дойдёт даже там, где пиксель заблокирован.
  const server = mirrorToMeta("page_view", eventId, {});

  // Браузерную — когда пиксель готов принять вызов. Если человек успел уйти
  // на другую страницу, отложенный просмотр НЕ отправляем: он ушёл бы с
  // адресом уже новой страницы, и в dataLayer оказались бы два meta_page_view
  // на один переход — свой и запоздавший чужой. Актуален только последний.
  const layer = dl();
  const trace = noteTrace("page_view", eventId, server, layer ? "ждём fbq…" : "нет dataLayer");
  if (!layer) return;
  whenPixelReady(() => {
    if (seq !== pageViewSeq) {
      trace.browser = "отменён — человек уже на другой странице";
      ping();
      return false;
    }
    layer.push({ event: "meta_page_view", event_id: eventId });
  }, trace);
}

/** Товарная строка GA4 (items[]) по ТЗ аналитики:
 *  item_id — номер лота (SKU, DEMO-KID-B), UUID карточки — отдельно как
 *  listing_id; price — лот + обязательная комиссия, БЕЗ НДС; gross_price —
 *  с НДС. Одинаковый item_id держит воронку от просмотра до покупки. */
export function gaItem(i: {
  sku: string; listingId?: string; name: string; category?: string | null;
  netCents: number; hammerCents?: number; feeCents?: number;
  vatRateBp?: number; grossCents?: number;
}) {
  return {
    item_id: i.sku,
    ...(i.listingId ? { listing_id: i.listingId } : {}),
    item_name: i.name,
    ...(i.category ? { item_category: i.category } : {}),
    price: i.netCents / 100,
    quantity: 1,
    ...(i.hammerCents !== undefined ? { hammer_price: i.hammerCents / 100 } : {}),
    ...(i.feeCents !== undefined ? { auction_fee: i.feeCents / 100 } : {}),
    ...(i.vatRateBp !== undefined ? { vat_rate: i.vatRateBp / 100 } : {}),
    ...(i.grossCents !== undefined ? { gross_price: i.grossCents / 100 } : {}),
  };
}

/** Заказ движка → карточка товара + суммы. Net = молоток + комиссия (без
 *  НДС), gross = с НДС; доставка в gross_price лота не входит — она общая. */
export interface OrderLike {
  ref: string; itemSku: string; itemTitle: string; itemCategory?: string | null;
  hammerCents: number; premiumCents: number; vatCents: number;
  vatRateBp?: number; reverseCharge?: boolean;
  shippingCents: number; handlingCents: number; totalCents: number;
}
export function orderEcom(o: OrderLike) {
  const netCents = o.hammerCents + o.premiumCents;
  return {
    netCents,
    taxCents: o.vatCents,
    shippingCents: o.shippingCents + o.handlingCents,
    grossCents: o.totalCents,
    commissionCents: o.premiumCents,
    vatScheme: o.reverseCharge ? "reverse_charge" : "standard",
    item: gaItem({
      sku: o.itemSku, name: o.itemTitle, category: o.itemCategory,
      netCents, hammerCents: o.hammerCents, feeCents: o.premiumCents,
      ...(o.vatRateBp !== undefined ? { vatRateBp: o.vatRateBp } : {}),
      grossCents: netCents + o.vatCents,
    }),
  };
}

/** First-party данные для Google Ads Enhanced Conversions (begin_checkout и
 *  purchase). Правила:
 *  — собираются ТОЛЬКО при согласии на маркетинг (сигнал ad_user_data):
 *    без галочки в плашке объект вообще не попадает в dataLayer;
 *  — ничего не хэшируем сами — это делает тег Google в GTM;
 *  — почта в lowercase без пробелов, телефон только в международном формате,
 *    отсутствующие поля не передаются;
 *  — в GA4 эти поля не уходят: их читает только тег Google Ads, GA4-теги
 *    к user_data не привязаны. */
export function adsUserData(i: {
  email?: string | null; phone?: string | null; name?: string | null;
  country?: string | null; zip?: string | null;
}): { user_data?: Record<string, unknown> } {
  try {
    const c = JSON.parse(localStorage.getItem("izsoli_cc_v1") ?? "null") as { marketing?: boolean } | null;
    if (c?.marketing !== true) return {};
  } catch { return {}; }
  const email = i.email?.trim().toLowerCase() || undefined;
  const cleaned = (i.phone ?? "").replace(/[\s()-]/g, "");
  const phone = /^\+\d{8,15}$/.test(cleaned) ? cleaned : undefined;
  const parts = (i.name ?? "").trim().split(/\s+/).filter(Boolean);
  const address = {
    ...(parts[0] ? { first_name: parts[0] } : {}),
    ...(parts.length > 1 ? { last_name: parts.slice(1).join(" ") } : {}),
    ...(i.country ? { country: i.country } : {}),
    ...(i.zip ? { postal_code: i.zip } : {}),
  };
  const user_data = {
    ...(email ? { email } : {}),
    ...(phone ? { phone_number: phone } : {}),
    ...(Object.keys(address).length > 0 ? { address } : {}),
  };
  return Object.keys(user_data).length > 0 ? { user_data } : {};
}

/** Событие ровно один раз на заказ.
 *
 *  Некоторые шаги воронки происходят не по нажатию, а по факту: лот выигран и
 *  ждёт оплаты. Такое видно при каждом заходе в кабинет, и без отметки Meta и
 *  Google получали бы add_to_cart на каждое обновление страницы — воронка
 *  раздувалась бы на ровном месте. Отметка живёт в браузере; если хранилище
 *  недоступно (приватный режим), событие уходит — лучше лишнее, чем пустая
 *  воронка, а GA4 дедуплицирует покупки по transaction_id сам. */
function trackOnce(key: string, event: string, params: Record<string, unknown>, opts: TrackOptions = {}): void {
  try {
    if (localStorage.getItem(key)) {
      // Событие уже учтено — но переход выполнить обязаны, иначе человек
      // останется на странице лота, нажав «купить» второй раз.
      opts.onDone?.();
      return;
    }
    localStorage.setItem(key, "1");
  } catch { /* приватный режим — полагаемся на дедупликацию на стороне GA4 */ }
  track(event, params, opts);
}

/** purchase — ровно один раз на заказ: обновление страницы чека или возврат
 *  на неё не должны дублировать конверсию. */
export function purchaseOnce(ref: string, params: Record<string, unknown>): void {
  trackOnce(`izsoli_ga_purchase_${ref}`, "purchase", params);
}

/** add_to_cart — один раз на заказ.
 *
 *  «Корзина» здесь — список неоплаченных лотов, и лот попадает в неё двумя
 *  путями: нажатием «Pirkt tagad» и победой на торгах. Второй путь — не клик,
 *  поэтому и нужна отметка. Без этого события у покупателя одного лота
 *  воронка Meta и Google рвалась: просмотр → сразу оплата, а ступени
 *  AddToCart, на которую настраивают кампании, не было вовсе. */
export function addToCartOnce(ref: string, params: Record<string, unknown>, opts: TrackOptions = {}): void {
  trackOnce(`izsoli_ga_atc_${ref}`, "add_to_cart", params, opts);
}

/** Обновление Google Consent Mode при каждом решении в плашке cookie.
 *  Consent-команды читаются только из arguments-объекта (стиль gtag) —
 *  обычный объект в dataLayer Consent Mode не увидит. */
export function consentUpdate(analytics: boolean, marketing: boolean): void {
  const layer = dl();
  if (!layer) return;
  /* eslint-disable prefer-rest-params */
  function gtag() { layer!.push(arguments); }
  (gtag as unknown as (...a: unknown[]) => void)("consent", "update", {
    analytics_storage: analytics ? "granted" : "denied",
    ad_storage: marketing ? "granted" : "denied",
    ad_user_data: marketing ? "granted" : "denied",
    ad_personalization: marketing ? "granted" : "denied",
  });
  /* Отдельный сигнал «рекламное согласие только что получено».
   *
   * Базовый тег пикселя висит на загрузке контейнера. Человек, который
   * согласился уже ПОСЛЕ неё, до конца сессии остаётся без fbq: контейнер
   * повторно не грузится, а внутри витрины переходы идут без перезагрузки.
   * Этот сигнал даёт базовому тегу второй повод сработать — сразу, а не со
   * следующей полной загрузки страницы.
   *
   * Имя новое: ни один существующий триггер его не слушает, поэтому GA4 и
   * прочая настройка от появления сигнала не меняются. */
  if (marketing) layer.push({ event: "meta_consent_granted" });
}
