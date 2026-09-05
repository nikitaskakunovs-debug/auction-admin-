import {
  campaigns,
  customers,
  items,
  lifecycleMarks,
  listings,
  orders,
  referralCodes,
  segmentMembers,
  segments,
  loyaltyAccounts,
  userCategoryStats,
  userEvents,
  userRfm,
  type Db,
} from "@auction/db";
import { and, desc, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import type { AppContext } from "../context.js";
import { enqueueMarketing } from "./marketing.js";
import { issuePersonalCode } from "./promo.js";
import { getSettings } from "./settings.js";

/**
 * Движок роста (план v15, MD §1–2, §7): журнал поведения, ночная сводка
 * интересов и RFM, материализация сегментов, рассылка кампаний и
 * lifecycle-письма. Всё — простыми SQL-правилами, без ML (MD, цель).
 *
 * Каждое письмо здесь идёт через enqueueMarketing — то есть через согласие,
 * стоп-сигналы, недельный лимит, 48-часовой зазор и ночную тишину.
 */


/** Дешёвый детерминированный хэш строки — для A/B-сплита получателей. */
function hashOf(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

/**
 * Какой вариант кампании получит клиент. Только от его id: повтор прогона
 * даёт тот же вариант, и тест может спросить то же правило, а не гадать.
 */
export function abVariantOf(customerId: string): "a" | "b" {
  return hashOf(customerId) % 2 === 1 ? "b" : "a";
}

/** drizzle execute: node-postgres отдаёт {rows}, другие драйверы — массив. */
function rowsOf<T>(res: unknown): T[] {
  if (Array.isArray(res)) return res as T[];
  const r = (res as { rows?: unknown[] }).rows;
  return (r ?? []) as T[];
}

/* ── §1.1 Журнал событий ────────────────────────────────────────────────── */

export type UserEventType =
  | "view_lot" | "add_wishlist" | "place_bid" | "lost_bid" | "won_bid"
  | "abandon_checkout" | "viewed_category";

/** Пишем и забываем: аналитика не имеет права ломать боевой поток. */
export function logUserEvent(
  ctx: AppContext,
  args: { customerId: string; eventType: UserEventType; category?: string | null; listingId?: string | null },
): void {
  void ctx.db
    .insert(userEvents)
    .values({
      customerId: args.customerId,
      eventType: args.eventType,
      category: args.category ?? null,
      listingId: args.listingId ?? null,
    })
    .catch(() => undefined);
}

/* ── §1.2 Ночная сводка: интересы по категориям + RFM ───────────────────── */

export async function rebuildStats(ctx: AppContext): Promise<void> {
  const db = ctx.db;
  // Покупки: только реально оплаченные заказы.
  await db.execute(sql`
    insert into user_category_stats (customer_id, category, purchase_count, total_spent_cents, last_purchase_at, view_count, wishlist_count, lost_bid_count, updated_at)
    select o.customer_id, coalesce(i.category, 'other'),
           count(*) filter (where o.paid_at is not null),
           coalesce(sum(o.total_cents) filter (where o.paid_at is not null), 0),
           max(o.paid_at), 0, 0, 0, now()
    from orders o join items i on i.id = o.item_id
    where o.status in ('paid')
    group by o.customer_id, coalesce(i.category, 'other')
    on conflict (customer_id, category) do update set
      purchase_count = excluded.purchase_count,
      total_spent_cents = excluded.total_spent_cents,
      last_purchase_at = excluded.last_purchase_at,
      updated_at = now()
  `);
  // Поведение за 90 дней: просмотры, вишлист, проигранные торги.
  await db.execute(sql`
    insert into user_category_stats (customer_id, category, purchase_count, total_spent_cents, view_count, wishlist_count, lost_bid_count, updated_at)
    select e.customer_id, coalesce(e.category, 'other'), 0, 0,
           count(*) filter (where e.event_type = 'view_lot'),
           count(*) filter (where e.event_type = 'add_wishlist'),
           count(*) filter (where e.event_type = 'lost_bid'),
           now()
    from user_events e
    where e.created_at > now() - interval '90 days'
    group by e.customer_id, coalesce(e.category, 'other')
    on conflict (customer_id, category) do update set
      view_count = excluded.view_count,
      wishlist_count = excluded.wishlist_count,
      lost_bid_count = excluded.lost_bid_count,
      updated_at = now()
  `);
  // RFM: recency от последней оплаты, frequency и monetary за 12 месяцев,
  // оценки — квинтилями среди клиентов с покупками.
  await db.execute(sql`
    insert into user_rfm (customer_id, recency_days, frequency, monetary_cents, r_score, f_score, m_score, updated_at)
    select customer_id, recency_days, frequency, monetary_cents,
           6 - ntile(5) over (order by recency_days),
           ntile(5) over (order by frequency),
           ntile(5) over (order by monetary_cents),
           now()
    from (
      select o.customer_id,
             extract(day from now() - max(o.paid_at))::int as recency_days,
             count(*) filter (where o.paid_at > now() - interval '365 days')::int as frequency,
             coalesce(sum(o.total_cents) filter (where o.paid_at > now() - interval '365 days'), 0)::int as monetary_cents
      from orders o
      where o.status = 'paid' and o.paid_at is not null
      group by o.customer_id
    ) t
    on conflict (customer_id) do update set
      recency_days = excluded.recency_days,
      frequency = excluded.frequency,
      monetary_cents = excluded.monetary_cents,
      r_score = excluded.r_score,
      f_score = excluded.f_score,
      m_score = excluded.m_score,
      updated_at = now()
  `);
}

/* ── §2 Сегменты: правило → участники ───────────────────────────────────── */

interface RuleCondition { field: string; op: string; value: number; category?: string | undefined }
interface SegmentRule { match: "all" | "any"; conditions: RuleCondition[] }

/** Собрать участников одного сегмента по его правилу. Возвращает id клиентов. */
export async function evaluateSegment(ctx: AppContext, rule: SegmentRule): Promise<string[]> {
  // Кандидаты: все с RFM-строкой (есть покупки) плюс все со статистикой.
  const rfmRows = await ctx.db.select().from(userRfm);
  const statRows = await ctx.db.select().from(userCategoryStats);
  const byCustomer = new Map<string, { rfm?: typeof rfmRows[number]; cats: typeof statRows }>();
  for (const r of rfmRows) byCustomer.set(r.customerId, { rfm: r, cats: [] });
  for (const s of statRows) {
    const e = byCustomer.get(s.customerId) ?? { cats: [] };
    e.cats.push(s);
    byCustomer.set(s.customerId, e);
  }
  const now = ctx.now().getTime();
  const cmp = (a: number, op: string, b: number): boolean =>
    op === ">=" ? a >= b : op === "<=" ? a <= b : op === ">" ? a > b : op === "<" ? a < b : a === b;

  const passes = (c: { rfm?: typeof rfmRows[number]; cats: typeof statRows }, cond: RuleCondition): boolean => {
    const catRow = cond.category ? c.cats.find((s) => s.category === cond.category) : null;
    switch (cond.field) {
      case "category_purchase_count":
        return cmp(catRow?.purchaseCount ?? 0, cond.op, cond.value);
      case "category_total_spent":
        return cmp(catRow?.totalSpentCents ?? 0, cond.op, cond.value);
      case "purchase_count":
        return cmp(c.cats.reduce((s, r) => s + r.purchaseCount, 0), cond.op, cond.value);
      case "total_spent":
        return cmp(c.cats.reduce((s, r) => s + r.totalSpentCents, 0), cond.op, cond.value);
      case "wishlist_count":
        return cmp(
          cond.category ? (catRow?.wishlistCount ?? 0) : c.cats.reduce((s, r) => s + r.wishlistCount, 0),
          cond.op, cond.value,
        );
      case "lost_bid_count":
        return cmp(
          cond.category ? (catRow?.lostBidCount ?? 0) : c.cats.reduce((s, r) => s + r.lostBidCount, 0),
          cond.op, cond.value,
        );
      case "recency_days":
        return c.rfm?.recencyDays == null ? false : cmp(c.rfm.recencyDays, cond.op, cond.value);
      case "r_score": return c.rfm?.rScore == null ? false : cmp(c.rfm.rScore, cond.op, cond.value);
      case "f_score": return c.rfm?.fScore == null ? false : cmp(c.rfm.fScore, cond.op, cond.value);
      case "m_score": return c.rfm?.mScore == null ? false : cmp(c.rfm.mScore, cond.op, cond.value);
      case "last_purchase_within_days": {
        const last = c.cats.reduce<number>((m, r) => Math.max(m, r.lastPurchaseAt?.getTime() ?? 0), 0);
        return last > 0 && now - last <= cond.value * 86_400_000;
      }
      default:
        return false;
    }
  };

  const out: string[] = [];
  for (const [customerId, data] of byCustomer) {
    const results = rule.conditions.map((cond) => passes(data, cond));
    const ok = rule.match === "any" ? results.some(Boolean) : results.every(Boolean);
    if (ok) out.push(customerId);
  }
  return out;
}

/** Пересчитать участников всех активных сегментов (ночью, после rebuildStats). */
export async function recomputeSegments(ctx: AppContext): Promise<void> {
  const active = await ctx.db.select().from(segments).where(eq(segments.isActive, true));
  for (const seg of active) {
    const memberIds = await evaluateSegment(ctx, seg.rule as SegmentRule).catch(() => null);
    if (memberIds === null) continue;
    await ctx.db.transaction(async (tx) => {
      await tx.delete(segmentMembers).where(eq(segmentMembers.segmentId, seg.id));
      for (let i = 0; i < memberIds.length; i += 500) {
        const chunk = memberIds.slice(i, i + 500);
        if (chunk.length) {
          await tx.insert(segmentMembers).values(chunk.map((customerId) => ({ segmentId: seg.id, customerId })));
        }
      }
    });
  }
}

/* ── §1.4 Кампании: ручная рассылка на сегмент ──────────────────────────── */

export async function dispatchCampaigns(ctx: AppContext): Promise<void> {
  const due = await ctx.db
    .select()
    .from(campaigns)
    .where(and(eq(campaigns.status, "scheduled"), lte(campaigns.scheduledAt, ctx.now())));
  for (const c of due) {
    // Берём кампанию в работу атомарно — второй инстанс её не подхватит.
    const claimed = await ctx.db
      .update(campaigns)
      .set({ status: "sending" })
      .where(and(eq(campaigns.id, c.id), eq(campaigns.status, "scheduled")))
      .returning({ id: campaigns.id });
    if (claimed.length === 0) continue;

    let recipients: string[];
    if (c.segmentId) {
      const rows = await ctx.db
        .select({ customerId: segmentMembers.customerId })
        .from(segmentMembers)
        .where(eq(segmentMembers.segmentId, c.segmentId));
      recipients = rows.map((r) => r.customerId);
    } else {
      // Без сегмента — все согласившиеся на маркетинг (барьер согласия всё
      // равно проверит enqueueMarketing, это только грубая выборка).
      const rows = await ctx.db
        .select({ id: customers.id })
        .from(customers)
        .where(and(eq(customers.marketingOptIn, true), isNull(customers.erasedAt)));
      recipients = rows.map((r) => r.id);
    }

    let queued = 0;
    let skipped = 0;
    const hasB = c.contentB !== null && c.contentB !== undefined && Object.keys(c.contentB).length > 0;
    for (const customerId of recipients) {
      // A/B: детерминированный сплит по id клиента — повтор прогона даёт тот
      // же вариант, случайность не смешивает группы (MD §6.6).
      const variant: "a" | "b" = hasB ? abVariantOf(customerId) : "a";
      const content = variant === "b" ? c.contentB! : c.content;
      const res = await enqueueMarketing(ctx, ctx.db, {
        customerId,
        type: "campaign",
        template: { alias: "", lotTitle: "" },
        custom: content as Record<string, { subject: string; body: string }>,
        dedupeKey: `campaign:${c.id}:${customerId}`,
        campaignId: c.id,
        ...(hasB ? { variant } : {}),
      }).catch(() => ({ ok: false as const, skip: "duplicate" as const }));
      if (res.ok) queued += 1;
      else skipped += 1;
    }
    await ctx.db
      .update(campaigns)
      .set({ status: "sent", sentAt: ctx.now(), stats: { queued, skipped } })
      .where(eq(campaigns.id, c.id));
  }
}

/* ── Lifecycle-письма (IZ-P02…P07, P11) ─────────────────────────────────── */

/** Одноразовая отметка: письмо этого шага этому человеку уже уходило. */
async function markOnce(db: Pick<Db, "insert">, customerId: string, mark: string): Promise<boolean> {
  const rows = await db
    .insert(lifecycleMarks)
    .values({ customerId, mark })
    .onConflictDoNothing()
    .returning({ mark: lifecycleMarks.mark });
  return rows.length > 0;
}

/** Личный реферальный код (создать при необходимости) — общий для API и писем. */
export async function ensureReferralCode(ctx: AppContext, customerId: string): Promise<string> {
  const [existing] = await ctx.db.select().from(referralCodes).where(eq(referralCodes.customerId, customerId));
  if (existing) return existing.code;
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  for (let attempt = 0; attempt < 5; attempt += 1) {
    let code = "";
    for (let i = 0; i < 8; i += 1) code += alphabet[Math.floor(Math.random() * alphabet.length)];
    const [made] = await ctx.db
      .insert(referralCodes)
      .values({ customerId, code })
      .onConflictDoNothing()
      .returning({ code: referralCodes.code });
    if (made) return made.code;
  }
  const [raced] = await ctx.db.select().from(referralCodes).where(eq(referralCodes.customerId, customerId));
  return raced!.code;
}

/** Топ-категория клиента по сводке; null, если истории нет. */
async function topCategoryOf(ctx: AppContext, customerId: string): Promise<string | null> {
  const rows = await ctx.db
    .select()
    .from(userCategoryStats)
    .where(eq(userCategoryStats.customerId, customerId))
    .orderBy(desc(userCategoryStats.purchaseCount), desc(userCategoryStats.totalSpentCents))
    .limit(1);
  const top = rows[0];
  if (!top || (top.purchaseCount === 0 && top.viewCount === 0)) return null;
  return top.category === "other" ? null : top.category;
}

/** Живые лоты категории (или просто свежие) для письма-подборки. */
async function lotsFor(ctx: AppContext, category: string | null, limit = 3): Promise<Array<{ title: string; priceCents: number }>> {
  const rows = await ctx.db
    .select({ title: listings.title, priceCents: listings.priceCents, category: items.category })
    .from(listings)
    .innerJoin(items, eq(listings.itemId, items.id))
    .where(and(eq(listings.status, "published"), category ? eq(items.category, category) : undefined))
    .orderBy(desc(listings.updatedAt))
    .limit(limit);
  return rows
    .filter((r) => r.priceCents !== null)
    .map((r) => ({ title: r.title, priceCents: r.priceCents! }));
}

/** IZ-P02: welcome-код не использован N дней после подтверждения почты. */
export async function runWelcomeReminders(ctx: AppContext): Promise<void> {
  const s = await getSettings(ctx);
  const from = new Date(ctx.now().getTime() - (s.welcome_reminder_day + 4) * 86_400_000);
  const to = new Date(ctx.now().getTime() - s.welcome_reminder_day * 86_400_000);
  const rows = await ctx.db.execute(sql`
    select c.id as customer_id, p.code, p.value, p.valid_to
    from customers c
    join promo_codes p on p.customer_id = c.id and p.source in ('welcome_auto','referral_referred')
      and p.used_count = 0 and p.is_active and p.valid_to > now()
    where c.email_verified_at between ${from} and ${to} and c.erased_at is null
    limit 200
  `);
  for (const r of rowsOf<{ customer_id: string; code: string; value: number; valid_to: Date }>(rows)) {
    if (!(await markOnce(ctx.db, r.customer_id, "welcome_d3"))) continue;
    await enqueueMarketing(ctx, ctx.db, {
      customerId: r.customer_id,
      type: "welcome_reminder",
      template: {
        alias: "", lotTitle: "",
        promoCode: r.code, promoPercent: r.value, promoDeadline: new Date(r.valid_to),
      },
      dedupeKey: `welcome_d3:${r.customer_id}`,
    }).catch(() => undefined);
  }
}

/** IZ-P03: N дней тишины после покупки — подборка в любимой категории. */
export async function runInactiveNudges(ctx: AppContext): Promise<void> {
  const s = await getSettings(ctx);
  const from = new Date(ctx.now().getTime() - (s.inactive_nudge_days + 7) * 86_400_000);
  const to = new Date(ctx.now().getTime() - s.inactive_nudge_days * 86_400_000);
  const rows = await ctx.db.execute(sql`
    select o.customer_id, max(o.paid_at) as last_paid, max(o.ref) as last_ref
    from orders o
    where o.status = 'paid'
    group by o.customer_id
    having max(o.paid_at) between ${from} and ${to}
    limit 200
  `);
  for (const r of rowsOf<{ customer_id: string; last_ref: string }>(rows)) {
    if (!(await markOnce(ctx.db, r.customer_id, `inactive_d14:${r.last_ref}`))) continue;
    const category = await topCategoryOf(ctx, r.customer_id);
    const lots = await lotsFor(ctx, category);
    if (lots.length === 0) continue;
    await enqueueMarketing(ctx, ctx.db, {
      customerId: r.customer_id,
      type: "inactive_nudge",
      template: { alias: "", lotTitle: "", lots, categoryLabel: category ?? undefined },
      dedupeKey: `inactive_d14:${r.customer_id}:${r.last_ref}`,
    }).catch(() => undefined);
  }
}

/** IZ-P11 (MD §1.6.2): win-back спящим — личный код, категория-таргет,
 *  проценты по ценности клиента, повторяемый цикл на каждый новый «сон». */
export async function runWinback(ctx: AppContext): Promise<void> {
  const s = await getSettings(ctx);
  const from = new Date(ctx.now().getTime() - (s.winback_days + 7) * 86_400_000);
  const to = new Date(ctx.now().getTime() - s.winback_days * 86_400_000);
  const rows = await ctx.db.execute(sql`
    select o.customer_id, max(o.paid_at) as last_paid, max(o.ref) as last_ref
    from orders o
    where o.status = 'paid'
    group by o.customer_id
    having max(o.paid_at) between ${from} and ${to}
    limit 200
  `);
  for (const r of rowsOf<{ customer_id: string; last_ref: string }>(rows)) {
    if (!(await markOnce(ctx.db, r.customer_id, `winback:${r.last_ref}`))) continue;
    // Топ-20% по тратам заслуживают большего: вернуть проверенного клиента
    // дешевле, чем привести нового (MD §1.6.2).
    const [rfm] = await ctx.db.select().from(userRfm).where(eq(userRfm.customerId, r.customer_id));
    const highValue = (rfm?.mScore ?? 0) >= 5;
    const percent = highValue ? s.winback_percent_high : s.winback_percent;
    const category = await topCategoryOf(ctx, r.customer_id);
    const code = await issuePersonalCode(ctx.db, {
      customerId: r.customer_id,
      source: "winback",
      prefix: "ATPAKAL",
      percent,
      validFrom: ctx.now(),
      validTo: new Date(ctx.now().getTime() + s.winback_valid_days * 86_400_000),
      category,
    }).catch(() => null);
    if (!code) continue;
    await enqueueMarketing(ctx, ctx.db, {
      customerId: r.customer_id,
      type: "winback_offer",
      template: {
        alias: "", lotTitle: "",
        promoCode: code.code, promoPercent: percent, promoDeadline: code.validTo ?? undefined,
        categoryLabel: category ?? undefined,
      },
      dedupeKey: `winback:${r.customer_id}:${r.last_ref}`,
    }).catch(() => undefined);
  }
}

/** IZ-P07 (MD §7.8): запрос отзыва N дней после выдачи/доставки. */
export async function runReviewRequests(ctx: AppContext): Promise<void> {
  const s = await getSettings(ctx);
  const before = new Date(ctx.now().getTime() - s.review_request_days * 86_400_000);
  const floor = new Date(ctx.now().getTime() - (s.review_request_days + 14) * 86_400_000);
  const rows = await ctx.db
    .select({ order: orders, itemTitle: items.title })
    .from(orders)
    .innerJoin(items, eq(orders.itemId, items.id))
    .where(and(
      eq(orders.status, "paid"),
      inArray(items.status, ["delivered", "closed"]),
      lte(items.updatedAt, before),
      gte(items.updatedAt, floor),
    ))
    .limit(200);
  for (const r of rows) {
    if (!(await markOnce(ctx.db, r.order.customerId, `review:${r.order.ref}`))) continue;
    await enqueueMarketing(ctx, ctx.db, {
      customerId: r.order.customerId,
      type: "review_request",
      template: {
        alias: "", lotTitle: r.itemTitle, orderRef: r.order.ref,
        actionUrl: ctx.config.emailBrand.reviewUrl || ctx.config.storefrontBaseUrl,
      },
      dedupeKey: `review:${r.order.ref}`,
    }).catch(() => undefined);
  }
}

/** IZ-P04 (MD §7.3): после 2-й оплаченной покупки — приглашение в рефералку. */
export async function runReferralInvites(ctx: AppContext): Promise<void> {
  const s = await getSettings(ctx);
  const rows = await ctx.db.execute(sql`
    select customer_id from orders
    where status = 'paid'
    group by customer_id
    having count(*) >= 2
    limit 500
  `);
  for (const r of rowsOf<{ customer_id: string }>(rows)) {
    if (!(await markOnce(ctx.db, r.customer_id, "referral_invite"))) continue;
    const code = await ensureReferralCode(ctx, r.customer_id).catch(() => null);
    if (!code) continue;
    await enqueueMarketing(ctx, ctx.db, {
      customerId: r.customer_id,
      type: "referral_invite",
      template: {
        alias: "", lotTitle: "",
        referralUrl: `${ctx.config.storefrontBaseUrl}/register?ref=${code}`,
        referralSignupCents: s.referral_signup_points_cents,
        referralOrderCents: s.referral_order_points_cents,
        referralPercent: s.referral_percent,
      },
      dedupeKey: `referral_invite:${r.customer_id}`,
    }).catch(() => undefined);
  }
}

/** IZ-P05 (MD §7.2): проигравшему — похожие живые лоты той же категории и
 *  ценового диапазона. Зовётся из закрытия аукциона, без ожидания. */
export async function sendLostBidSimilar(
  ctx: AppContext,
  args: { auctionId: string; lotTitle: string; category: string | null; priceCents: number; loserIds: string[] },
): Promise<void> {
  if (args.loserIds.length === 0) return;
  const rows = await ctx.db
    .select({ title: listings.title, priceCents: listings.priceCents, category: items.category, type: listings.type })
    .from(listings)
    .innerJoin(items, eq(listings.itemId, items.id))
    .where(and(
      eq(listings.status, "published"),
      args.category ? eq(items.category, args.category) : undefined,
    ))
    .orderBy(desc(listings.updatedAt))
    .limit(20);
  const band = rows
    .filter((r) => r.priceCents !== null)
    .filter((r) => r.priceCents! >= args.priceCents * 0.5 && r.priceCents! <= args.priceCents * 1.6)
    .slice(0, 5)
    .map((r) => ({ title: r.title, priceCents: r.priceCents! }));
  if (band.length === 0) return;
  for (const customerId of args.loserIds) {
    await enqueueMarketing(ctx, ctx.db, {
      customerId,
      type: "lost_bid_similar",
      template: { alias: "", lotTitle: args.lotTitle, lots: band },
      dedupeKey: `lost:${args.auctionId}:${customerId}`,
    }).catch(() => undefined);
  }
}

/** §6.1: смотрел лот, ставку не сделал, торги в последних часах — nudge.
 *  Гоняется вместе с кампаниями (раз в несколько минут), не ночью: окно
 *  «заканчивается через N часов» ночного прогона не переживёт. */
export async function runAbandonedBidNudges(ctx: AppContext): Promise<void> {
  const s = await getSettings(ctx);
  const viewedAfter = new Date(ctx.now().getTime() - s.abandoned_view_days * 86_400_000);
  const endsBefore = new Date(ctx.now().getTime() + s.abandoned_bid_hours * 3_600_000);
  const rows = await ctx.db.execute(sql`
    select distinct e.customer_id, a.id as auction_id, l.title,
           coalesce(a.current_price_cents, l.price_cents) as price_cents
    from user_events e
    join listings l on l.id = e.listing_id
    join auctions a on a.listing_id = l.id and a.status = 'running'
    where e.event_type = 'view_lot'
      and e.created_at > ${viewedAfter}
      and a.ends_at <= ${endsBefore} and a.ends_at > now()
      and not exists (
        select 1 from bids b where b.auction_id = a.id and b.customer_id = e.customer_id
      )
    limit 200
  `);
  for (const r of rowsOf<{ customer_id: string; auction_id: string; title: string; price_cents: number | null }>(rows)) {
    if (!(await markOnce(ctx.db, r.customer_id, `abandoned:${r.auction_id}`))) continue;
    await enqueueMarketing(ctx, ctx.db, {
      customerId: r.customer_id,
      type: "abandoned_bid",
      template: {
        alias: "", lotTitle: r.title,
        amountCents: r.price_cents ?? undefined,
        actionUrl: `${ctx.config.storefrontBaseUrl}/auction/${r.auction_id}`,
      },
      dedupeKey: `abandoned:${r.auction_id}:${r.customer_id}`,
    }).catch(() => undefined);
  }
}

/** §6.2: N дней после ПЕРВОЙ покупки, второй так и нет — авто-письмо с
 *  подборкой по любимой категории и напоминанием о баллах. */
export async function runSecondPurchaseNudges(ctx: AppContext): Promise<void> {
  const s = await getSettings(ctx);
  const from = new Date(ctx.now().getTime() - (s.second_purchase_days + 7) * 86_400_000);
  const to = new Date(ctx.now().getTime() - s.second_purchase_days * 86_400_000);
  const rows = await ctx.db.execute(sql`
    select customer_id, max(paid_at) as first_paid
    from orders
    where status = 'paid'
    group by customer_id
    having count(*) = 1 and max(paid_at) between ${from} and ${to}
    limit 200
  `);
  for (const r of rowsOf<{ customer_id: string }>(rows)) {
    if (!(await markOnce(ctx.db, r.customer_id, "second_purchase"))) continue;
    const category = await topCategoryOf(ctx, r.customer_id);
    const lots = await lotsFor(ctx, category);
    if (lots.length === 0) continue;
    const [acct] = await ctx.db.select().from(loyaltyAccounts).where(eq(loyaltyAccounts.customerId, r.customer_id));
    await enqueueMarketing(ctx, ctx.db, {
      customerId: r.customer_id,
      type: "second_purchase",
      template: {
        alias: "", lotTitle: "", lots,
        categoryLabel: category ?? undefined,
        pointsBalanceCents: acct?.balanceCents ?? 0,
      },
      dedupeKey: `second_purchase:${r.customer_id}`,
    }).catch(() => undefined);
  }
}

/** Ночной пакет: сводка → RFM → сегменты → lifecycle-письма. */
export async function runNightlyGrowth(ctx: AppContext): Promise<void> {
  await rebuildStats(ctx).catch((err) => console.error("rebuildStats failed", err));
  await recomputeSegments(ctx).catch((err) => console.error("recomputeSegments failed", err));
  await runWelcomeReminders(ctx).catch((err) => console.error("welcome reminders failed", err));
  await runInactiveNudges(ctx).catch((err) => console.error("inactive nudges failed", err));
  await runWinback(ctx).catch((err) => console.error("winback failed", err));
  await runReviewRequests(ctx).catch((err) => console.error("review requests failed", err));
  await runReferralInvites(ctx).catch((err) => console.error("referral invites failed", err));
  await runSecondPurchaseNudges(ctx).catch((err) => console.error("second purchase nudges failed", err));
  await rebuildCoPurchases(ctx).catch((err) => console.error("co-purchase rebuild failed", err));
}

/* ── §6.9: co-occurrence «покупавшие из X берут и Y» ─────────────────────── */

/**
 * Категорийные пары совместных покупок, пересчитываются ночью в Redis:
 * co:cats = {"tools|electronics": 12, …}. Витрина берёт для клиента вторую
 * рекомендованную категорию — без ML, чистый подсчёт пар (MD §6.9).
 */
export async function rebuildCoPurchases(ctx: AppContext): Promise<void> {
  const rows = await ctx.db.execute(sql`
    select a.category as cat_a, b.category as cat_b, count(*) as n
    from (select distinct o.customer_id, i.category
          from orders o join items i on i.id = o.item_id
          where o.status = 'paid') a
    join (select distinct o.customer_id, i.category
          from orders o join items i on i.id = o.item_id
          where o.status = 'paid') b
      on a.customer_id = b.customer_id and a.category < b.category
    group by a.category, b.category
    order by n desc
    limit 200
  `);
  const pairs: Record<string, number> = {};
  for (const r of rowsOf<{ cat_a: string; cat_b: string; n: string | number }>(rows)) {
    pairs[`${r.cat_a}|${r.cat_b}`] = Number(r.n);
  }
  try { await ctx.redis.set("growth:co-cats", JSON.stringify(pairs)); } catch { /* кэш — удобство */ }
}

/** Категория-компаньон к данной по co-occurrence (или null). */
export async function companionCategory(ctx: AppContext, category: string): Promise<string | null> {
  try {
    const raw = await ctx.redis.get("growth:co-cats");
    if (!raw) return null;
    const pairs = JSON.parse(raw) as Record<string, number>;
    let best: string | null = null;
    let bestN = 1; // одна общая покупка — ещё не сигнал
    for (const [key, n] of Object.entries(pairs)) {
      const [a, b] = key.split("|");
      if (a !== category && b !== category) continue;
      if (n > bestN) { bestN = n; best = a === category ? b! : a!; }
    }
    return best;
  } catch { return null; }
}
