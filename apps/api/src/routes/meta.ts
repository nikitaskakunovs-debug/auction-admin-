import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context.js";
import {
  META_EVENTS,
  hasMarketingConsent,
  identityOfCustomer,
  logMetaSkipped,
  sendMetaEvent,
  type MetaEventName,
  type MetaIdentity,
} from "../engine/metaCapi.js";

/**
 * Приём браузерных событий для серверной копии в Meta.
 *
 * Витрина отправляет сюда то же событие, что уже ушло в пиксель, вместе с его
 * event_id. Сервер добавляет то, чего браузер знать не должен: захешированные
 * данные человека из НАШЕЙ базы, его адрес и браузер. Из тела запроса личные
 * данные не принимаются вовсе — иначе точку приёма можно было бы использовать,
 * чтобы приписать нашему набору данных чужие сведения.
 *
 * Согласие проверяется здесь же и по журналу согласий, а не по словам клиента:
 * витрина и так не зовёт эту точку без согласия, но полагаться на честность
 * браузера в вопросе согласия нельзя.
 */

/** Ключ опознавания живёт месяц: столько же Meta считает окно атрибуции. */
const IDENTITY_TTL_SEC = 30 * 86_400;
const identityKey = (customerId: string) => `meta:id:${customerId}`;

interface CachedIdentity {
  fbp?: string;
  fbc?: string;
  ip?: string;
  ua?: string;
}

/** Запомнить браузерные метки человека — они понадобятся событию, которое
 *  отправит сам движок (оплата подтверждается без участия браузера). */
export async function rememberMetaIdentity(
  ctx: AppContext,
  customerId: string,
  data: CachedIdentity,
): Promise<void> {
  const clean: CachedIdentity = {
    ...(data.fbp ? { fbp: data.fbp } : {}),
    ...(data.fbc ? { fbc: data.fbc } : {}),
    ...(data.ip ? { ip: data.ip } : {}),
    ...(data.ua ? { ua: data.ua } : {}),
  };
  if (Object.keys(clean).length === 0) return;
  await ctx.redis.set(identityKey(customerId), JSON.stringify(clean), "EX", IDENTITY_TTL_SEC);
}

export async function recallMetaIdentity(ctx: AppContext, customerId: string): Promise<CachedIdentity> {
  try {
    const raw = await ctx.redis.get(identityKey(customerId));
    return raw ? (JSON.parse(raw) as CachedIdentity) : {};
  } catch {
    return {};
  }
}

/** Поисковая строка человека может оказаться его же почтой или телефоном —
 *  в рекламный кабинет такое не отдаём ни при каком согласии. */
function redact(value: string): string {
  return value
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "[email]")
    .replace(/(?:\+?\d[\s()-]?){7,}/g, "[phone]")
    .slice(0, 200);
}

/** custom_data принимается по списку полей: чужие ключи в набор данных не
 *  попадают, а числа приходят числами, а не строками из чужого JSON. */
const contentSchema = z.object({
  id: z.string().max(120),
  quantity: z.number().int().min(1).max(999).default(1),
  item_price: z.number().min(0).max(1_000_000).optional(),
});
const customDataSchema = z
  .object({
    content_ids: z.array(z.string().max(120)).max(50).optional(),
    content_type: z.enum(["product", "product_group"]).optional(),
    content_name: z.string().max(300).optional(),
    content_category: z.string().max(120).optional(),
    contents: z.array(contentSchema).max(50).optional(),
    num_items: z.number().int().min(0).max(999).optional(),
    value: z.number().min(0).max(1_000_000).optional(),
    currency: z.enum(["EUR"]).optional(),
    order_id: z.string().max(60).optional(),
    search_string: z.string().max(200).optional(),
    status: z.boolean().optional(),
  })
  .strict();

const bodySchema = z.object({
  event_name: z.enum(META_EVENTS as unknown as [MetaEventName, ...MetaEventName[]]),
  event_id: z.string().min(6).max(120),
  event_source_url: z.string().url().max(600),
  /** Идентификатор браузера из плашки cookie — по нему сверяется согласие. */
  visitor_id: z.string().max(80).optional(),
  /** Cookie самой Meta: уходят как есть, Meta требует их без хеша. */
  fbp: z.string().max(120).optional(),
  fbc: z.string().max(200).optional(),
  custom_data: customDataSchema.optional(),
});

export function registerMetaRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post(
    "/api/public/meta/event",
    {
      // Точка публичная: без своего потолка один браузер мог бы забить нашу
      // квоту в Meta и испортить набор данных.
      config: { rateLimit: { max: 120, timeWindow: "1 minute" } },
    },
    async (req: FastifyRequest, reply) => {
      // Интеграция выключена — отвечаем спокойно, витрина ничего не заметит.
      if (!ctx.config.metaCapi) return { ok: true, sent: false };

      const body = bodySchema.safeParse(req.body ?? {});
      if (!body.success) return reply.code(400).send({ error: "invalid_body" });
      const b = body.data;

      // Purchase отправляет сам движок после подтверждённой оплаты: принимать
      // покупку со слов браузера значит разрешить рисовать себе конверсии.
      if (b.event_name === "Purchase") return { ok: true, sent: false };

      const customerId = req.bidder?.sub ?? null;
      const allowed = await hasMarketingConsent(ctx, { customerId, visitorId: b.visitor_id ?? null });
      if (!allowed) {
        await logMetaSkipped(ctx, {
          eventId: b.event_id, eventName: b.event_name, customerId, reason: "no_marketing_consent",
        });
        return { ok: true, sent: false };
      }

      const ip = req.ip;
      const ua = req.headers["user-agent"]?.slice(0, 400) ?? null;
      const base: MetaIdentity = {
        ip, userAgent: ua,
        ...(b.fbp ? { fbp: b.fbp } : {}),
        ...(b.fbc ? { fbc: b.fbc } : {}),
      };
      const identity: MetaIdentity = customerId
        ? { ...(await identityOfCustomer(ctx, customerId)), ...base }
        : base;

      // Метки пригодятся событию оплаты, которое уйдёт без браузера.
      if (customerId) {
        await rememberMetaIdentity(ctx, customerId, {
          ...(b.fbp ? { fbp: b.fbp } : {}),
          ...(b.fbc ? { fbc: b.fbc } : {}),
          ip, ...(ua ? { ua } : {}),
        }).catch(() => undefined);
      }

      const custom = b.custom_data
        ? {
            ...b.custom_data,
            ...(b.custom_data.search_string
              ? { search_string: redact(b.custom_data.search_string) }
              : {}),
          }
        : undefined;

      sendMetaEvent(ctx, {
        eventName: b.event_name,
        eventId: b.event_id,
        eventSourceUrl: b.event_source_url,
        identity,
        customData: custom,
      });
      return { ok: true, sent: true };
    },
  );
}
