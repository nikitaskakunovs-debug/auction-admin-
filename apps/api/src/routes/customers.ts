import {
  bids, cookieConsents, creditEntries, credits, customerFees, customers, customerTagDefs,
  customerRefreshTokens, notificationPrefs, notifications, orders, savedSearches, watchlist,
} from "@auction/db";
import { and, asc, desc, eq, ilike, inArray, isNull, or, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { writeAudit } from "../audit.js";
import { InsufficientCreditError, moveCredit } from "../engine/credits.js";
import type { AppContext } from "../context.js";
import { requirePermission, type PermissionService } from "../auth/rbac.js";

const actor = (req: { admin?: { sub: string; name: string } }) => ({
  id: req.admin?.sub ?? null,
  label: req.admin?.name ?? "Unknown",
});

/** Explicit column projection — never serialize passwordHash to the admin API. */
const customerCols = {
  id: customers.id,
  email: customers.email,
  alias: customers.alias,
  name: customers.name,
  country: customers.country,
  marketCode: customers.marketCode,
  company: customers.company,
  vatNo: customers.vatNo,
  vies: customers.vies,
  strikes: customers.strikes,
  blocked: customers.blocked,
  blockedReason: customers.blockedReason,
  blockedAt: customers.blockedAt,
  notes: customers.notes,
  erasedAt: customers.erasedAt,
  tags: customers.tags,
  /* Согласие на рассылку. Показывается в панели, потому что доказывать его —
   * обязанность компании, а не человека: без даты и источника оно ничего не
   * стоит (GDPR ст. 7 п. 1). */
  marketingOptIn: customers.marketingOptIn,
  /* Подтверждена ли почта и есть ли соцвход — кабинет клиента это показывает,
   * панель должна видеть то же самое при разборе обращений. */
  emailVerifiedAt: customers.emailVerifiedAt,
  googleId: customers.googleId,
  facebookId: customers.facebookId,
  telegramId: customers.telegramId,
  marketingOptInAt: customers.marketingOptInAt,
  marketingSource: customers.marketingSource,
  marketingOptOutAt: customers.marketingOptOutAt,
  /* Отписка по ссылке из письма и «мёртвый» адрес — это не то же самое, что
   * снятая галочка в кабинете, и разбирать жалобу «мне не приходят письма»
   * без них невозможно. */
  unsubscribedAt: customers.unsubscribedAt,
  emailBouncedAt: customers.emailBouncedAt,
  /* Откуда человек пришёл: первое касание (кто привёл) и последнее (что
   * привело в последний раз). Метки кампаний, не персональные данные. */
  attribution: customers.attribution,
  attributionLast: customers.attributionLast,
  attributionTouches: customers.attributionTouches,
  visitorId: customers.visitorId,
  lastLoginMethod: customers.lastLoginMethod,
  lastLoginAt: customers.lastLoginAt,
  lang: customers.lang,
  createdAt: customers.createdAt,
} as const;

const customerBody = z.object({
  email: z.string().email(),
  alias: z.string().min(2),
  name: z.string().nullable().optional(),
  country: z.string().nullable().optional(),
  marketCode: z.string().length(2).nullable().optional(),
  company: z.string().nullable().optional(),
  vatNo: z.string().nullable().optional(),
  notes: z.string().optional(),
});

export function registerCustomerRoutes(app: FastifyInstance, ctx: AppContext, perms: PermissionService): void {
  const guard = (p: Parameters<typeof requirePermission>[1]) => ({ preHandler: requirePermission(perms, p) });


  /* Журнал согласий на cookie.
   *
   * До этого выбор человека жил только в его браузере: показать его в панели
   * было негде, а на запрос «докажите, что он соглашался» ответить нечем. */
  app.get("/api/consents", guard("customers.view"), async (req) => {
    const q = req.query as { q?: string; mode?: string; limit?: string; offset?: string };
    const limit = Math.min(Math.max(Number(q.limit) || 100, 1), 500);
    const offset = Math.max(Number(q.offset) || 0, 0);
    const conds = [];
    if (q.mode === "accept" || q.mode === "reject" || q.mode === "custom") {
      conds.push(eq(cookieConsents.mode, q.mode));
    }
    if (q.q) conds.push(or(ilike(customers.email, `%${q.q}%`), ilike(cookieConsents.visitorId, `%${q.q}%`)));
    const where = conds.length ? and(...conds) : undefined;
    const rows = await ctx.db
      .select({
        id: cookieConsents.id,
        mode: cookieConsents.mode,
        analytics: cookieConsents.analytics,
        marketing: cookieConsents.marketing,
        policyVersion: cookieConsents.policyVersion,
        host: cookieConsents.host,
        ip: cookieConsents.ip,
        visitorId: cookieConsents.visitorId,
        createdAt: cookieConsents.createdAt,
        email: customers.email,
        alias: customers.alias,
      })
      .from(cookieConsents)
      .leftJoin(customers, eq(cookieConsents.customerId, customers.id))
      .where(where)
      .orderBy(desc(cookieConsents.createdAt))
      .limit(limit + 1)
      .offset(offset);
    const [totalRow] = await ctx.db.select({ n: sql<string>`count(*)` }).from(cookieConsents);
    return {
      consents: rows.slice(0, limit),
      hasMore: rows.length > limit,
      total: Number(totalRow?.n ?? 0),
    };
  });

  app.get("/api/customers", guard("customers.view"), async (req) => {
    const q = req.query as {
      q?: string; status?: string; tag?: string; country?: string; market?: string;
      from?: string; to?: string; debt?: string; sort?: string; limit?: string; offset?: string;
      marketing?: string;
    };
    // A3 power query. Status apart from the rest — pill counts ignore it.
    const statusConds = [];
    if (q.status === "active") statusConds.push(eq(customers.blocked, false), sql`${customers.erasedAt} is null`);
    else if (q.status === "blocked") statusConds.push(eq(customers.blocked, true), sql`${customers.erasedAt} is null`);
    else if (q.status === "erased") statusConds.push(sql`${customers.erasedAt} is not null`);
    else if (q.status === "strikes") statusConds.push(sql`${customers.strikes} > 0`);

    const otherConds = [];
    if (q.q) otherConds.push(or(ilike(customers.alias, `%${q.q}%`), ilike(customers.email, `%${q.q}%`), ilike(customers.name, `%${q.q}%`)));
    if (q.tag) otherConds.push(sql`${customers.tags} @> ${JSON.stringify([q.tag])}::jsonb`);
    if (q.country) otherConds.push(eq(customers.country, q.country.toUpperCase()));
    if (q.market) otherConds.push(eq(customers.marketCode, q.market.toUpperCase()));
    // Кому вообще законно писать рассылку.
    if (q.marketing === "yes") otherConds.push(eq(customers.marketingOptIn, true));
    else if (q.marketing === "no") otherConds.push(eq(customers.marketingOptIn, false));
    const dayStart = (d: string) => new Date(`${d}T00:00:00.000Z`);
    if (q.from) otherConds.push(sql`${customers.createdAt} >= ${dayStart(q.from)}`);
    if (q.to) otherConds.push(sql`${customers.createdAt} < ${new Date(dayStart(q.to).getTime() + 86_400_000)}`);
    // Outstanding restock fees ("debt") — the same rule that pauses bidding.
    // Hand-qualified identifiers: drizzle renders sql`` column refs
    // unqualified, so ${customers.id} inside the subquery would bind to cf.id.
    const debtSql = sql`exists (select 1 from customer_fees cf where cf.customer_id = customers.id and cf.status = 'outstanding')`;
    if (q.debt === "has") otherConds.push(debtSql);

    const conditions = [...statusConds, ...otherConds];
    const where = conditions.length ? and(...conditions) : undefined;
    const limit = Math.min(Math.max(Number(q.limit) || 500, 1), 500);
    const offset = Math.max(Number(q.offset) || 0, 0);
    const order =
      q.sort === "oldest" ? asc(customers.createdAt) :
      q.sort === "alias" ? asc(customers.alias) :
      q.sort === "strikes" ? desc(customers.strikes) : desc(customers.createdAt);

    const rows = await ctx.db
      .select({
        ...customerCols,
        outstandingFeeCents: sql<string>`coalesce((select sum(cf.amount_cents) from customer_fees cf where cf.customer_id = customers.id and cf.status = 'outstanding'), 0)`,
      })
      .from(customers)
      .where(where)
      .orderBy(order)
      .limit(limit)
      .offset(offset);
    const [totalRow] = await ctx.db.select({ n: sql<string>`count(*)` }).from(customers).where(where);
    const [countRow] = await ctx.db
      .select({
        all: sql<string>`count(*)`,
        active: sql<string>`count(*) filter (where not ${customers.blocked} and ${customers.erasedAt} is null)`,
        blocked: sql<string>`count(*) filter (where ${customers.blocked} and ${customers.erasedAt} is null)`,
        erased: sql<string>`count(*) filter (where ${customers.erasedAt} is not null)`,
        strikes: sql<string>`count(*) filter (where ${customers.strikes} > 0)`,
      })
      .from(customers)
      .where(otherConds.length ? and(...otherConds) : undefined);
    return {
      customers: rows.map((r) => ({ ...r, outstandingFeeCents: Number(r.outstandingFeeCents) })),
      total: Number(totalRow!.n),
      counts: {
        all: Number(countRow!.all),
        active: Number(countRow!.active),
        blocked: Number(countRow!.blocked),
        erased: Number(countRow!.erased),
        strikes: Number(countRow!.strikes),
      },
    };
  });

  // ── A3: bidder tags — managed vocabulary + assignment ─────────────────────

  app.get("/api/customer-tags", guard("customers.view"), async () => {
    const rows = await ctx.db.select().from(customerTagDefs).orderBy(asc(customerTagDefs.position), asc(customerTagDefs.createdAt));
    return { tags: rows };
  });

  const TAG_COLORS = ["gold", "green", "blue", "red", "orange", "grey"] as const;
  const tagDefBody = z.object({
    name: z.string().min(1).max(40),
    color: z.enum(TAG_COLORS).default("grey"),
  });
  app.post("/api/customer-tags", guard("settings.edit"), async (req, reply) => {
    const body = tagDefBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body", detail: body.error.flatten() });
    const [maxRow] = await ctx.db.select({ n: sql<string>`coalesce(max(position), -1)` }).from(customerTagDefs);
    const [row] = await ctx.db
      .insert(customerTagDefs)
      .values({ ...body.data, position: Number(maxRow!.n) + 1 })
      .onConflictDoNothing()
      .returning();
    if (!row) return reply.code(409).send({ error: "name_exists" });
    await writeAudit(ctx.db, actor(req), "customer", "tag_created", row.name);
    return { tag: row };
  });

  app.patch("/api/customer-tags/:id", guard("settings.edit"), async (req, reply) => {
    const body = tagDefBody.partial().extend({
      position: z.number().int().min(0).optional(),
      active: z.boolean().optional(),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body", detail: body.error.flatten() });
    const [row] = await ctx.db
      .update(customerTagDefs)
      .set(body.data)
      .where(eq(customerTagDefs.id, (req.params as { id: string }).id))
      .returning();
    if (!row) return reply.code(404).send({ error: "not_found" });
    await writeAudit(ctx.db, actor(req), "customer", "tag_updated", row.name, body.data);
    return { tag: row };
  });

  /** Replace one bidder's tag set (drawer editor). */
  const tagAssignBody = z.object({ tagIds: z.array(z.string().uuid()).max(20) });
  app.post("/api/customers/:id/tags", guard("customers.edit"), async (req, reply) => {
    const body = tagAssignBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body", detail: body.error.flatten() });
    const known = body.data.tagIds.length
      ? await ctx.db.select({ id: customerTagDefs.id }).from(customerTagDefs).where(inArray(customerTagDefs.id, body.data.tagIds))
      : [];
    if (known.length !== body.data.tagIds.length) return reply.code(422).send({ error: "unknown_tag" });
    const [row] = await ctx.db
      .update(customers)
      .set({ tags: body.data.tagIds })
      .where(eq(customers.id, (req.params as { id: string }).id))
      .returning(customerCols);
    if (!row) return reply.code(404).send({ error: "not_found" });
    await writeAudit(ctx.db, actor(req), "customer", "tags_set", row.alias, { tags: body.data.tagIds });
    return { customer: row };
  });

  /** Bulk add/remove one tag across many bidders (list bulk bar). */
  const bulkTagBody = z.object({
    ids: z.array(z.string().uuid()).min(1).max(200),
    add: z.array(z.string().uuid()).max(5).default([]),
    remove: z.array(z.string().uuid()).max(5).default([]),
  });
  app.post("/api/customers/bulk/tags", guard("customers.edit"), async (req, reply) => {
    const body = bulkTagBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body", detail: body.error.flatten() });
    const touch = [...body.data.add, ...body.data.remove];
    if (touch.length === 0) return reply.code(400).send({ error: "nothing_to_do" });
    const known = await ctx.db.select({ id: customerTagDefs.id }).from(customerTagDefs).where(inArray(customerTagDefs.id, touch));
    if (known.length !== new Set(touch).size) return reply.code(422).send({ error: "unknown_tag" });

    const rows = await ctx.db.select({ id: customers.id, alias: customers.alias, tags: customers.tags }).from(customers).where(inArray(customers.id, body.data.ids));
    let updated = 0;
    for (const c of rows) {
      const next = new Set(c.tags);
      for (const t of body.data.add) next.add(t);
      for (const t of body.data.remove) next.delete(t);
      const nextArr = [...next];
      if (nextArr.length === c.tags.length && c.tags.every((t) => next.has(t))) continue;
      await ctx.db.update(customers).set({ tags: nextArr }).where(eq(customers.id, c.id));
      await writeAudit(ctx.db, actor(req), "customer", "tags_bulk", c.alias, { add: body.data.add, remove: body.data.remove });
      updated++;
    }
    return { updated, matched: rows.length };
  });

  /** Начислить или списать аванс клиенту вручную: переплата по перечислению,
   *  компенсация, исправление. Право то же, что у «отметить оплаченным» —
   *  оба движения признают деньги. */
  app.post("/api/customers/:id/credit", guard("orders.mark_paid"), async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z
      .object({
        amountCents: z.number().int().refine((v) => v !== 0, "zero move"),
        kind: z.enum(["overpay", "refund_to_credit", "grant", "withdrawn", "expired"]).default("grant"),
        note: z.string().max(300).default(""),
        orderRef: z.string().max(40).optional(),
      })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body", detail: body.error.flatten() });
    const [customer] = await ctx.db.select().from(customers).where(eq(customers.id, id));
    if (!customer) return reply.code(404).send({ error: "not_found" });
    try {
      const result = await ctx.db.transaction(async (tx) => {
        const moved = await moveCredit(tx, id, {
          kind: body.data.kind,
          amountCents: body.data.amountCents,
          orderRef: body.data.orderRef ?? null,
          note: body.data.note,
          actorLabel: actor(req).label,
        }, ctx.now());
        return moved;
      });
      await writeAudit(ctx.db, actor(req), "customer", "credit_move", id, {
        kind: body.data.kind, amountCents: body.data.amountCents, note: body.data.note,
      });
      return { ok: true, balanceCents: result.balanceCents };
    } catch (err) {
      if (err instanceof InsufficientCreditError) {
        return reply.code(409).send({ error: "insufficient_credit", balanceCents: err.balanceCents });
      }
      throw err;
    }
  });

  app.get("/api/customers/:id", guard("customers.view"), async (req, reply) => {
    const { id } = req.params as { id: string };
    const [row] = await ctx.db.select(customerCols).from(customers).where(eq(customers.id, id));
    if (!row) return reply.code(404).send({ error: "not_found" });
    const orderRows = await ctx.db.select().from(orders).where(eq(orders.customerId, id)).orderBy(desc(orders.createdAt)).limit(100);
    const [bidStats] = await ctx.db
      .select({ total: sql<string>`count(*)`, auctions: sql<string>`count(distinct ${bids.auctionId})` })
      .from(bids)
      .where(eq(bids.customerId, id));
    const feeRows = await ctx.db
      .select()
      .from(customerFees)
      .where(eq(customerFees.customerId, id))
      .orderBy(desc(customerFees.createdAt))
      .limit(100);
    // Аванс: баланс и последние движения — рядом с заказами и сборами.
    const [creditRow] = await ctx.db.select().from(credits).where(eq(credits.customerId, id));
    const creditRows = creditRow
      ? await ctx.db
          .select({ kind: creditEntries.kind, amountCents: creditEntries.amountCents, orderRef: creditEntries.orderRef, note: creditEntries.note, actorLabel: creditEntries.actorLabel, createdAt: creditEntries.createdAt })
          .from(creditEntries)
          .where(eq(creditEntries.creditId, creditRow.id))
          .orderBy(desc(creditEntries.createdAt))
          .limit(50)
      : [];
    /* Согласия на cookie — вся история решений человека.
     *
     * Ищем и по аккаунту, и по id браузера: до регистрации согласие
     * записывается только на браузер, и без сшивки самая первая, самая
     * важная строка — «что он выбрал, когда пришёл впервые» — навсегда
     * оставалась бы невидимой в его карточке. */
    const consentRows = await ctx.db
      .select({
        id: cookieConsents.id,
        mode: cookieConsents.mode,
        analytics: cookieConsents.analytics,
        marketing: cookieConsents.marketing,
        policyVersion: cookieConsents.policyVersion,
        host: cookieConsents.host,
        createdAt: cookieConsents.createdAt,
        viaVisitor: sql<boolean>`${cookieConsents.customerId} is null`,
      })
      .from(cookieConsents)
      .where(
        row.visitorId
          ? or(eq(cookieConsents.customerId, id), eq(cookieConsents.visitorId, row.visitorId))
          : eq(cookieConsents.customerId, id),
      )
      .orderBy(desc(cookieConsents.createdAt))
      .limit(50);

    // Живые сессии: с чего человек заходит прямо сейчас — то же, что он сам
    // видит на экране «Drošība».
    const sessionRows = await ctx.db
      .select({
        id: customerRefreshTokens.id,
        ua: customerRefreshTokens.ua,
        ip: customerRefreshTokens.ip,
        lastUsedAt: customerRefreshTokens.lastUsedAt,
        createdAt: customerRefreshTokens.createdAt,
      })
      .from(customerRefreshTokens)
      .where(and(eq(customerRefreshTokens.customerId, id), isNull(customerRefreshTokens.revokedAt)))
      .orderBy(desc(customerRefreshTokens.lastUsedAt))
      .limit(10);

    // Последние письма: что человеку реально отправили и дошло ли.
    const mailRows = await ctx.db
      .select({
        id: notifications.id,
        type: notifications.type,
        kind: notifications.kind,
        subject: notifications.subject,
        status: notifications.status,
        sentAt: notifications.sentAt,
        scheduledFor: notifications.scheduledFor,
        lastError: notifications.lastError,
        createdAt: notifications.createdAt,
      })
      .from(notifications)
      .where(eq(notifications.customerId, id))
      .orderBy(desc(notifications.createdAt))
      .limit(20);

    // Интересы: сохранённые поиски и вэлмес — по ним видно, чего человек ждёт.
    const searchRows = await ctx.db
      .select({ id: savedSearches.id, name: savedSearches.name, alertEmail: savedSearches.alertEmail, createdAt: savedSearches.createdAt })
      .from(savedSearches)
      .where(eq(savedSearches.customerId, id))
      .orderBy(desc(savedSearches.createdAt))
      .limit(20);
    const [watchCount] = await ctx.db
      .select({ n: sql<string>`count(*)` })
      .from(watchlist)
      .where(eq(watchlist.customerId, id));
    const prefRows = await ctx.db
      .select({ event: notificationPrefs.event, email: notificationPrefs.email })
      .from(notificationPrefs)
      .where(eq(notificationPrefs.customerId, id));

    return {
      customer: row,
      orders: orderRows,
      bidStats: { totalBids: Number(bidStats!.total), auctionsBidOn: Number(bidStats!.auctions) },
      fees: feeRows,
      outstandingFeeCents: feeRows.filter((f) => f.status === "outstanding").reduce((s, f) => s + f.amountCents, 0),
      credit: { balanceCents: creditRow?.balanceCents ?? 0, entries: creditRows },
      consents: consentRows,
      sessions: sessionRows,
      mail: mailRows,
      searches: searchRows,
      watchCount: Number(watchCount?.n ?? 0),
      notificationPrefs: prefRows,
      /** Итог по деньгам — то, что спрашивают первым: сколько он нам принёс. */
      lifetime: {
        paidOrders: orderRows.filter((o) => o.status === "paid").length,
        revenueCents: orderRows.filter((o) => o.status === "paid").reduce((s, o) => s + o.totalCents, 0),
      },
    };
  });

  // ── Restock-fee settlement (outstanding fees pause bidding/buying) ────────

  const feeAction = z.object({ note: z.string().max(300).default("") });
  for (const action of ["settle", "waive"] as const) {
    app.post(`/api/customers/:id/fees/:feeId/${action}`, guard("customers.strike"), async (req, reply) => {
      const body = feeAction.safeParse(req.body ?? {});
      if (!body.success) return reply.code(400).send({ error: "invalid_body" });
      if (action === "waive" && body.data.note.trim().length < 3) {
        return reply.code(400).send({ error: "invalid_body", detail: "waiving requires a reason note" });
      }
      const { id, feeId } = req.params as { id: string; feeId: string };
      const [fee] = await ctx.db
        .update(customerFees)
        .set({
          status: action === "settle" ? "settled" : "waived",
          note: body.data.note || undefined,
          settledById: req.admin!.sub,
          settledAt: ctx.now(),
        })
        .where(and(eq(customerFees.id, feeId), eq(customerFees.customerId, id), eq(customerFees.status, "outstanding")))
        .returning();
      if (!fee) return reply.code(409).send({ error: "fee_not_outstanding" });
      await writeAudit(ctx.db, actor(req), "customer", `fee_${action}d`, fee.orderRef, {
        feeId: fee.id,
        amountCents: fee.amountCents,
        note: body.data.note,
      });
      return { fee };
    });
  }

  app.post("/api/customers", guard("customers.edit"), async (req, reply) => {
    const body = customerBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body", detail: body.error.flatten() });
    const [row] = await ctx.db
      .insert(customers)
      .values({ ...body.data, email: body.data.email.toLowerCase() })
      .onConflictDoNothing()
      .returning(customerCols);
    if (!row) return reply.code(409).send({ error: "email_exists" });
    await writeAudit(ctx.db, actor(req), "customer", "created", row.alias);
    return { customer: row };
  });

  app.patch("/api/customers/:id", guard("customers.edit"), async (req, reply) => {
    const body = customerBody.partial().safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body", detail: body.error.flatten() });
    const { id } = req.params as { id: string };
    const [row] = await ctx.db.update(customers).set(body.data).where(eq(customers.id, id)).returning(customerCols);
    if (!row) return reply.code(404).send({ error: "not_found" });
    await writeAudit(ctx.db, actor(req), "customer", "updated", row.alias, { fields: Object.keys(body.data) });
    return { customer: row };
  });

  // ── Account suspension (zero-tolerance policy, staff-abuse etc.) ──────────
  // Blocking always goes through these audited endpoints — the generic PATCH
  // deliberately cannot flip `blocked`, so every ban carries a reason + actor.

  const blockSchema = z.object({ reason: z.string().min(3).max(500) });
  app.post("/api/customers/:id/block", guard("customers.strike"), async (req, reply) => {
    const body = blockSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body", detail: "reason required (min 3 chars)" });
    const { id } = req.params as { id: string };
    const [row] = await ctx.db
      .update(customers)
      .set({ blocked: true, blockedReason: body.data.reason, blockedAt: ctx.now() })
      .where(eq(customers.id, id))
      .returning(customerCols);
    if (!row) return reply.code(404).send({ error: "not_found" });
    await writeAudit(ctx.db, actor(req), "customer", "blocked", row.alias, { reason: body.data.reason });
    return { customer: row };
  });

  app.post("/api/customers/:id/unblock", guard("customers.strike"), async (req, reply) => {
    const body = blockSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body", detail: "reason required (min 3 chars)" });
    const { id } = req.params as { id: string };
    const [row] = await ctx.db
      .update(customers)
      .set({ blocked: false, blockedReason: null, blockedAt: null })
      .where(and(eq(customers.id, id), sql`${customers.erasedAt} is null`))
      .returning(customerCols);
    if (!row) return reply.code(404).send({ error: "not_found" });
    await writeAudit(ctx.db, actor(req), "customer", "unblocked", row.alias, { reason: body.data.reason });
    return { customer: row };
  });

  const strikeSchema = z.object({ reason: z.string().min(3) });
  app.post("/api/customers/:id/strike", guard("customers.strike"), async (req, reply) => {
    const body = strikeSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body", detail: "reason required" });
    const { id } = req.params as { id: string };
    const [row] = await ctx.db
      .update(customers)
      .set({ strikes: sql`${customers.strikes} + 1` })
      .where(eq(customers.id, id))
      .returning(customerCols);
    if (!row) return reply.code(404).send({ error: "not_found" });
    await writeAudit(ctx.db, actor(req), "customer", "strike_added", row.alias, { reason: body.data.reason, strikes: row.strikes });
    return { customer: row };
  });

  /** GDPR erasure — order snapshots survive; the person does not. */
  app.post("/api/customers/:id/erase", guard("customers.erase"), async (req, reply) => {
    const { id } = req.params as { id: string };
    const [row] = await ctx.db
      .update(customers)
      .set({
        name: null,
        company: null,
        vatNo: null,
        vies: null,
        // Revoke storefront access on erasure — the password hash is
        // personal credential material and must not survive a GDPR erase.
        passwordHash: null,
        notes: "",
        email: `erased-${id}@erased.invalid`,
        alias: "erased_user",
        blocked: true,
        blockedReason: "GDPR erasure",
        blockedAt: ctx.now(),
        erasedAt: ctx.now(),
      })
      .where(eq(customers.id, id))
      .returning({ id: customers.id });
    if (!row) return reply.code(404).send({ error: "not_found" });
    await writeAudit(ctx.db, actor(req), "customer", "gdpr_erased", id);
    return { ok: true };
  });
}
