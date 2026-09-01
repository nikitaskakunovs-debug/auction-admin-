import { createHash } from "node:crypto";
import { cookieConsents, customers, metaEvents } from "@auction/db";
import { desc, eq, or } from "drizzle-orm";
import type { AppContext } from "../context.js";

/**
 * Meta Conversions API — серверная копия событий пикселя.
 *
 * Зачем вообще вторая копия. Браузерный пиксель теряет часть событий: блокировщики,
 * Safari с его сроком жизни cookie, закрытая вкладка сразу после оплаты. Сервер
 * этого не теряет. Обе копии несут ОДИН И ТОТ ЖЕ event_id, и Meta склеивает их в
 * одну конверсию — поэтому дублирования не возникает, а покрытие растёт.
 *
 * Три правила, которые здесь соблюдаются буквально:
 *
 *  1. Токен только на сервере. Он приходит из окружения, не логируется, не
 *     попадает в ответы и не пересекает границу к браузеру.
 *  2. Без согласия на маркетинг не уходит ничего. Проверка идёт по журналу
 *     согласий в нашей базе, а не по факту входа и не по наличию адреса:
 *     авторизация — это не согласие на рекламу.
 *  3. Персональные данные уходят только хешем SHA-256 и только после
 *     нормализации по правилам Meta. Незахешированными идут ровно те поля,
 *     которые Meta требует в открытом виде: адрес, браузер и её же cookie.
 */

/** События, которые нам разрешено отправлять. Список закрытый: точка приёма
 *  публичная, и без него в наш набор данных можно было бы налить что угодно. */
export const META_EVENTS = [
  "PageView",
  "ViewContent",
  "Search",
  "AddToCart",
  "InitiateCheckout",
  "Purchase",
  "CompleteRegistration",
  "Login",
  // Кастомные события ставок (по задаче IT): первая успешная ставка
  // человека и все последующие. Имена согласованы для Browser и CAPI.
  "FirstBidPlaced",
  "BidPlaced",
] as const;
export type MetaEventName = (typeof META_EVENTS)[number];

const TIMEOUT_MS = 4_000;
const MAX_ATTEMPTS = 3;

/** Нормализация по правилам Meta, затем SHA-256. Пустое значение → undefined:
 *  пустая строка и «null» строкой считаются у Meta мусорными данными и портят
 *  оценку качества сопоставления. */
function hashed(value: string | null | undefined, normalize: (v: string) => string): string | undefined {
  if (value === null || value === undefined) return undefined;
  const norm = normalize(String(value));
  if (!norm) return undefined;
  return createHash("sha256").update(norm).digest("hex");
}

const asEmail = (v: string) => v.trim().toLowerCase();
const asName = (v: string) => v.trim().toLowerCase().replace(/\s+/g, " ");
const asCountry = (v: string) => v.trim().toLowerCase().slice(0, 2);
const asZip = (v: string) => v.trim().toLowerCase().replace(/\s+/g, "");
/** Телефон — только цифры вместе с кодом страны; ведущие «00» и «+» уходят. */
const asPhone = (v: string) => {
  const digits = v.replace(/\D/g, "").replace(/^00/, "");
  return digits.length >= 8 ? digits : "";
};

/** Что мы знаем о человеке в момент события. */
export interface MetaIdentity {
  customerId?: string | null;
  email?: string | null;
  phone?: string | null;
  name?: string | null;
  country?: string | null;
  zip?: string | null;
  city?: string | null;
  /** Не хешируются — Meta требует их в открытом виде. */
  ip?: string | null;
  userAgent?: string | null;
  fbp?: string | null;
  fbc?: string | null;
}

/** user_data по правилам Meta: хеш там, где требуется хеш, и ничего пустого. */
export function buildUserData(id: MetaIdentity): Record<string, unknown> {
  const parts = (id.name ?? "").trim().split(/\s+/).filter(Boolean);
  const out: Record<string, unknown> = {
    ...(hashed(id.email, asEmail) ? { em: [hashed(id.email, asEmail)] } : {}),
    ...(hashed(id.phone, asPhone) ? { ph: [hashed(id.phone, asPhone)] } : {}),
    ...(parts[0] ? { fn: [hashed(parts[0], asName)] } : {}),
    ...(parts.length > 1 ? { ln: [hashed(parts.slice(1).join(" "), asName)] } : {}),
    ...(hashed(id.city, asName) ? { ct: [hashed(id.city, asName)] } : {}),
    ...(hashed(id.zip, asZip) ? { zp: [hashed(id.zip, asZip)] } : {}),
    ...(hashed(id.country, asCountry) ? { country: [hashed(id.country, asCountry)] } : {}),
    // external_id — наш внутренний идентификатор. Meta принимает и хеш, и
    // открытое значение; шлём хеш, чтобы наружу не уходил ключ нашей базы.
    ...(id.customerId ? { external_id: [hashed(id.customerId, (v) => v)] } : {}),
    ...(id.ip ? { client_ip_address: id.ip } : {}),
    ...(id.userAgent ? { client_user_agent: id.userAgent } : {}),
    ...(id.fbp ? { fbp: id.fbp } : {}),
    ...(id.fbc ? { fbc: id.fbc } : {}),
  };
  return out;
}

/**
 * Есть ли у человека действующее согласие на маркетинговые cookie.
 *
 * Источник один — журнал согласий: то, что человек нажал в плашке, и что мы
 * умеем предъявить. Ни вход в аккаунт, ни наличие адреса согласием не
 * являются, и подставлять их вместо него нельзя.
 */
export async function hasMarketingConsent(
  ctx: AppContext,
  who: { customerId?: string | null; visitorId?: string | null },
): Promise<boolean> {
  if (!who.customerId && !who.visitorId) return false;
  const parts = [
    ...(who.customerId ? [eq(cookieConsents.customerId, who.customerId)] : []),
    ...(who.visitorId ? [eq(cookieConsents.visitorId, who.visitorId)] : []),
  ];
  const [row] = await ctx.db
    .select({ marketing: cookieConsents.marketing })
    .from(cookieConsents)
    .where(parts.length === 1 ? parts[0]! : or(...parts))
    .orderBy(desc(cookieConsents.createdAt))
    .limit(1);
  // Записи нет — значит человек ещё не отвечал; молчание согласием не является.
  return row?.marketing === true;
}

/** Личность зарегистрированного клиента для сопоставления. */
export async function identityOfCustomer(ctx: AppContext, customerId: string): Promise<MetaIdentity> {
  const [c] = await ctx.db
    .select({
      id: customers.id,
      email: customers.email,
      name: customers.name,
      country: customers.country,
      erasedAt: customers.erasedAt,
    })
    .from(customers)
    .where(eq(customers.id, customerId));
  // Удалённый аккаунт: данных больше нет и отправлять нечего.
  if (!c || c.erasedAt !== null) return {};
  // Служебный адрес соцвхода — не настоящая почта, Meta по нему никого не
  // найдёт, а качество сопоставления просядет.
  const email = c.email.endsWith("@nav.izsoli.lv") ? null : c.email;
  return { customerId: c.id, email, name: c.name, country: c.country };
}

export interface MetaEventInput {
  eventName: MetaEventName;
  /** Тот же идентификатор, что ушёл в браузерный пиксель. */
  eventId: string;
  eventSourceUrl: string;
  identity: MetaIdentity;
  customData?: Record<string, unknown> | undefined;
  /** Момент действия; по умолчанию — сейчас. */
  eventTime?: Date | undefined;
}

/**
 * Отправить событие. Ничего не ждёт и никого не задерживает: страница и
 * подтверждение заказа не должны зависеть от того, как сегодня отвечает Meta.
 * Возвращает признак «взяли в работу», а не «доставлено».
 */
export function sendMetaEvent(ctx: AppContext, input: MetaEventInput): void {
  if (!ctx.config.metaCapi) return;
  void deliver(ctx, input).catch((err) => {
    // Ошибка отправки не должна всплывать в бизнес-поток: реклама важна, но
    // не настолько, чтобы ронять оплату.
    console.error("meta capi delivery failed", (err as Error).message);
  });
}

/** Записать отказ по согласию — чтобы в журнале было видно, что событие не
 *  потерялось, а сознательно не отправлено. */
export async function logMetaSkipped(
  ctx: AppContext,
  args: { eventId: string; eventName: string; customerId?: string | null; reason: string },
): Promise<void> {
  await ctx.db
    .insert(metaEvents)
    .values({
      eventId: args.eventId,
      eventName: args.eventName,
      customerId: args.customerId ?? null,
      status: "skipped",
      error: args.reason,
    })
    .onConflictDoNothing();
}

async function deliver(ctx: AppContext, input: MetaEventInput): Promise<void> {
  const cfg = ctx.config.metaCapi!;
  const now = ctx.now();

  // Журнал заводится ДО отправки и по уникальному event_id: повторный вызов с
  // тем же идентификатором (перезагрузка страницы, повтор вебхука) второй раз
  // в Meta не пойдёт.
  const rows = await ctx.db
    .insert(metaEvents)
    .values({
      eventId: input.eventId,
      eventName: input.eventName,
      customerId: input.identity.customerId ?? null,
      status: "pending",
    })
    .onConflictDoNothing()
    .returning({ id: metaEvents.id });
  if (rows.length === 0) return; // уже отправляли — дубля не создаём

  const payload = {
    data: [
      {
        event_name: input.eventName,
        event_time: Math.floor((input.eventTime ?? now).getTime() / 1000),
        event_id: input.eventId,
        action_source: "website",
        event_source_url: input.eventSourceUrl,
        user_data: buildUserData(input.identity),
        ...(input.customData ? { custom_data: input.customData } : {}),
      },
    ],
    ...(cfg.testEventCode ? { test_event_code: cfg.testEventCode } : {}),
  };

  const url = `https://graph.facebook.com/${cfg.graphVersion}/${cfg.datasetId}/events`;
  let attempts = 0;
  let httpStatus: number | null = null;
  let traceId: string | null = null;
  let error: string | null = null;

  while (attempts < MAX_ATTEMPTS) {
    attempts += 1;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: "POST",
        // Токен идёт телом, а не в адресе: адреса попадают в логи прокси и
        // журналы доступа, и секрет там оставлять нельзя.
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...payload, access_token: cfg.accessToken }),
        signal: ac.signal,
      });
      httpStatus = res.status;
      const body = (await res.json().catch(() => ({}))) as {
        fbtrace_id?: string;
        error?: { message?: string; fbtrace_id?: string; is_transient?: boolean };
      };
      traceId = body.fbtrace_id ?? body.error?.fbtrace_id ?? null;
      if (res.ok) {
        await ctx.db
          .update(metaEvents)
          .set({ status: "sent", attempts, httpStatus, traceId, sentAt: ctx.now(), error: null })
          .where(eq(metaEvents.eventId, input.eventId));
        return;
      }
      error = (body.error?.message ?? `HTTP ${res.status}`).slice(0, 400);
      // Наши же ошибки (неверный параметр, просроченный токен) повтором не
      // лечатся — только чужие временные.
      const transient = res.status >= 500 || res.status === 429 || body.error?.is_transient === true;
      if (!transient) break;
    } catch (err) {
      error = (err as Error).name === "AbortError" ? "timeout" : (err as Error).message.slice(0, 400);
    }
    if (attempts < MAX_ATTEMPTS) await new Promise((r) => setTimeout(r, 400 * attempts));
  }

  await ctx.db
    .update(metaEvents)
    .set({ status: "failed", attempts, httpStatus, traceId, error })
    .where(eq(metaEvents.eventId, input.eventId));
}
