import {
  affiliates,
  campaigns,
  customers,
  giftCards,
  loyaltyAccounts,
  loyaltyLedger,
  notifications,
  orders,
  promoCodes,
  promoRedemptions,
  referrals,
  segmentMembers,
  segments,
  userEvents,
  userRfm,
} from "@auction/db";
import { and, desc, eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { writeAudit } from "../audit.js";
import { requirePermission, type PermissionService } from "../auth/rbac.js";
import type { AppContext } from "../context.js";
import { evaluateSegment, recomputeSegments, runNightlyGrowth } from "../engine/growth.js";
import { issueGiftCard } from "../engine/giftCards.js";
import { movePoints, tierFor } from "../engine/loyalty.js";
import { getSettings } from "../engine/settings.js";

/**
 * Админ-раздел «Marketing» (план v15, MD §3): сегменты с конструктором
 * правил, кампании, промокоды, баллы, рефералы с антифрод-проверкой.
 * Права — content.view / content.edit: этим занимаются те же люди, что
 * ведут тексты, отдельной роли план не требует.
 */

const actor = (req: { admin?: { sub: string; name: string } }) => ({
  id: req.admin?.sub ?? null,
  label: req.admin?.name ?? "Unknown",
});

const ruleSchema = z.object({
  match: z.enum(["all", "any"]),
  conditions: z
    .array(z.object({
      field: z.enum([
        "category_purchase_count", "category_total_spent", "purchase_count", "total_spent",
        "wishlist_count", "lost_bid_count", "recency_days", "r_score", "f_score", "m_score",
        "last_purchase_within_days",
      ]),
      op: z.enum([">=", "<=", ">", "<", "=="]),
      value: z.number().min(0).max(100_000_000),
      category: z.string().max(60).optional(),
    }))
    .min(1)
    .max(10),
});

const contentSchema = z.record(
  z.enum(["lv", "ru", "en"]),
  z.object({ subject: z.string().min(2).max(200), body: z.string().min(2).max(10_000) }),
);

export function registerMarketingAdminRoutes(app: FastifyInstance, ctx: AppContext, perms: PermissionService): void {
  const guard = (p: Parameters<typeof requirePermission>[1]) => ({ preHandler: requirePermission(perms, p) });

  // ── Сегменты ──────────────────────────────────────────────────────────────

  app.get("/api/marketing/segments", guard("content.view"), async () => {
    const rows = await ctx.db.select().from(segments).orderBy(desc(segments.createdAt));
    const counts = await ctx.db
      .select({ segmentId: segmentMembers.segmentId, n: sql<string>`count(*)` })
      .from(segmentMembers)
      .groupBy(segmentMembers.segmentId);
    const byId = new Map(counts.map((c) => [c.segmentId, Number(c.n)]));
    return { segments: rows.map((s) => ({ ...s, memberCount: byId.get(s.id) ?? 0 })) };
  });

  app.post("/api/marketing/segments", guard("content.edit"), async (req, reply) => {
    const body = z.object({ name: z.string().min(2).max(120), rule: ruleSchema, isActive: z.boolean().default(true) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body", detail: body.error.flatten() });
    const [row] = await ctx.db
      .insert(segments)
      .values({ ...body.data, createdBy: req.admin!.sub })
      .returning();
    await writeAudit(ctx.db, actor(req), "content", "segment_created", body.data.name);
    return { segment: row };
  });

  app.patch("/api/marketing/segments/:id", guard("content.edit"), async (req, reply) => {
    const body = z.object({ name: z.string().min(2).max(120).optional(), rule: ruleSchema.optional(), isActive: z.boolean().optional() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body" });
    const { id } = req.params as { id: string };
    const [row] = await ctx.db.update(segments).set(body.data).where(eq(segments.id, id)).returning();
    if (!row) return reply.code(404).send({ error: "not_found" });
    await writeAudit(ctx.db, actor(req), "content", "segment_updated", row.name);
    return { segment: row };
  });

  app.delete("/api/marketing/segments/:id", guard("content.edit"), async (req, reply) => {
    const { id } = req.params as { id: string };
    const [row] = await ctx.db.delete(segments).where(eq(segments.id, id)).returning();
    if (!row) return reply.code(404).send({ error: "not_found" });
    await writeAudit(ctx.db, actor(req), "content", "segment_deleted", row.name);
    return { ok: true };
  });

  /** Живой предпросмотр правила: сколько людей попадает и первые двадцать. */
  app.post("/api/marketing/segments/preview", guard("content.view"), async (req, reply) => {
    const body = z.object({ rule: ruleSchema }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body" });
    const ids = await evaluateSegment(ctx, body.data.rule);
    const sample = ids.slice(0, 20);
    const people = sample.length
      ? await ctx.db
          .select({ id: customers.id, alias: customers.alias, email: customers.email })
          .from(customers)
          .where(sql`${customers.id} in ${sample}`)
      : [];
    return { count: ids.length, sample: people };
  });

  /** Пересчитать сегменты сейчас, не дожидаясь ночи. */
  app.post("/api/marketing/segments/recompute", guard("content.edit"), async () => {
    await recomputeSegments(ctx);
    return { ok: true };
  });

  /** Ручной запуск ночного пакета (сводка+RFM+lifecycle) — для отладки. */
  app.post("/api/marketing/run-nightly", guard("content.edit"), async () => {
    await runNightlyGrowth(ctx);
    return { ok: true };
  });

  // ── Кампании ──────────────────────────────────────────────────────────────

  app.get("/api/marketing/campaigns", guard("content.view"), async () => {
    const rows = await ctx.db.select().from(campaigns).orderBy(desc(campaigns.createdAt));
    // Открытия/клики из журнала писем — по кампании и A/B-варианту.
    const track = await ctx.db
      .select({
        campaignId: notifications.campaignId,
        variant: notifications.variant,
        sent: sql<string>`count(*) filter (where ${notifications.status} = 'sent')`,
        opened: sql<string>`count(*) filter (where ${notifications.openedAt} is not null)`,
        clicked: sql<string>`count(*) filter (where ${notifications.clickedAt} is not null)`,
      })
      .from(notifications)
      .where(sql`${notifications.campaignId} is not null`)
      .groupBy(notifications.campaignId, notifications.variant);
    const byCampaign = new Map<string, Array<{ variant: string | null; sent: number; opened: number; clicked: number }>>();
    for (const t of track) {
      if (!t.campaignId) continue;
      const list = byCampaign.get(t.campaignId) ?? [];
      list.push({ variant: t.variant, sent: Number(t.sent), opened: Number(t.opened), clicked: Number(t.clicked) });
      byCampaign.set(t.campaignId, list);
    }
    return { campaigns: rows.map((r) => ({ ...r, tracking: byCampaign.get(r.id) ?? [] })) };
  });

  app.post("/api/marketing/campaigns", guard("content.edit"), async (req, reply) => {
    const body = z
      .object({
        name: z.string().min(2).max(160),
        segmentId: z.string().uuid().nullable().optional(),
        content: contentSchema,
        /** Вариант B (A/B-тест): пустой объект или null = теста нет. */
        contentB: contentSchema.nullable().optional(),
      })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body", detail: body.error.flatten() });
    if (Object.keys(body.data.content).length === 0) return reply.code(400).send({ error: "content_empty" });
    const contentB = body.data.contentB && Object.keys(body.data.contentB).length > 0 ? body.data.contentB : null;
    const [row] = await ctx.db
      .insert(campaigns)
      .values({ name: body.data.name, segmentId: body.data.segmentId ?? null, content: body.data.content, contentB })
      .returning();
    await writeAudit(ctx.db, actor(req), "content", "campaign_created", body.data.name);
    return { campaign: row };
  });

  app.patch("/api/marketing/campaigns/:id", guard("content.edit"), async (req, reply) => {
    const body = z
      .object({
        name: z.string().min(2).max(160).optional(),
        segmentId: z.string().uuid().nullable().optional(),
        content: contentSchema.optional(),
        contentB: contentSchema.nullable().optional(),
        /** schedule: назначить время; unschedule: вернуть в черновики;
         *  archive: убрать с глаз. Отправленную кампанию не редактируют. */
        action: z.enum(["schedule", "unschedule", "archive"]).optional(),
        scheduledAt: z.coerce.date().optional(),
      })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body" });
    const { id } = req.params as { id: string };
    const [existing] = await ctx.db.select().from(campaigns).where(eq(campaigns.id, id));
    if (!existing) return reply.code(404).send({ error: "not_found" });
    if (existing.status === "sent" || existing.status === "sending") {
      return reply.code(409).send({ error: "already_sent" });
    }
    const set: Record<string, unknown> = {};
    if (body.data.name !== undefined) set.name = body.data.name;
    if (body.data.segmentId !== undefined) set.segmentId = body.data.segmentId;
    if (body.data.content !== undefined) set.content = body.data.content;
    if (body.data.contentB !== undefined) {
      set.contentB = body.data.contentB && Object.keys(body.data.contentB).length > 0 ? body.data.contentB : null;
    }
    if (body.data.action === "schedule") {
      if (!body.data.scheduledAt) return reply.code(400).send({ error: "scheduled_at_required" });
      set.status = "scheduled";
      set.scheduledAt = body.data.scheduledAt;
    } else if (body.data.action === "unschedule") {
      set.status = "draft";
      set.scheduledAt = null;
    } else if (body.data.action === "archive") {
      set.status = "archived";
    }
    const [row] = await ctx.db.update(campaigns).set(set).where(eq(campaigns.id, id)).returning();
    await writeAudit(ctx.db, actor(req), "content", "campaign_updated", row!.name, { action: body.data.action ?? "edit" });
    return { campaign: row };
  });

  // ── Промокоды ─────────────────────────────────────────────────────────────

  app.get("/api/marketing/promo-codes", guard("content.view"), async () => {
    const rows = await ctx.db.select().from(promoCodes).orderBy(desc(promoCodes.createdAt)).limit(500);
    const usage = await ctx.db
      .select({ promoId: promoRedemptions.promoId, n: sql<string>`count(*)`, cents: sql<string>`coalesce(sum(${promoRedemptions.discountCents}),0)` })
      .from(promoRedemptions)
      .groupBy(promoRedemptions.promoId);
    const byId = new Map(usage.map((u) => [u.promoId, { redemptions: Number(u.n), discountCents: Number(u.cents) }]));
    return { codes: rows.map((r) => ({ ...r, usage: byId.get(r.id) ?? { redemptions: 0, discountCents: 0 } })) };
  });

  app.post("/api/marketing/promo-codes", guard("content.edit"), async (req, reply) => {
    const body = z
      .object({
        code: z.string().min(3).max(40).regex(/^[A-Z0-9-]+$/, "uppercase letters, digits, dashes"),
        type: z.enum(["percent", "fixed", "free_shipping"]),
        /** free_shipping ценности не несёт — value игнорируется (0). */
        value: z.number().int().min(0).max(1_000_000).default(0),
        minOrderCents: z.number().int().min(0).nullable().optional(),
        category: z.string().max(60).nullable().optional(),
        segmentId: z.string().uuid().nullable().optional(),
        usageLimitTotal: z.number().int().min(1).nullable().optional(),
        usageLimitPerUser: z.number().int().min(1).nullable().optional(),
        validFrom: z.coerce.date().nullable().optional(),
        validTo: z.coerce.date().nullable().optional(),
      })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body", detail: body.error.flatten() });
    if (body.data.type === "percent" && body.data.value > 100) return reply.code(400).send({ error: "percent_over_100" });
    if (body.data.type !== "free_shipping" && body.data.value < 1) return reply.code(400).send({ error: "value_required" });
    const [row] = await ctx.db
      .insert(promoCodes)
      .values({ ...body.data, value: body.data.type === "free_shipping" ? 0 : body.data.value, source: "manual" })
      .onConflictDoNothing()
      .returning();
    if (!row) return reply.code(409).send({ error: "code_exists" });
    await writeAudit(ctx.db, actor(req), "content", "promo_created", row.code);
    return { promo: row };
  });

  app.patch("/api/marketing/promo-codes/:id", guard("content.edit"), async (req, reply) => {
    const body = z
      .object({
        isActive: z.boolean().optional(),
        validTo: z.coerce.date().nullable().optional(),
        usageLimitTotal: z.number().int().min(1).nullable().optional(),
      })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body" });
    const { id } = req.params as { id: string };
    const [row] = await ctx.db.update(promoCodes).set(body.data).where(eq(promoCodes.id, id)).returning();
    if (!row) return reply.code(404).send({ error: "not_found" });
    await writeAudit(ctx.db, actor(req), "content", "promo_updated", row.code);
    return { promo: row };
  });

  // ── Баллы лояльности ──────────────────────────────────────────────────────

  app.get("/api/marketing/loyalty/:customerId", guard("content.view"), async (req, reply) => {
    const { customerId } = req.params as { customerId: string };
    const [account] = await ctx.db.select().from(loyaltyAccounts).where(eq(loyaltyAccounts.customerId, customerId));
    if (!account) return { balanceCents: 0, ledger: [] };
    const ledger = await ctx.db
      .select()
      .from(loyaltyLedger)
      .where(eq(loyaltyLedger.accountId, account.id))
      .orderBy(desc(loyaltyLedger.createdAt))
      .limit(100);
    return { balanceCents: account.balanceCents, ledger };
  });

  /** Ручная корректировка: плюс или минус, с обязательной запиской. */
  app.post("/api/marketing/loyalty/:customerId/adjust", guard("content.edit"), async (req, reply) => {
    const body = z
      .object({ amountCents: z.number().int().min(-1_000_000).max(1_000_000), note: z.string().min(3).max(300) })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body" });
    if (body.data.amountCents === 0) return reply.code(400).send({ error: "zero_amount" });
    const { customerId } = req.params as { customerId: string };
    try {
      const result = await ctx.db.transaction((tx) =>
        movePoints(tx, customerId, { reason: "manual", amountCents: body.data.amountCents, note: body.data.note }, ctx.now()),
      );
      await writeAudit(ctx.db, actor(req), "customer", "loyalty_adjusted", customerId, { amountCents: body.data.amountCents, note: body.data.note });
      return { balanceCents: result.balanceCents };
    } catch {
      return reply.code(409).send({ error: "insufficient_points" });
    }
  });

  // ── Рефералы: список и разбор fraud-флагов ────────────────────────────────

  app.get("/api/marketing/referrals", guard("content.view"), async () => {
    const rows = await ctx.db
      .select({
        referral: referrals,
        referrerAlias: sql<string>`(select alias from customers where id = ${referrals.referrerCustomerId})`,
        referredAlias: sql<string>`(select alias from customers where id = ${referrals.referredCustomerId})`,
      })
      .from(referrals)
      .orderBy(desc(referrals.fraudFlag), desc(referrals.createdAt))
      .limit(500);
    return { referrals: rows.map((r) => ({ ...r.referral, referrerAlias: r.referrerAlias, referredAlias: r.referredAlias })) };
  });

  /** Одобрить придержанный реферал: снять флаг и доплатить заработанное —
   *  ступень 1, если почта приглашённого подтверждена, и ступень 2, если у
   *  него уже есть оплаченный заказ. */
  app.post("/api/marketing/referrals/:id/approve", guard("content.edit"), async (req, reply) => {
    const { id } = req.params as { id: string };
    const done = await ctx.db.transaction(async (tx) => {
      const [r] = await tx.select().from(referrals).where(eq(referrals.id, id)).for("update");
      if (!r) return null;
      const s = await getSettings(ctx);
      let status = r.status;
      if (status === "pending") {
        const [referred] = await tx
          .select({ verifiedAt: customers.emailVerifiedAt })
          .from(customers)
          .where(eq(customers.id, r.referredCustomerId));
        if (referred?.verifiedAt) {
          if (s.referral_signup_points_cents > 0) {
            await movePoints(tx, r.referrerCustomerId, {
              reason: "referral_signup", amountCents: s.referral_signup_points_cents, referralId: r.id,
            }, ctx.now());
          }
          status = "signup_rewarded";
        }
      }
      if (status === "signup_rewarded") {
        const paidRes = await tx.execute(sql`
          select ref from orders where customer_id = ${r.referredCustomerId} and status = 'paid' limit 1
        `);
        const paid = (Array.isArray(paidRes) ? paidRes : ((paidRes as { rows?: unknown[] }).rows ?? []))[0] as { ref: string } | undefined;
        if (paid) {
          if (s.referral_order_points_cents > 0) {
            await movePoints(tx, r.referrerCustomerId, {
              reason: "referral_order", amountCents: s.referral_order_points_cents, referralId: r.id, orderRef: paid.ref,
            }, ctx.now());
          }
          status = "order_rewarded";
        }
      }
      await tx
        .update(referrals)
        .set({
          fraudFlag: false,
          status,
          ...(status !== "pending" && !r.signupRewardedAt ? { signupRewardedAt: ctx.now() } : {}),
          ...(status === "order_rewarded" && !r.orderRewardedAt ? { orderRewardedAt: ctx.now() } : {}),
        })
        .where(eq(referrals.id, id));
      return status;
    });
    if (done === null) return reply.code(404).send({ error: "not_found" });
    await writeAudit(ctx.db, actor(req), "customer", "referral_approved", id, { status: done });
    return { ok: true, status: done };
  });

  /** Отклонить: связка остаётся с флагом, наград не будет никогда. */
  app.post("/api/marketing/referrals/:id/reject", guard("content.edit"), async (req, reply) => {
    const { id } = req.params as { id: string };
    const [row] = await ctx.db
      .update(referrals)
      .set({ fraudFlag: true })
      .where(and(eq(referrals.id, id), eq(referrals.status, "pending")))
      .returning();
    if (!row) return reply.code(404).send({ error: "not_found_or_already_rewarded" });
    await writeAudit(ctx.db, actor(req), "customer", "referral_rejected", id);
    return { ok: true };
  });

  // ── RFM клиента (для карточки Customer 360-lite) ──────────────────────────

  app.get("/api/marketing/rfm/:customerId", guard("content.view"), async (req) => {
    const { customerId } = req.params as { customerId: string };
    const [row] = await ctx.db.select().from(userRfm).where(eq(userRfm.customerId, customerId));
    return { rfm: row ?? null };
  });

  // ── Подарочные карты (MD §3) ──────────────────────────────────────────────

  app.get("/api/marketing/gift-cards", guard("content.view"), async () => {
    const rows = await ctx.db.select().from(giftCards).orderBy(desc(giftCards.createdAt)).limit(500);
    return { cards: rows };
  });

  app.post("/api/marketing/gift-cards", guard("content.edit"), async (req, reply) => {
    const body = z
      .object({
        initialCents: z.number().int().min(100).max(1_000_000),
        note: z.string().max(300).optional(),
      })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body" });
    const card = await issueGiftCard(ctx, {
      initialCents: body.data.initialCents,
      ...(body.data.note ? { note: body.data.note } : {}),
      issuedBy: req.admin!.name,
    });
    await writeAudit(ctx.db, actor(req), "content", "gift_card_issued", card.code, { initialCents: card.initialCents });
    return { card };
  });

  app.patch("/api/marketing/gift-cards/:id", guard("content.edit"), async (req, reply) => {
    const body = z.object({ isActive: z.boolean() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body" });
    const { id } = req.params as { id: string };
    const [row] = await ctx.db.update(giftCards).set({ isActive: body.data.isActive }).where(eq(giftCards.id, id)).returning();
    if (!row) return reply.code(404).send({ error: "not_found" });
    await writeAudit(ctx.db, actor(req), "content", "gift_card_toggled", row.code, { isActive: row.isActive });
    return { card: row };
  });

  // ── Партнёры (affiliate, MD §6.7) ────────────────────────────────────────

  app.get("/api/marketing/affiliates", guard("content.view"), async () => {
    const rows = await ctx.db.select().from(affiliates).orderBy(desc(affiliates.createdAt));
    // Регистрации и оплаченная товарная часть привлечённых — комиссия
    // считается от неё (без доставки и упаковки: партнёр привёл покупателя,
    // а не перевозчика).
    const stats = await ctx.db
      .select({
        affiliateId: customers.affiliateId,
        signups: sql<string>`count(distinct ${customers.id})`,
        paidOrders: sql<string>`count(${orders.id}) filter (where ${orders.status} = 'paid')`,
        goodsCents: sql<string>`coalesce(sum(${orders.totalCents} - ${orders.shippingCents} - ${orders.handlingCents} - ${orders.insuranceCents}) filter (where ${orders.status} = 'paid'), 0)`,
      })
      .from(customers)
      .leftJoin(orders, eq(orders.customerId, customers.id))
      .where(sql`${customers.affiliateId} is not null`)
      .groupBy(customers.affiliateId);
    const byId = new Map(stats.map((s) => [s.affiliateId, s]));
    return {
      affiliates: rows.map((a) => {
        const s = byId.get(a.id);
        const goodsCents = Number(s?.goodsCents ?? 0);
        return {
          ...a,
          stats: {
            signups: Number(s?.signups ?? 0),
            paidOrders: Number(s?.paidOrders ?? 0),
            goodsCents,
            commissionCents: Math.floor((goodsCents * a.commissionBp) / 10_000),
          },
        };
      }),
    };
  });

  app.post("/api/marketing/affiliates", guard("content.edit"), async (req, reply) => {
    const body = z
      .object({
        name: z.string().min(2).max(160),
        code: z.string().min(3).max(24).regex(/^[A-Z0-9-]+$/i),
        contact: z.string().max(200).optional(),
        commissionBp: z.number().int().min(0).max(5_000).default(500),
      })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body", detail: body.error.flatten() });
    const [row] = await ctx.db
      .insert(affiliates)
      .values({
        name: body.data.name,
        code: body.data.code.toUpperCase(),
        contact: body.data.contact ?? null,
        commissionBp: body.data.commissionBp,
      })
      .onConflictDoNothing()
      .returning();
    if (!row) return reply.code(409).send({ error: "code_exists" });
    await writeAudit(ctx.db, actor(req), "content", "affiliate_created", row.code);
    return { affiliate: row };
  });

  app.patch("/api/marketing/affiliates/:id", guard("content.edit"), async (req, reply) => {
    const body = z
      .object({
        name: z.string().min(2).max(160).optional(),
        contact: z.string().max(200).nullable().optional(),
        commissionBp: z.number().int().min(0).max(5_000).optional(),
        isActive: z.boolean().optional(),
        notes: z.string().max(2_000).nullable().optional(),
      })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body" });
    const { id } = req.params as { id: string };
    const [row] = await ctx.db.update(affiliates).set(body.data).where(eq(affiliates.id, id)).returning();
    if (!row) return reply.code(404).send({ error: "not_found" });
    await writeAudit(ctx.db, actor(req), "content", "affiliate_updated", row.code);
    return { affiliate: row };
  });

  // ── Churn-дашборд (MD §6.3): active / at-risk / lapsed по R-баллу ────────

  app.get("/api/marketing/churn", guard("content.view"), async () => {
    const buckets = await ctx.db
      .select({
        bucket: sql<string>`case when ${userRfm.rScore} >= 4 then 'active' when ${userRfm.rScore} >= 2 then 'at_risk' else 'lapsed' end`,
        n: sql<string>`count(*)`,
        valueCents: sql<string>`coalesce(sum(${userRfm.monetaryCents}), 0)`,
      })
      .from(userRfm)
      .groupBy(sql`1`);
    const sample = await ctx.db
      .select({
        customerId: userRfm.customerId,
        alias: customers.alias,
        email: customers.email,
        rScore: userRfm.rScore,
        monetaryCents: userRfm.monetaryCents,
        recencyDays: userRfm.recencyDays,
      })
      .from(userRfm)
      .innerJoin(customers, eq(customers.id, userRfm.customerId))
      .where(sql`${userRfm.rScore} <= 3 and ${customers.erasedAt} is null`)
      .orderBy(desc(userRfm.monetaryCents))
      .limit(20);
    const out = { active: { n: 0, valueCents: 0 }, at_risk: { n: 0, valueCents: 0 }, lapsed: { n: 0, valueCents: 0 } };
    for (const b of buckets) {
      const key = b.bucket as keyof typeof out;
      if (out[key]) out[key] = { n: Number(b.n), valueCents: Number(b.valueCents) };
    }
    return { buckets: out, atRiskTop: sample };
  });

  // ── Customer 360 (MD §7.6): всё о клиенте одним экраном ──────────────────

  app.get("/api/marketing/customer360", guard("customers.view"), async (req, reply) => {
    const q = ((req.query as { q?: string }).q ?? "").trim().toLowerCase();
    if (q.length < 3) return reply.code(400).send({ error: "query_too_short" });
    const [person] = await ctx.db
      .select()
      .from(customers)
      .where(sql`lower(${customers.email}) = ${q} or lower(${customers.alias}) = ${q}`)
      .limit(1);
    if (!person) return reply.code(404).send({ error: "not_found" });
    const [orderAgg] = await ctx.db
      .select({
        n: sql<string>`count(*) filter (where ${orders.status} = 'paid')`,
        cents: sql<string>`coalesce(sum(${orders.totalCents}) filter (where ${orders.status} = 'paid'), 0)`,
        lastPaid: sql<string | null>`max(${orders.paidAt})`,
      })
      .from(orders)
      .where(eq(orders.customerId, person.id));
    const tier = await tierFor(ctx, ctx.db, person.id);
    const [rfm] = await ctx.db.select().from(userRfm).where(eq(userRfm.customerId, person.id));
    const cats = await ctx.db.execute(sql`
      select category, purchase_count, total_spent_cents, view_count
      from user_category_stats where customer_id = ${person.id}
      order by purchase_count desc, view_count desc limit 5
    `);
    const [events] = await ctx.db
      .select({ n: sql<string>`count(*)`, last: sql<string | null>`max(${userEvents.createdAt})` })
      .from(userEvents)
      .where(eq(userEvents.customerId, person.id));
    const refs = await ctx.db
      .select({ status: referrals.status, n: sql<string>`count(*)` })
      .from(referrals)
      .where(eq(referrals.referrerCustomerId, person.id))
      .groupBy(referrals.status);
    const codes = await ctx.db.select().from(promoCodes).where(eq(promoCodes.customerId, person.id));
    return {
      customer: {
        id: person.id, alias: person.alias, email: person.email, country: person.country,
        createdAt: person.createdAt, marketingOptIn: person.marketingOptIn,
        unsubscribedAt: person.unsubscribedAt, blocked: person.blocked,
        attribution: person.attribution, affiliateId: person.affiliateId,
      },
      orders: { paid: Number(orderAgg?.n ?? 0), totalCents: Number(orderAgg?.cents ?? 0), lastPaidAt: orderAgg?.lastPaid ?? null },
      loyalty: tier,
      rfm: rfm ?? null,
      categories: (cats as { rows?: unknown[] }).rows ?? cats,
      events: { n: Number(events?.n ?? 0), lastAt: events?.last ?? null },
      referrals: Object.fromEntries(refs.map((r) => [r.status, Number(r.n)])),
      promoCodes: codes.map((c) => ({ code: c.code, type: c.type, value: c.value, usedCount: c.usedCount, validTo: c.validTo, isActive: c.isActive })),
    };
  });
}
