import { createHash, randomBytes } from "node:crypto";
import {
  auctions,
  auditLog,
  bids,
  billingProfiles,
  cookieConsents,
  counters,
  creditEntries,
  credits,
  customerFees,
  customerRefreshTokens,
  customers,
  hashPassword,
  invoices,
  items,
  listings,
  markets,
  notificationPrefs,
  notifications,
  orders,
  payments,
  pickupTickets,
  refunds,
  returnCases,
  savedSearches,
  shipments,
  verifyPassword,
} from "@auction/db";
import { and, asc, desc, eq, gt, ilike, inArray, isNull, lt, sql } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { signAccessToken } from "../auth/jwt.js";
import {
  createResetToken,
  findValidResetToken,
  markResetTokenUsed,
  resetEmail,
  resetRequestAllowed,
} from "../auth/passwordReset.js";
import type { AppContext } from "../context.js";
import { placeBid } from "../engine/bids.js";
import { InsufficientCreditError, getOrCreateCredit, moveCredit } from "../engine/credits.js";
import { renderInvoiceHtml, type InvoiceData } from "../engine/invoices.js";
import { renderInvoicePdf } from "../engine/invoicePdf.js";
import { enqueueNotification } from "../engine/notifications.js";
import { registerSocialAuthRoutes } from "./socialAuth.js";
import { buyNow } from "../engine/purchase.js";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/**
 * Public storefront API. HYGIENE RULES (design doc): responses NEVER contain
 * reserve amounts (only reserveMet), proxy maxima, customer emails, or any
 * admin-only field. Bidders authenticate with kind="bidder" tokens that the
 * admin routes reject by construction.
 */

/** Public-safe auction card/detail shape. */
function publicAuction(row: {
  auction: typeof auctions.$inferSelect;
  listing: typeof listings.$inferSelect;
  item: typeof items.$inferSelect;
  leaderAlias: string | null;
}) {
  const { auction, listing, item } = row;
  return {
    id: auction.id,
    title: listing.title,
    description: listing.description,
    sku: item.sku,
    condition: item.condition,
    conditionNotes: item.conditionNotes,
    category: item.category,
    photos: item.photos,
    marketCode: listing.marketCode,
    status: auction.status,
    startsAt: auction.startsAt,
    endsAt: auction.endsAt,
    startPriceCents: listing.startPriceCents,
    currentPriceCents: auction.currentPriceCents,
    bidCount: auction.bidCount,
    leaderAlias: row.leaderAlias,
    hasReserve: listing.reserveCents !== null,
    reserveMet: listing.reserveCents === null ? true : auction.reserveMet,
  };
}

export function registerPublicRoutes(app: FastifyInstance, ctx: AppContext): void {
  // ── Bidder auth ───────────────────────────────────────────────────────────

  async function issueTokens(customer: { id: string; email: string; alias: string }, req?: FastifyRequest) {
    const refreshToken = randomBytes(48).toString("base64url");
    // Сессия = строка refresh-токена; её id уходит в access-токен как sid,
    // чтобы экран «Drošība» знал, какая из сессий — текущая.
    const [session] = await ctx.db
      .insert(customerRefreshTokens)
      .values({
        customerId: customer.id,
        tokenHash: sha256(refreshToken),
        expiresAt: new Date(ctx.now().getTime() + ctx.config.refreshTokenTtlSec * 1000),
        ua: req?.headers["user-agent"]?.slice(0, 300) ?? null,
        ip: req?.ip ?? null,
        lastUsedAt: ctx.now(),
      })
      .returning({ id: customerRefreshTokens.id });
    const accessToken = signAccessToken(
      { sub: customer.id, kind: "bidder", email: customer.email, name: customer.alias, role: "bidder", sid: session!.id },
      ctx.config.jwtSecret,
      ctx.config.accessTokenTtlSec,
      ctx.now().getTime(),
    );
    return {
      accessToken,
      refreshToken,
      bidder: { id: customer.id, email: customer.email, alias: customer.alias },
    };
  }

  /** Токен подтверждения почты: случайный, в базе только его отпечаток. */
  async function sendVerificationEmail(customer: { id: string; email: string }): Promise<void> {
    const token = randomBytes(32).toString("base64url");
    await ctx.db
      .update(customers)
      .set({ emailVerifyTokenHash: sha256(token), emailVerifySentAt: ctx.now() })
      .where(eq(customers.id, customer.id));
    const link = `${ctx.config.storefrontBaseUrl}/verify-email?token=${token}`;
    await enqueueNotification(ctx, ctx.db, {
      customerId: customer.id,
      type: "verify_email",
      template: { alias: "", lotTitle: "", actionUrl: link },
    });
  }

  /** Ставки и покупки — только с подтверждённой почтой (макет № 15). */
  async function requireVerifiedEmail(bidderId: string, reply: FastifyReply): Promise<boolean> {
    if (!ctx.config.requireVerifiedEmail) return true;
    const [c] = await ctx.db
      .select({ verifiedAt: customers.emailVerifiedAt })
      .from(customers)
      .where(eq(customers.id, bidderId));
    if (!c || c.verifiedAt !== null) return true;
    void reply.code(403).send({ ok: false, code: "EMAIL_NOT_VERIFIED" });
    return false;
  }

  registerSocialAuthRoutes(app, ctx, { issueTokens });

  const registerSchema = z.object({
    email: z.string().email(),
    alias: z
      .string()
      .min(3)
      .max(24)
      .regex(/^[a-zA-Z0-9_.-]+$/, "alias may contain letters, digits, _ . -"),
    password: z.string().min(8),
    name: z.string().max(120).optional(),
    country: z.enum(["LV", "EE", "LT"]).optional(),
    /** Согласие на рассылку. Отдельная галочка, по умолчанию снятая: молчание
     *  согласием не является, а из самого факта регистрации оно не следует. */
    marketingOptIn: z.boolean().optional(),
    /** The storefront's active language — the one we write emails in. Latvia
     * runs a Latvian and a Russian site, and country alone cannot tell them
     * apart. Estonian and Lithuanian visitors get English until that copy
     * exists. */
    lang: z.enum(["lv", "ru", "en", "et", "lt"]).optional(),
  });

  app.post("/api/public/auth/register", async (req, reply) => {
    const body = registerSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body", detail: body.error.flatten() });
    const [row] = await ctx.db
      .insert(customers)
      .values({
        email: body.data.email.toLowerCase(),
        alias: body.data.alias,
        name: body.data.name ?? null,
        country: body.data.country ?? null,
        lang: body.data.lang === "lv" || body.data.lang === "ru" ? body.data.lang : body.data.lang ? "en" : null,
        marketCode: body.data.country ?? null,
        passwordHash: await hashPassword(body.data.password),
        marketingOptIn: body.data.marketingOptIn === true,
        marketingOptInAt: body.data.marketingOptIn === true ? ctx.now() : null,
        marketingSource: body.data.marketingOptIn === true ? "register" : null,
      })
      .onConflictDoNothing()
      .returning({ id: customers.id, email: customers.email, alias: customers.alias });
    if (!row) return reply.code(409).send({ error: "email_exists" });
    // Письмо со ссылкой уходит сразу; до подтверждения ставки закрыты.
    await sendVerificationEmail(row);
    return issueTokens(row, req);
  });

  app.post("/api/public/auth/login", async (req, reply) => {
    const body = z.object({ email: z.string().email(), password: z.string().min(1) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body" });
    const [customer] = await ctx.db
      .select()
      .from(customers)
      .where(eq(customers.email, body.data.email.toLowerCase()));
    if (
      !customer ||
      customer.erasedAt !== null ||
      !customer.passwordHash ||
      !(await verifyPassword(body.data.password, customer.passwordHash))
    ) {
      return reply.code(401).send({ error: "invalid_credentials" });
    }
    return issueTokens(customer, req);
  });

  // ── Forgot password (emailed single-use link) ─────────────────────────────
  app.post("/api/public/auth/forgot-password", async (req, reply) => {
    const body = z.object({ email: z.string().email() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body" });
    const email = body.data.email.toLowerCase();
    // Flat "ok" whether or not the account exists; lookup + email happen
    // after the response so timing can't reveal existence either.
    void (async () => {
      if (!(await resetRequestAllowed(ctx.redis, email))) return;
      const [customer] = await ctx.db.select().from(customers).where(eq(customers.email, email));
      if (!customer || customer.erasedAt !== null || !customer.passwordHash) return;
      const token = await createResetToken(ctx, { customerId: customer.id });
      const link = `${ctx.config.storefrontBaseUrl}/reset-password?token=${token}`;
      const msg = resetEmail(link, Math.round(ctx.config.passwordResetTtlSec / 60));
      await ctx.email.send({ to: customer.email, subject: msg.subject, text: msg.text });
    })().catch((err) => req.log.error({ err }, "customer forgot-password processing failed"));
    return reply.send({ ok: true });
  });

  app.post("/api/public/auth/reset-password", async (req, reply) => {
    const body = z.object({ token: z.string().min(20), newPassword: z.string().min(8) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body" });
    const found = await findValidResetToken(ctx, body.data.token);
    if (!found || !found.customerId) return reply.code(401).send({ error: "invalid_or_expired_token" });
    const [customer] = await ctx.db.select().from(customers).where(eq(customers.id, found.customerId));
    if (!customer || customer.erasedAt !== null) return reply.code(401).send({ error: "invalid_or_expired_token" });
    await ctx.db
      .update(customers)
      .set({ passwordHash: await hashPassword(body.data.newPassword) })
      .where(eq(customers.id, customer.id));
    await markResetTokenUsed(ctx, found.rowId);
    // Credential change ends every live session on every device.
    await ctx.db
      .update(customerRefreshTokens)
      .set({ revokedAt: ctx.now() })
      .where(and(eq(customerRefreshTokens.customerId, customer.id), isNull(customerRefreshTokens.revokedAt)));
    return { ok: true };
  });

  app.post("/api/public/auth/refresh", async (req, reply) => {
    const body = z.object({ refreshToken: z.string().min(10) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body" });
    const [row] = await ctx.db
      .select()
      .from(customerRefreshTokens)
      .where(and(eq(customerRefreshTokens.tokenHash, sha256(body.data.refreshToken)), isNull(customerRefreshTokens.revokedAt)));
    if (!row || row.expiresAt.getTime() <= ctx.now().getTime()) {
      return reply.code(401).send({ error: "invalid_refresh_token" });
    }
    const [customer] = await ctx.db.select().from(customers).where(eq(customers.id, row.customerId));
    if (!customer || customer.erasedAt !== null) return reply.code(401).send({ error: "invalid_refresh_token" });
    await ctx.db.update(customerRefreshTokens).set({ revokedAt: ctx.now() }).where(eq(customerRefreshTokens.id, row.id));
    return issueTokens(customer, req);
  });

  const requireBidder = (req: FastifyRequest, reply: FastifyReply): string | null => {
    if (!req.bidder) {
      void reply.code(401).send({ error: "unauthenticated" });
      return null;
    }
    return req.bidder.sub;
  };

  app.get("/api/public/auth/me", async (req, reply) => {
    const id = requireBidder(req, reply);
    if (!id) return;
    const [c] = await ctx.db.select().from(customers).where(eq(customers.id, id));
    if (!c || c.erasedAt !== null) return reply.code(401).send({ error: "unauthenticated" });
    return {
      bidder: {
        id: c.id, email: c.email, alias: c.alias, country: c.country,
        blocked: c.blocked, strikes: c.strikes,
        // Кабинет показывает состояние подписки и даёт отозвать её в один клик.
        marketingOptIn: c.marketingOptIn,
        // Реквизиты для страницы настроек — что сейчас пойдёт в счёт.
        name: c.name, company: c.company, vatNo: c.vatNo,
        // Verifikācija (№ 14/15): без подтверждения ставки и покупки закрыты.
        emailVerified: c.emailVerifiedAt !== null,
        // № 54: без пароля кабинет предлагает его создать.
        hasPassword: c.passwordHash !== null,
        // № 50: Telegram адреса не даёт — до настоящего адреса стоит служебный.
        emailPending: c.email.endsWith("@nav.izsoli.lv"),
      },
    };
  });

  // ── Browse ────────────────────────────────────────────────────────────────

  /** Catalog paging: ?q= title search, ?category= code, ?limit/?offset. */
  const pageParams = (q: { limit?: string; offset?: string }) => ({
    limit: Math.min(Math.max(Number(q.limit) || 48, 1), 100),
    offset: Math.max(Number(q.offset) || 0, 0),
  });

  app.get("/api/public/auctions", async (req) => {
    const q = req.query as { status?: string; market?: string; q?: string; category?: string; limit?: string; offset?: string };
    const statuses = q.status === "scheduled" ? ["scheduled"] : q.status === "ended" ? ["ended_won", "ended_reserve_not_met", "ended_no_bids"] : ["live", "scheduled"];
    const conditions = [inArray(auctions.status, statuses), eq(listings.status, "published")];
    if (q.market) conditions.push(eq(listings.marketCode, q.market.toUpperCase()));
    if (q.category) conditions.push(eq(items.category, q.category));
    if (q.q && q.q.trim().length >= 2) conditions.push(ilike(listings.title, `%${q.q.trim()}%`));
    const { limit, offset } = pageParams(q);
    // Живым — ближайший конец первым; завершённым наоборот: страница
    // результатов показывает свежие торги, а не археологию. Со старым asc
    // новые результаты выпадали из выдачи, как только завершённых
    // становилось больше лимита страницы.
    const order = q.status === "ended" ? desc(auctions.endsAt) : asc(auctions.endsAt);
    const rows = await ctx.db
      .select({ auction: auctions, listing: listings, item: items, leaderAlias: customers.alias })
      .from(auctions)
      .innerJoin(listings, eq(auctions.listingId, listings.id))
      .innerJoin(items, eq(listings.itemId, items.id))
      .leftJoin(customers, eq(auctions.leaderCustomerId, customers.id))
      .where(and(...conditions))
      .orderBy(order)
      .limit(limit + 1)
      .offset(offset);
    return { auctions: rows.slice(0, limit).map(publicAuction), hasMore: rows.length > limit };
  });

  app.get("/api/public/auctions/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const [row] = await ctx.db
      .select({ auction: auctions, listing: listings, item: items, leaderAlias: customers.alias })
      .from(auctions)
      .innerJoin(listings, eq(auctions.listingId, listings.id))
      .innerJoin(items, eq(listings.itemId, items.id))
      .leftJoin(customers, eq(auctions.leaderCustomerId, customers.id))
      .where(eq(auctions.id, id));
    if (!row) return reply.code(404).send({ error: "not_found" });

    // Public ledger: alias + visible amount only. No maxima, no ids.
    const ledger = await ctx.db
      .select({
        alias: customers.alias,
        amountCents: bids.amountCents,
        auto: bids.auto,
        outbid: bids.outbid,
        seq: bids.seq,
        createdAt: bids.createdAt,
        customerId: bids.customerId,
        voidedAt: bids.voidedAt,
      })
      .from(bids)
      .innerJoin(customers, eq(bids.customerId, customers.id))
      .where(and(eq(bids.auctionId, id), isNull(bids.voidedAt)))
      .orderBy(desc(bids.seq))
      .limit(100);

    const me = req.bidder?.sub ?? null;
    return {
      auction: publicAuction(row),
      minNextBidCents: await minNext(row),
      // What the current price actually costs the winner (hammer + buyer
      // premium + VAT) — drives the Pay Later monthly-payment calculator.
      estimatedTotalCents: await estimatedTotal(row),
      bids: ledger.map((b) => ({
        alias: b.alias,
        amountCents: b.amountCents,
        auto: b.auto,
        outbid: b.outbid,
        seq: b.seq,
        createdAt: b.createdAt,
        isYou: me !== null && b.customerId === me,
      })),
    };
  });

  async function minNext(row: { auction: typeof auctions.$inferSelect; listing: typeof listings.$inferSelect }) {
    const { incrementAt } = await import("@auction/domain");
    const { markets } = await import("@auction/db");
    if (row.auction.currentPriceCents === null) return row.listing.startPriceCents ?? 0;
    const [market] = await ctx.db.select().from(markets).where(eq(markets.code, row.listing.marketCode));
    return row.auction.currentPriceCents + incrementAt(row.auction.currentPriceCents, market!.incrementTable);
  }

  /** Итог по текущей цене. Цена — финальная (комиссия и НДС внутри),
   *  поэтому итог и есть текущая цена: чекаут её только раскладывает. */
  async function estimatedTotal(row: { auction: typeof auctions.$inferSelect; listing: typeof listings.$inferSelect }) {
    return row.auction.currentPriceCents ?? row.listing.startPriceCents ?? 0;
  }

  // ── The real bid path ─────────────────────────────────────────────────────

  const bidSchema = z.object({ maxCents: z.number().int().positive() });
  app.post("/api/public/auctions/:id/bids", async (req, reply) => {
    const bidderId = requireBidder(req, reply);
    if (!bidderId) return;
    const body = bidSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body" });
    if (!(await requireVerifiedEmail(bidderId, reply))) return;
    const { id } = req.params as { id: string };
    const result = await placeBid(ctx, { auctionId: id, customerId: bidderId, maxCents: body.data.maxCents });
    if (!result.ok) return reply.code(422).send(result);
    return {
      ok: true,
      currentPriceCents: result.currentPriceCents,
      youLead: result.leaderCustomerId === bidderId,
      leaderAlias: result.leaderAlias,
      bidCount: result.bidCount,
      endsAt: result.endsAt,
      extended: result.extended,
      reserveMet: result.reserveMet,
    };
  });

  // ── My activity ───────────────────────────────────────────────────────────

  /* ── СОГЛАСИЯ ──────────────────────────────────────────────────────────
   *
   * Раньше выбор в плашке cookie записывался только в браузер человека и не
   * читался вообще ничем. Доказать согласие было нечем (GDPR ст. 7 п. 1),
   * увидеть его в панели — негде, а на втором устройстве плашка спрашивала
   * заново. Теперь каждое решение — строка в журнале.
   */

  /** Действующая редакция текста о cookie. Меняется вместе с текстом: старые
   *  согласия остаются привязанными к той редакции, на которую соглашались. */
  const COOKIE_POLICY_VERSION = "2026-08-21";

  const consentSchema = z.object({
    visitorId: z.string().min(8).max(64),
    mode: z.enum(["accept", "reject", "custom"]),
    analytics: z.boolean(),
    marketing: z.boolean(),
  });

  app.post("/api/public/consent", async (req, reply) => {
    const body = consentSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body" });
    const [row] = await ctx.db
      .insert(cookieConsents)
      .values({
        customerId: req.bidder?.sub ?? null,
        visitorId: body.data.visitorId,
        mode: body.data.mode,
        analytics: body.data.analytics,
        marketing: body.data.marketing,
        policyVersion: COOKIE_POLICY_VERSION,
        host: String(req.headers.host ?? ""),
        ip: req.ip,
        userAgent: String(req.headers["user-agent"] ?? "").slice(0, 300),
      })
      .returning({ id: cookieConsents.id, createdAt: cookieConsents.createdAt });
    return { ok: true, id: row!.id, at: row!.createdAt, policyVersion: COOKIE_POLICY_VERSION };
  });

  /** Последнее решение — по посетителю или по вошедшему человеку.
   *
   *  Именно это избавляет от повторного вопроса на втором устройстве: если
   *  человек вошёл, согласие едет за аккаунтом, а не за браузером. */
  app.get("/api/public/consent", async (req) => {
    const visitorId = (req.query as { visitorId?: string }).visitorId;
    const me = req.bidder?.sub ?? null;
    if (!me && !visitorId) return { consent: null, policyVersion: COOKIE_POLICY_VERSION };
    const [row] = await ctx.db
      .select()
      .from(cookieConsents)
      .where(me ? eq(cookieConsents.customerId, me) : eq(cookieConsents.visitorId, visitorId!))
      .orderBy(desc(cookieConsents.createdAt))
      .limit(1);
    if (!row) return { consent: null, policyVersion: COOKIE_POLICY_VERSION };
    return {
      consent: {
        mode: row.mode,
        analytics: row.analytics,
        marketing: row.marketing,
        policyVersion: row.policyVersion,
        at: row.createdAt,
      },
      // Текст изменился — согласие на прежнюю редакцию больше не действует.
      stale: row.policyVersion !== COOKIE_POLICY_VERSION,
      policyVersion: COOKIE_POLICY_VERSION,
    };
  });

  /** Согласие на рассылку: дать и отозвать. Отзыв обязан быть так же прост,
   *  как согласие, — поэтому это один и тот же маршрут с булевым полем. */
  app.post("/api/public/me/marketing", async (req, reply) => {
    const bidderId = requireBidder(req, reply);
    if (!bidderId) return;
    const body = z.object({ optIn: z.boolean() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body" });
    const now = ctx.now();
    await ctx.db
      .update(customers)
      .set(
        body.data.optIn
          ? { marketingOptIn: true, marketingOptInAt: now, marketingSource: "account", marketingOptOutAt: null }
          // Дату согласия не стираем: отзыв тоже нужно уметь показать.
          : { marketingOptIn: false, marketingOptOutAt: now },
      )
      .where(eq(customers.id, bidderId));
    return { optIn: body.data.optIn };
  });

  /** Правка своего профиля из кабинета. Поля независимы: пришло только то,
   *  что человек менял. Рассылка проходит через ту же запись дат согласия,
   *  что и остальные её входы, — иначе отзыв было бы нечем доказать. */
  app.patch("/api/public/me", async (req, reply) => {
    const bidderId = requireBidder(req, reply);
    if (!bidderId) return;
    const body = z
      .object({
        alias: z
          .string()
          .min(3)
          .max(24)
          .regex(/^[a-zA-Z0-9_.-]+$/, "alias may contain letters, digits, _ . -")
          .optional(),
        marketingOptIn: z.boolean().optional(),
        /** Смена адреса (№ 50): новый адрес сначала подтверждается письмом —
         *  до этого ставки снова закрыты. */
        email: z.string().email().optional(),
        // Реквизиты для счетов: имя и — при счёте на SIA — название фирмы с
        // номером PVN. Пустая строка стирает значение: человек вернулся к
        // счетам на своё имя.
        name: z.string().max(120).optional(),
        company: z.string().max(160).optional(),
        vatNo: z.string().max(24).optional(),
      })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body", detail: body.error.flatten() });
    const patch: Partial<typeof customers.$inferInsert> = {};
    if (body.data.alias !== undefined) patch.alias = body.data.alias;
    if (body.data.name !== undefined) patch.name = body.data.name.trim() || null;
    if (body.data.company !== undefined) patch.company = body.data.company.trim() || null;
    if (body.data.vatNo !== undefined) patch.vatNo = body.data.vatNo.trim() || null;
    if (body.data.marketingOptIn !== undefined) {
      const now = ctx.now();
      if (body.data.marketingOptIn) {
        patch.marketingOptIn = true;
        patch.marketingOptInAt = now;
        patch.marketingSource = "account";
        patch.marketingOptOutAt = null;
      } else {
        // Дату согласия не стираем: отзыв тоже нужно уметь показать.
        patch.marketingOptIn = false;
        patch.marketingOptOutAt = now;
      }
    }
    let emailChanged = false;
    if (body.data.email !== undefined) {
      const nextEmail = body.data.email.toLowerCase();
      const [current] = await ctx.db.select().from(customers).where(eq(customers.id, bidderId));
      if (current && current.email !== nextEmail) {
        const [taken] = await ctx.db.select({ id: customers.id }).from(customers).where(eq(customers.email, nextEmail));
        if (taken) return reply.code(409).send({ error: "email_exists" });
        patch.email = nextEmail;
        patch.emailVerifiedAt = null;
        emailChanged = true;
      }
    }
    if (Object.keys(patch).length === 0) return reply.code(400).send({ error: "empty_patch" });
    const [row] = await ctx.db
      .update(customers)
      .set(patch)
      .where(eq(customers.id, bidderId))
      .returning({ id: customers.id, email: customers.email, alias: customers.alias, marketingOptIn: customers.marketingOptIn });
    if (!row) return reply.code(401).send({ error: "unauthenticated" });
    if (emailChanged) await sendVerificationEmail({ id: row.id, email: row.email });
    return { ok: true, alias: row.alias, marketingOptIn: row.marketingOptIn };
  });

  app.get("/api/public/me/bids", async (req, reply) => {
    const bidderId = requireBidder(req, reply);
    if (!bidderId) return;
    const rows = await ctx.db
      .selectDistinctOn([bids.auctionId], {
        auctionId: bids.auctionId,
        myLastBidAt: bids.createdAt,
        // Свой максимум показываем в кабинете строкой «tavs maksimums» —
        // это личные данные, поэтому только своему владельцу.
        myMaxCents: bids.maxCents,
      })
      .from(bids)
      .where(eq(bids.customerId, bidderId))
      .orderBy(bids.auctionId, desc(bids.seq));
    if (rows.length === 0) return { bids: [] };
    const auctionRows = await ctx.db
      .select({ auction: auctions, listing: listings, item: items, leaderAlias: customers.alias })
      .from(auctions)
      .innerJoin(listings, eq(auctions.listingId, listings.id))
      .innerJoin(items, eq(listings.itemId, items.id))
      .leftJoin(customers, eq(auctions.leaderCustomerId, customers.id))
      .where(inArray(auctions.id, rows.map((r) => r.auctionId)));
    const myMax = new Map(rows.map((r) => [r.auctionId, r.myMaxCents]));
    return {
      bids: auctionRows.map((r) => ({
        ...publicAuction(r),
        youLead: r.auction.leaderCustomerId === bidderId,
        myMaxCents: myMax.get(r.auction.id) ?? null,
      })),
    };
  });

  app.get("/api/public/me/orders", async (req, reply) => {
    const bidderId = requireBidder(req, reply);
    if (!bidderId) return;
    const rows = await ctx.db
      .select({ order: orders, itemTitle: items.title, itemSku: items.sku, itemCategory: items.category, itemCondition: items.condition })
      .from(orders)
      .innerJoin(items, eq(orders.itemId, items.id))
      .where(eq(orders.customerId, bidderId))
      .orderBy(desc(orders.createdAt))
      .limit(100);
    // Latest shipment per order — the bidder's tracking line.
    const orderIds = rows.map((r) => r.order.id);
    const shipmentRows = orderIds.length
      ? await ctx.db
          .select({
            orderId: shipments.orderId,
            barcode: shipments.barcode,
            status: shipments.status,
            createdAt: shipments.createdAt,
          })
          .from(shipments)
          .where(inArray(shipments.orderId, orderIds))
          .orderBy(desc(shipments.createdAt))
      : [];
    const shipmentByOrder = new Map<string, (typeof shipmentRows)[number]>();
    for (const s of shipmentRows) if (!shipmentByOrder.has(s.orderId)) shipmentByOrder.set(s.orderId, s);
    return {
      orders: rows.map((r) => {
        const shipment = shipmentByOrder.get(r.order.id) ?? null;
        return {
          ref: r.order.ref,
          itemTitle: r.itemTitle,
          itemSku: r.itemSku,
          // Категория и состояние — для строки «Lots» и кнопки «Atrast
          // līdzīgus» в раскрытой карточке покупки.
          itemCategory: r.itemCategory,
          itemCondition: r.itemCondition,
          hammerCents: r.order.hammerCents,
          premiumCents: r.order.premiumCents,
          vatCents: r.order.vatCents,
          // Ставка и режим НДС — аналитике (GA4) нужен vat_rate и
          // vat_scheme; reverse charge решает движок по проверке VIES.
          vatRateBp: r.order.vatRateBp,
          reverseCharge: r.order.reverseCharge,
          shippingCents: r.order.shippingCents,
          handlingCents: r.order.handlingCents,
          totalCents: r.order.totalCents,
          status: r.order.status,
          paymentDeadlineAt: r.order.paymentDeadlineAt,
          createdAt: r.order.createdAt,
          // Даты шагов «Uzvarēts → Apmaksāts» в хронологии покупки.
          paidAt: r.order.paidAt,
          fulfilment: r.order.fulfilment,
          shippingTo: r.order.shippingTo,
          shipment: shipment ? { barcode: shipment.barcode, status: shipment.status } : null,
        };
      }),
    };
  });

  // Outstanding restock fees — the reason an account is paused. Shown on the
  // account page with the amount and the order each claim came from.
  app.get("/api/public/me/fees", async (req, reply) => {
    const bidderId = requireBidder(req, reply);
    if (!bidderId) return;
    const rows = await ctx.db
      .select({
        orderRef: customerFees.orderRef,
        type: customerFees.type,
        amountCents: customerFees.amountCents,
        createdAt: customerFees.createdAt,
      })
      .from(customerFees)
      .where(and(eq(customerFees.customerId, bidderId), eq(customerFees.status, "outstanding")))
      .orderBy(desc(customerFees.createdAt));
    return {
      fees: rows,
      outstandingCents: rows.reduce((sum, f) => sum + f.amountCents, 0),
    };
  });

  // Pickup pass: the bidder's own paid, uncollected orders with the 6-digit
  // collection code + deadline (rendered as a QR on the account page).
  app.get("/api/public/me/pickup", async (req, reply) => {
    const bidderId = requireBidder(req, reply);
    if (!bidderId) return;
    const rows = await ctx.db
      .select({ order: orders, itemTitle: items.title, itemStatus: items.status })
      .from(orders)
      .innerJoin(items, eq(orders.itemId, items.id))
      .where(and(eq(orders.customerId, bidderId), eq(orders.status, "paid")))
      .orderBy(desc(orders.paidAt))
      .limit(50);
    // Талон очереди: экран «Izņemšana» показывает номер на табло и шаг
    // склада, если человек уже отметился в киоске сегодня.
    const dayKey = ctx.now().toISOString().slice(0, 10);
    const [ticket] = await ctx.db
      .select({ number: pickupTickets.number, status: pickupTickets.status, checkedInAt: pickupTickets.checkedInAt })
      .from(pickupTickets)
      .where(
        and(
          eq(pickupTickets.customerId, bidderId),
          eq(pickupTickets.dayKey, dayKey),
          inArray(pickupTickets.status, ["waiting", "picking", "delivering"]),
        ),
      )
      .orderBy(desc(pickupTickets.checkedInAt))
      .limit(1);
    let queueAhead = 0;
    if (ticket && ticket.status === "waiting") {
      const ahead = await ctx.db
        .select({ id: pickupTickets.id })
        .from(pickupTickets)
        .where(
          and(
            eq(pickupTickets.dayKey, dayKey),
            eq(pickupTickets.status, "waiting"),
            lt(pickupTickets.number, ticket.number),
          ),
        );
      queueAhead = ahead.length;
    }

    return {
      pickup: rows
        .filter((r) => r.itemStatus === "paid" || r.itemStatus === "picking")
        .map((r) => ({
          ref: r.order.ref,
          itemTitle: r.itemTitle,
          pickupCode: r.order.pickupCode,
          pickupDeadlineAt: r.order.pickupDeadlineAt,
          collecting: r.itemStatus === "picking",
        })),
      ticket: ticket ? { number: ticket.number, status: ticket.status, queueAhead } : null,
    };
  });

  /** Лента «Brīdinājumi»: собственные уведомления солиста — что и когда мы
   *  ему отправляли (перебит ставкой, выиграл, счёт, напоминание). Только
   *  чтение: это журнал, а не настройка. */
  app.get("/api/public/me/notifications", async (req, reply) => {
    const bidderId = requireBidder(req, reply);
    if (!bidderId) return;
    const rows = await ctx.db
      .select({
        id: notifications.id,
        type: notifications.type,
        subject: notifications.subject,
        body: notifications.body,
        status: notifications.status,
        createdAt: notifications.createdAt,
      })
      .from(notifications)
      .where(eq(notifications.customerId, bidderId))
      .orderBy(desc(notifications.createdAt))
      .limit(50);
    return {
      notifications: rows.map((n) => ({
        id: n.id,
        type: n.type,
        subject: n.subject,
        // Первая строка письма — как краткий текст в ленте.
        body: n.body.split("\n").find((l) => l.trim().length > 0) ?? "",
        createdAt: n.createdAt,
      })),
    };
  });

  /** «Manas piegādes» на экране izņemšanas: посылки человека по перевозчикам
   *  с последним событием — едет, ждёт в пакомате, забрана, вернулась. */
  app.get("/api/public/me/shipments", async (req, reply) => {
    const bidderId = requireBidder(req, reply);
    if (!bidderId) return;
    const rows = await ctx.db
      .select({ shipment: shipments, orderRef: orders.ref, itemTitle: items.title })
      .from(shipments)
      .innerJoin(orders, eq(shipments.orderId, orders.id))
      .innerJoin(items, eq(orders.itemId, items.id))
      .where(eq(orders.customerId, bidderId))
      .orderBy(desc(shipments.createdAt))
      .limit(50);
    return {
      shipments: rows.map((r) => ({
        ref: r.orderRef,
        itemTitle: r.itemTitle,
        provider: r.shipment.provider,
        barcode: r.shipment.barcode,
        status: r.shipment.status,
        providerStatus: r.shipment.providerStatus,
        lastEvent: r.shipment.events[0] ?? null,
        createdAt: r.shipment.createdAt,
      })),
    };
  });

  // ── Fixed-price "buy it now" ───────────────────────────────────────────────

  function publicListing(row: {
    listing: typeof listings.$inferSelect;
    item: typeof items.$inferSelect;
  }) {
    const { listing, item } = row;
    return {
      id: listing.id,
      title: listing.title,
      description: listing.description,
      sku: item.sku,
      condition: item.condition,
      conditionNotes: item.conditionNotes,
      category: item.category,
      photos: item.photos,
      marketCode: listing.marketCode,
      priceCents: listing.priceCents,
      quantity: listing.quantity,
    };
  }

  app.get("/api/public/listings", async (req) => {
    const q = req.query as { market?: string; q?: string; category?: string; limit?: string; offset?: string };
    const conds = [
      eq(listings.type, "fixed"),
      eq(listings.status, "published"),
      gt(listings.quantity, 0),
      eq(items.status, "listed"),
    ];
    if (q.market) conds.push(eq(listings.marketCode, q.market.toUpperCase()));
    if (q.category) conds.push(eq(items.category, q.category));
    if (q.q && q.q.trim().length >= 2) conds.push(ilike(listings.title, `%${q.q.trim()}%`));
    const { limit, offset } = pageParams(q);
    const rows = await ctx.db
      .select({ listing: listings, item: items })
      .from(listings)
      .innerJoin(items, eq(listings.itemId, items.id))
      .where(and(...conds))
      .orderBy(desc(listings.createdAt))
      .limit(limit + 1)
      .offset(offset);
    return { listings: rows.slice(0, limit).map(publicListing), hasMore: rows.length > limit };
  });

  app.get("/api/public/listings/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const [row] = await ctx.db
      .select({ listing: listings, item: items })
      .from(listings)
      .innerJoin(items, eq(listings.itemId, items.id))
      .where(eq(listings.id, id));
    // Serve published (buyable) and archived (sold) fixed listings so a shared
    // link shows "sold out" rather than 404; drafts stay hidden.
    if (!row || row.listing.type !== "fixed" || row.listing.status === "draft") {
      return reply.code(404).send({ error: "not_found" });
    }
    const soldOut = row.listing.status !== "published" || row.item.status !== "listed";
    // Цена — финальная: комиссия и НДС внутри, итог равен витринной цене.
    const estimatedTotalCents = row.listing.priceCents ?? 0;
    return { listing: { ...publicListing(row), soldOut, estimatedTotalCents } };
  });


  // ═══ ПОДТВЕРЖДЕНИЕ ПОЧТЫ (№ 14/15) ═══════════════════════════════════════

  const VERIFY_TTL_MS = 24 * 3600 * 1000;

  app.post("/api/public/auth/verify-email", async (req, reply) => {
    const body = z.object({ token: z.string().min(20) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body" });
    const [c] = await ctx.db
      .select({ id: customers.id, sentAt: customers.emailVerifySentAt, verifiedAt: customers.emailVerifiedAt })
      .from(customers)
      .where(eq(customers.emailVerifyTokenHash, sha256(body.data.token)));
    if (!c) return reply.code(401).send({ error: "invalid_or_expired_token" });
    if (c.verifiedAt !== null) return { ok: true };
    if (!c.sentAt || ctx.now().getTime() - c.sentAt.getTime() > VERIFY_TTL_MS) {
      return reply.code(401).send({ error: "invalid_or_expired_token" });
    }
    await ctx.db
      .update(customers)
      .set({ emailVerifiedAt: ctx.now(), emailVerifyTokenHash: null })
      .where(eq(customers.id, c.id));
    return { ok: true };
  });

  app.post("/api/public/auth/verify-email/resend", async (req, reply) => {
    // Либо по токену сессии, либо по адресу — но ответ всегда ровный «ok»,
    // чтобы по нему нельзя было проверять, существует ли адрес.
    const body = z.object({ email: z.string().email().optional() }).safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "invalid_body" });
    const me = req.bidder?.sub ?? null;
    void (async () => {
      const [c] = me
        ? await ctx.db.select().from(customers).where(eq(customers.id, me))
        : body.data.email
          ? await ctx.db.select().from(customers).where(eq(customers.email, body.data.email.toLowerCase()))
          : [];
      if (!c || c.erasedAt !== null || c.emailVerifiedAt !== null) return;
      // Не чаще раза в минуту — иначе кнопкой можно заспамить чужой ящик.
      if (c.emailVerifySentAt && ctx.now().getTime() - c.emailVerifySentAt.getTime() < 60_000) return;
      await sendVerificationEmail(c);
    })().catch((err) => req.log.error({ err }, "verify-email resend failed"));
    return reply.send({ ok: true });
  });

  // ═══ АВАНС (№ 69b, 71–73) ════════════════════════════════════════════════

  app.get("/api/public/me/credit", async (req, reply) => {
    const bidderId = requireBidder(req, reply);
    if (!bidderId) return;
    const credit = await getOrCreateCredit(ctx.db, bidderId);
    const entries = await ctx.db
      .select({
        kind: creditEntries.kind,
        amountCents: creditEntries.amountCents,
        orderRef: creditEntries.orderRef,
        note: creditEntries.note,
        createdAt: creditEntries.createdAt,
      })
      .from(creditEntries)
      .where(eq(creditEntries.creditId, credit.id))
      .orderBy(desc(creditEntries.createdAt))
      .limit(50);
    return { balanceCents: credit.balanceCents, expiresAt: credit.expiresAt, entries };
  });

  /** «Atgriezt uz kontu»: остаток списывается сразу, деньги переводит
   *  бухгалтерия — заявка попадает в её очередь письмом и аудитом. */
  app.post("/api/public/me/credit/withdraw", async (req, reply) => {
    const bidderId = requireBidder(req, reply);
    if (!bidderId) return;
    try {
      const result = await ctx.db.transaction(async (tx) => {
        const credit = await getOrCreateCredit(tx, bidderId);
        if (credit.balanceCents <= 0) return { balanceCents: 0, withdrawn: 0 };
        await moveCredit(tx, bidderId, { kind: "withdrawn", amountCents: -credit.balanceCents, note: "klienta pieprasījums" }, ctx.now());
        return { balanceCents: 0, withdrawn: credit.balanceCents };
      });
      return { ok: true, ...result };
    } catch (err) {
      if (err instanceof InsufficientCreditError) return reply.code(409).send({ error: "insufficient_credit" });
      throw err;
    }
  });

  // ═══ СЕССИИ (№ 57) ═══════════════════════════════════════════════════════

  app.get("/api/public/me/sessions", async (req, reply) => {
    const bidderId = requireBidder(req, reply);
    if (!bidderId) return;
    const now = ctx.now();
    const rows = await ctx.db
      .select({
        id: customerRefreshTokens.id,
        ua: customerRefreshTokens.ua,
        ip: customerRefreshTokens.ip,
        createdAt: customerRefreshTokens.createdAt,
        lastUsedAt: customerRefreshTokens.lastUsedAt,
        expiresAt: customerRefreshTokens.expiresAt,
      })
      .from(customerRefreshTokens)
      .where(and(eq(customerRefreshTokens.customerId, bidderId), isNull(customerRefreshTokens.revokedAt), gt(customerRefreshTokens.expiresAt, now)))
      .orderBy(desc(customerRefreshTokens.lastUsedAt))
      .limit(50);
    const sid = req.bidder?.sid ?? null;
    return {
      sessions: rows.map((r) => ({
        id: r.id,
        // Полный адрес человеку не нужен, а в чужих руках вреден.
        ip: r.ip ? r.ip.replace(/\.\d+$/, ".•") : null,
        ua: r.ua,
        createdAt: r.createdAt,
        lastUsedAt: r.lastUsedAt,
        current: r.id === sid,
      })),
    };
  });

  app.delete("/api/public/me/sessions/:id", async (req, reply) => {
    const bidderId = requireBidder(req, reply);
    if (!bidderId) return;
    const { id } = req.params as { id: string };
    await ctx.db
      .update(customerRefreshTokens)
      .set({ revokedAt: ctx.now() })
      .where(and(eq(customerRefreshTokens.id, id), eq(customerRefreshTokens.customerId, bidderId)));
    return { ok: true };
  });

  /** «Iziet no visām citām ierīcēm»: гасим всё, кроме текущей сессии. */
  app.post("/api/public/me/sessions/signout-others", async (req, reply) => {
    const bidderId = requireBidder(req, reply);
    if (!bidderId) return;
    const sid = req.bidder?.sid ?? null;
    const rows = await ctx.db
      .select({ id: customerRefreshTokens.id })
      .from(customerRefreshTokens)
      .where(and(eq(customerRefreshTokens.customerId, bidderId), isNull(customerRefreshTokens.revokedAt)));
    const toRevoke = rows.filter((r) => r.id !== sid).map((r) => r.id);
    if (toRevoke.length > 0) {
      await ctx.db
        .update(customerRefreshTokens)
        .set({ revokedAt: ctx.now() })
        .where(inArray(customerRefreshTokens.id, toRevoke));
    }
    return { ok: true, revoked: toRevoke.length };
  });


  // ═══ КОНТС УН ДАТИ (№ 58): ВЫГРУЗКА И УДАЛЕНИЕ ══════════════════════════

  /** Свои данные одним файлом. Спецификация хочет ZIP на почту со ссылкой на
   *  7 дней; пока файл отдаётся сразу — это честнее, чем ждать этап с
   *  файловым хранилищем. */
  /** Откуда пришёл клиент (первое касание): utm-метки, реферер, посадочная.
   *  Пишется один раз — повторные вызовы и попытки переписать игнорируются,
   *  первое касание переписать нельзя по определению. Панель по этим меткам
   *  считает регистрации, заказы и выручку на кампанию. */
  app.post("/api/public/me/attribution", async (req, reply) => {
    const bidderId = requireBidder(req, reply);
    if (!bidderId) return;
    const short = z.string().max(120).optional();
    const body = z
      .object({
        source: short, medium: short, campaign: short, content: short, term: short,
        referrer: z.string().max(400).optional(),
        landing: z.string().max(400).optional(),
      })
      .safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "invalid_body" });
    const clean = Object.fromEntries(Object.entries(body.data).filter(([, v]) => v));
    if (Object.keys(clean).length === 0) return { ok: true };
    await ctx.db
      .update(customers)
      .set({ attribution: { ...clean, at: ctx.now().toISOString() } })
      .where(and(eq(customers.id, bidderId), isNull(customers.attribution)));
    return { ok: true };
  });

  app.get("/api/public/me/export", async (req, reply) => {
    const bidderId = requireBidder(req, reply);
    if (!bidderId) return;
    const [profile] = await ctx.db.select().from(customers).where(eq(customers.id, bidderId));
    if (!profile) return reply.code(401).send({ error: "unauthenticated" });
    const myBids = await ctx.db
      .select({ amountCents: bids.amountCents, maxCents: bids.maxCents, auto: bids.auto, outbid: bids.outbid, createdAt: bids.createdAt, auctionId: bids.auctionId })
      .from(bids)
      .where(eq(bids.customerId, bidderId));
    const myOrders = await ctx.db.select().from(orders).where(eq(orders.customerId, bidderId));
    const myConsents = await ctx.db.select().from(cookieConsents).where(eq(cookieConsents.customerId, bidderId));
    const myNotifications = await ctx.db
      .select({ type: notifications.type, subject: notifications.subject, createdAt: notifications.createdAt })
      .from(notifications)
      .where(eq(notifications.customerId, bidderId));
    const data = {
      exportedAt: ctx.now().toISOString(),
      profile: {
        email: profile.email, alias: profile.alias, name: profile.name, country: profile.country,
        company: profile.company, vatNo: profile.vatNo,
        marketingOptIn: profile.marketingOptIn, marketingOptInAt: profile.marketingOptInAt,
        emailVerifiedAt: profile.emailVerifiedAt, createdAt: profile.createdAt,
      },
      bids: myBids,
      orders: myOrders.map((o) => ({
        ref: o.ref, status: o.status, totalCents: o.totalCents, hammerCents: o.hammerCents,
        premiumCents: o.premiumCents, vatCents: o.vatCents, shippingCents: o.shippingCents,
        creditAppliedCents: o.creditAppliedCents, createdAt: o.createdAt, paidAt: o.paidAt,
      })),
      cookieConsents: myConsents,
      notifications: myNotifications,
    };
    return reply
      .type("application/json")
      .header("content-disposition", 'attachment; filename="izsoli-mani-dati.json"')
      .send(JSON.stringify(data, null, 2));
  });

  /** Удаление аккаунта (№ 58). Блокеры считаются по живым данным; сам
   *  профиль обезличивается — счета и сделки закон велит хранить 5 лет,
   *  и у заказов для этого есть снимки customerAlias/customerEmail. */
  app.post("/api/public/me/delete", async (req, reply) => {
    const bidderId = requireBidder(req, reply);
    if (!bidderId) return;

    const liveBidRows = await ctx.db
      .select({ id: bids.id })
      .from(bids)
      .innerJoin(auctions, eq(bids.auctionId, auctions.id))
      .where(and(eq(bids.customerId, bidderId), eq(auctions.status, "live"), isNull(bids.voidedAt)));
    const unpaidRows = await ctx.db
      .select({ id: orders.id })
      .from(orders)
      .where(and(eq(orders.customerId, bidderId), eq(orders.status, "awaiting_payment")));
    const uncollectedRows = await ctx.db
      .select({ id: orders.id })
      .from(orders)
      .innerJoin(items, eq(orders.itemId, items.id))
      .where(and(eq(orders.customerId, bidderId), eq(orders.status, "paid"), inArray(items.status, ["paid", "picking"])));
    const credit = await getOrCreateCredit(ctx.db, bidderId);

    const blockers = {
      liveBids: liveBidRows.length,
      unpaidOrders: unpaidRows.length,
      uncollected: uncollectedRows.length,
      creditCents: credit.balanceCents,
    };
    if (blockers.liveBids > 0 || blockers.unpaidOrders > 0 || blockers.uncollected > 0 || blockers.creditCents > 0) {
      return reply.code(409).send({ error: "deletion_blocked", blockers });
    }

    const shortId = bidderId.slice(0, 8);
    await ctx.db.transaction(async (tx) => {
      await tx
        .update(customers)
        .set({
          alias: `dzests-${shortId}`,
          email: `erased-${shortId}@izsoli.invalid`,
          name: null,
          company: null,
          vatNo: null,
          passwordHash: null,
          googleId: null,
          facebookId: null,
          telegramId: null,
          marketingOptIn: false,
          marketingOptOutAt: ctx.now(),
          emailVerifiedAt: null,
          emailVerifyTokenHash: null,
          erasedAt: ctx.now(),
        })
        .where(eq(customers.id, bidderId));
      await tx
        .update(customerRefreshTokens)
        .set({ revokedAt: ctx.now() })
        .where(eq(customerRefreshTokens.customerId, bidderId));
    });
    return { ok: true };
  });

  // ═══ МАТРИЦА УВЕДОМЛЕНИЙ (№ 60) ══════════════════════════════════════════

  const PREF_EVENTS = ["outbid", "ending", "watchlist", "marketing"] as const;

  app.get("/api/public/me/notification-prefs", async (req, reply) => {
    const bidderId = requireBidder(req, reply);
    if (!bidderId) return;
    const rows = await ctx.db
      .select()
      .from(notificationPrefs)
      .where(eq(notificationPrefs.customerId, bidderId));
    const byEvent = new Map(rows.map((r) => [r.event, r]));
    return {
      prefs: PREF_EVENTS.map((event) => {
        const r = byEvent.get(event);
        return { event, email: r?.email ?? true, push: r?.push ?? false, telegram: r?.telegram ?? false };
      }),
    };
  });

  app.put("/api/public/me/notification-prefs", async (req, reply) => {
    const bidderId = requireBidder(req, reply);
    if (!bidderId) return;
    const body = z
      .object({
        event: z.enum(PREF_EVENTS),
        email: z.boolean().optional(),
        push: z.boolean().optional(),
        telegram: z.boolean().optional(),
      })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body" });
    const patch = {
      ...(body.data.email !== undefined ? { email: body.data.email } : {}),
      ...(body.data.push !== undefined ? { push: body.data.push } : {}),
      ...(body.data.telegram !== undefined ? { telegram: body.data.telegram } : {}),
      updatedAt: ctx.now(),
    };
    await ctx.db
      .insert(notificationPrefs)
      .values({ customerId: bidderId, event: body.data.event, email: true, ...patch })
      .onConflictDoUpdate({ target: [notificationPrefs.customerId, notificationPrefs.event], set: patch });
    return { ok: true };
  });

  // ═══ ДОКУМЕНТЫ: СЧЁТ И ЧЕК (№ 34/41) ═════════════════════════════════════

  /** Свой счёт по заказу — снимок из invoices, никаких пересчётов. */
  async function ownInvoice(bidderId: string, ref: string) {
    const [row] = await ctx.db
      .select({ invoice: invoices, order: orders })
      .from(invoices)
      .innerJoin(orders, eq(invoices.orderId, orders.id))
      .where(and(eq(orders.ref, ref), eq(orders.customerId, bidderId), isNull(invoices.voidedAt)));
    return row ?? null;
  }

  app.get("/api/public/me/orders/:ref/invoice.pdf", async (req, reply) => {
    const bidderId = requireBidder(req, reply);
    if (!bidderId) return;
    const { ref } = req.params as { ref: string };
    const row = await ownInvoice(bidderId, ref);
    if (!row) return reply.code(404).send({ error: "not_found" });
    const pdf = await renderInvoicePdf(row.invoice.number, row.invoice.issuedAt, row.invoice.data as unknown as InvoiceData);
    return reply
      .type("application/pdf")
      .header("content-disposition", `inline; filename="rekins-${row.invoice.number}.pdf"`)
      .send(pdf);
  });

  app.get("/api/public/me/orders/:ref/invoice", async (req, reply) => {
    const bidderId = requireBidder(req, reply);
    if (!bidderId) return;
    const { ref } = req.params as { ref: string };
    const row = await ownInvoice(bidderId, ref);
    if (!row) return reply.code(404).send({ error: "not_found" });
    return reply.type("text/html").send(renderInvoiceHtml(row.invoice.number, row.invoice.issuedAt, row.invoice.data as unknown as InvoiceData));
  });

  /** Чек после оплаты (№ 35/41): заказ, лот, способ, ID платежа, код выдачи. */
  app.get("/api/public/me/orders/:ref/receipt", async (req, reply) => {
    const bidderId = requireBidder(req, reply);
    if (!bidderId) return;
    const { ref } = req.params as { ref: string };
    const [row] = await ctx.db
      .select({ order: orders, itemTitle: items.title, itemSku: items.sku })
      .from(orders)
      .innerJoin(items, eq(orders.itemId, items.id))
      .where(and(eq(orders.ref, ref), eq(orders.customerId, bidderId)));
    if (!row || row.order.status !== "paid") return reply.code(404).send({ error: "not_found" });
    const [payment] = await ctx.db
      .select({ provider: payments.provider, method: payments.method, providerId: payments.providerId, status: payments.status, createdAt: payments.createdAt })
      .from(payments)
      .where(and(eq(payments.orderId, row.order.id), eq(payments.status, "paid")))
      .orderBy(desc(payments.createdAt))
      .limit(1);
    const [invoice] = await ctx.db
      .select({ number: invoices.number })
      .from(invoices)
      .where(and(eq(invoices.orderId, row.order.id), isNull(invoices.voidedAt)));
    return {
      ref: row.order.ref,
      itemTitle: row.itemTitle,
      itemSku: row.itemSku,
      hammerCents: row.order.hammerCents,
      premiumCents: row.order.premiumCents,
      vatCents: row.order.vatCents,
      shippingCents: row.order.shippingCents,
      handlingCents: row.order.handlingCents,
      creditAppliedCents: row.order.creditAppliedCents,
      totalCents: row.order.totalCents,
      paidAt: row.order.paidAt,
      fulfilment: row.order.fulfilment,
      pickupCode: row.order.pickupCode,
      pickupDeadlineAt: row.order.pickupDeadlineAt,
      invoiceNumber: invoice?.number ?? null,
      payment: payment
        ? { provider: payment.provider, method: payment.method, providerId: payment.providerId }
        : null,
    };
  });


  // ── Сохранённые поиски (макет № 80) ─────────────────────────────────────

  const searchQuerySchema = z.object({
    q: z.string().max(120).optional(),
    category: z.string().max(60).optional(),
    market: z.string().max(2).optional(),
    priceMinCents: z.number().int().min(0).optional(),
    priceMaxCents: z.number().int().min(0).optional(),
    condition: z.string().max(20).optional(),
    noReserve: z.boolean().optional(),
  });

  app.get("/api/public/me/searches", async (req, reply) => {
    const bidderId = requireBidder(req, reply);
    if (!bidderId) return;
    const rows = await ctx.db
      .select()
      .from(savedSearches)
      .where(eq(savedSearches.customerId, bidderId))
      .orderBy(desc(savedSearches.createdAt));
    return { searches: rows };
  });

  app.post("/api/public/me/searches", async (req, reply) => {
    const bidderId = requireBidder(req, reply);
    if (!bidderId) return;
    const body = z
      .object({ name: z.string().min(1).max(80), query: searchQuerySchema, alertEmail: z.boolean().default(false) })
      .safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "invalid_body", detail: body.error.flatten() });

    // Двадцати запросов хватает любому: дальше это уже не поиск, а свалка.
    const mine = await ctx.db
      .select({ id: savedSearches.id })
      .from(savedSearches)
      .where(eq(savedSearches.customerId, bidderId));
    if (mine.length >= 20) return reply.code(409).send({ error: "too_many" });

    const [row] = await ctx.db
      .insert(savedSearches)
      .values({ customerId: bidderId, name: body.data.name.trim(), query: body.data.query, alertEmail: body.data.alertEmail })
      .returning();
    return { search: row };
  });

  app.patch("/api/public/me/searches/:id", async (req, reply) => {
    const bidderId = requireBidder(req, reply);
    if (!bidderId) return;
    const { id } = req.params as { id: string };
    const body = z
      .object({ name: z.string().min(1).max(80).optional(), alertEmail: z.boolean().optional() })
      .safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    const [row] = await ctx.db
      .update(savedSearches)
      .set({
        ...(body.data.name !== undefined ? { name: body.data.name.trim() } : {}),
        ...(body.data.alertEmail !== undefined ? { alertEmail: body.data.alertEmail } : {}),
      })
      .where(and(eq(savedSearches.id, id), eq(savedSearches.customerId, bidderId)))
      .returning();
    if (!row) return reply.code(404).send({ error: "not_found" });
    return { search: row };
  });

  app.delete("/api/public/me/searches/:id", async (req, reply) => {
    const bidderId = requireBidder(req, reply);
    if (!bidderId) return;
    const { id } = req.params as { id: string };
    const rows = await ctx.db
      .delete(savedSearches)
      .where(and(eq(savedSearches.id, id), eq(savedSearches.customerId, bidderId)))
      .returning({ id: savedSearches.id });
    if (!rows.length) return reply.code(404).send({ error: "not_found" });
    return { ok: true };
  });

  // ── Реквизиты для счёта: себе или своей фирме (макеты № 42–45, 81) ──────

  /** Схема профиля. Фирме обязателен рег. номер — без него счёт недействителен. */
  const billingSchema = z
    .object({
      kind: z.enum(["person", "company"]),
      name: z.string().min(2).max(160),
      regNo: z.string().max(32).default(""),
      vatNo: z.string().max(24).default(""),
      address: z.string().max(200).default(""),
      city: z.string().max(80).default(""),
      zip: z.string().max(16).default(""),
      country: z.string().min(2).max(2).default("LV"),
      invoiceEmail: z.string().email().max(160).or(z.literal("")).default(""),
      isDefault: z.boolean().default(false),
    })
    .refine((v) => v.kind === "person" || v.regNo.trim().length >= 4, {
      path: ["regNo"],
      message: "reg_no_required",
    })
    .refine((v) => v.kind === "person" || (v.address.trim() !== "" && v.city.trim() !== ""), {
      path: ["address"],
      message: "address_required",
    });

  app.get("/api/public/me/billing-profiles", async (req, reply) => {
    const bidderId = requireBidder(req, reply);
    if (!bidderId) return;
    const rows = await ctx.db
      .select()
      .from(billingProfiles)
      .where(and(eq(billingProfiles.customerId, bidderId), isNull(billingProfiles.archivedAt)))
      .orderBy(desc(billingProfiles.isDefault), asc(billingProfiles.createdAt));
    return { profiles: rows };
  });

  app.post("/api/public/me/billing-profiles", async (req, reply) => {
    const bidderId = requireBidder(req, reply);
    if (!bidderId) return;
    const body = billingSchema.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "invalid_body", detail: body.error.flatten() });

    const created = await ctx.db.transaction(async (tx) => {
      const existing = await tx
        .select({ id: billingProfiles.id })
        .from(billingProfiles)
        .where(and(eq(billingProfiles.customerId, bidderId), isNull(billingProfiles.archivedAt)));
      // Первый профиль становится основным сам: выбирать не из чего.
      const makeDefault = body.data.isDefault || existing.length === 0;
      if (makeDefault) {
        await tx
          .update(billingProfiles)
          .set({ isDefault: false })
          .where(eq(billingProfiles.customerId, bidderId));
      }
      const [row] = await tx
        .insert(billingProfiles)
        .values({ ...body.data, customerId: bidderId, isDefault: makeDefault })
        .returning();
      return row!;
    });
    return { profile: created };
  });

  app.patch("/api/public/me/billing-profiles/:id", async (req, reply) => {
    const bidderId = requireBidder(req, reply);
    if (!bidderId) return;
    const { id } = req.params as { id: string };
    const body = billingSchema.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "invalid_body", detail: body.error.flatten() });

    const updated = await ctx.db.transaction(async (tx) => {
      const [own] = await tx
        .select({ id: billingProfiles.id })
        .from(billingProfiles)
        .where(and(eq(billingProfiles.id, id), eq(billingProfiles.customerId, bidderId), isNull(billingProfiles.archivedAt)));
      if (!own) return null;
      if (body.data.isDefault) {
        await tx.update(billingProfiles).set({ isDefault: false }).where(eq(billingProfiles.customerId, bidderId));
      }
      const [row] = await tx
        .update(billingProfiles)
        .set({ ...body.data })
        .where(eq(billingProfiles.id, id))
        .returning();
      return row!;
    });
    if (!updated) return reply.code(404).send({ error: "not_found" });
    return { profile: updated };
  });

  /** Профиль не удаляем физически: на него могут ссылаться выданные счета. */
  app.delete("/api/public/me/billing-profiles/:id", async (req, reply) => {
    const bidderId = requireBidder(req, reply);
    if (!bidderId) return;
    const { id } = req.params as { id: string };
    const [own] = await ctx.db
      .select({ id: billingProfiles.id, isDefault: billingProfiles.isDefault })
      .from(billingProfiles)
      .where(and(eq(billingProfiles.id, id), eq(billingProfiles.customerId, bidderId), isNull(billingProfiles.archivedAt)));
    if (!own) return reply.code(404).send({ error: "not_found" });
    await ctx.db.update(billingProfiles).set({ archivedAt: ctx.now(), isDefault: false }).where(eq(billingProfiles.id, id));
    if (own.isDefault) {
      const [next] = await ctx.db
        .select({ id: billingProfiles.id })
        .from(billingProfiles)
        .where(and(eq(billingProfiles.customerId, bidderId), isNull(billingProfiles.archivedAt)))
        .orderBy(asc(billingProfiles.createdAt))
        .limit(1);
      if (next) await ctx.db.update(billingProfiles).set({ isDefault: true }).where(eq(billingProfiles.id, next.id));
    }
    return { ok: true };
  });

  /** Выбрать реквизиты для конкретного неоплаченного заказа (макет № 42). */
  app.post("/api/public/me/orders/:ref/billing", async (req, reply) => {
    const bidderId = requireBidder(req, reply);
    if (!bidderId) return;
    const { ref } = req.params as { ref: string };
    const body = z.object({ profileId: z.string().uuid() }).safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "bad_request" });

    const [order] = await ctx.db
      .select({ id: orders.id, status: orders.status })
      .from(orders)
      .where(and(eq(orders.ref, ref), eq(orders.customerId, bidderId)));
    if (!order) return reply.code(404).send({ error: "not_found" });
    if (order.status !== "awaiting_payment") return reply.code(409).send({ error: "not_editable" });

    const [profile] = await ctx.db
      .select()
      .from(billingProfiles)
      .where(and(eq(billingProfiles.id, body.data.profileId), eq(billingProfiles.customerId, bidderId), isNull(billingProfiles.archivedAt)));
    if (!profile) return reply.code(404).send({ error: "profile_not_found" });

    await ctx.db
      .update(orders)
      .set({
        billingProfileId: profile.id,
        billingSnapshot: {
          kind: profile.kind, name: profile.name, regNo: profile.regNo, vatNo: profile.vatNo,
          address: profile.address, city: profile.city, zip: profile.zip,
          country: profile.country, invoiceEmail: profile.invoiceEmail,
        },
      })
      .where(eq(orders.id, order.id));
    return { ok: true };
  });

  /**
   * Заказ целиком — экран статуса оплаты (макеты № 64, 65, 67, 68, 69, 70).
   * Отдаём всё, из чего экран собирает своё состояние: суммы, срок, платежи,
   * накопленную плату за хранение, открытую заявку на возврат и возвраты денег.
   * Считает сервер: клиент ничего не пересчитывает.
   */
  app.get("/api/public/me/orders/:ref", async (req, reply) => {
    const bidderId = requireBidder(req, reply);
    if (!bidderId) return;
    const { ref } = req.params as { ref: string };
    const [row] = await ctx.db
      .select({ order: orders, itemTitle: items.title, itemSku: items.sku, itemCategory: items.category })
      .from(orders)
      .innerJoin(items, eq(orders.itemId, items.id))
      .where(and(eq(orders.ref, ref), eq(orders.customerId, bidderId)));
    if (!row) return reply.code(404).send({ error: "not_found" });

    const [lastPayment] = await ctx.db
      .select({ status: payments.status, method: payments.method, provider: payments.provider, createdAt: payments.createdAt })
      .from(payments)
      .where(eq(payments.orderId, row.order.id))
      .orderBy(desc(payments.createdAt))
      .limit(1);

    /** Сколько денег реально дошло: по этому числу экран решает, недоплата
     *  это (макет № 69) или переплата (№ 69b). Клиент не считает ничего. */
    const settledRows = await ctx.db
      .select({ amountCents: payments.amountCents })
      .from(payments)
      .where(and(eq(payments.orderId, row.order.id), eq(payments.status, "paid")));
    const paidCents = settledRows.reduce((sum, p) => sum + p.amountCents, 0);

    const feeRows = await ctx.db
      .select({ type: customerFees.type, amountCents: customerFees.amountCents, createdAt: customerFees.createdAt })
      .from(customerFees)
      .where(and(eq(customerFees.orderRef, ref), eq(customerFees.customerId, bidderId)));
    const feesCents = feeRows.reduce((sum, f) => sum + f.amountCents, 0);

    const [openReturn] = await ctx.db
      .select({ ref: returnCases.ref, status: returnCases.status, reason: returnCases.reason,
                decision: returnCases.decision, refundCents: returnCases.refundCents, createdAt: returnCases.createdAt })
      .from(returnCases)
      .where(eq(returnCases.orderId, row.order.id))
      .orderBy(desc(returnCases.createdAt))
      .limit(1);

    const refundRows = await ctx.db
      .select({ amountCents: refunds.amountCents, reason: refunds.reason, createdAt: refunds.createdAt })
      .from(refunds)
      .where(eq(refunds.orderId, row.order.id))
      .orderBy(desc(refunds.createdAt));

    const [invoice] = await ctx.db
      .select({ number: invoices.number, issuedAt: invoices.issuedAt })
      .from(invoices)
      .where(and(eq(invoices.orderId, row.order.id), isNull(invoices.voidedAt)));

    /** Последняя посылка: по её статусу экран показывает «не забрали»
     *  и предлагает повторную отправку либо возврат денег (макет № 77). */
    const [shipment] = await ctx.db
      .select({ provider: shipments.provider, barcode: shipments.barcode, status: shipments.status,
                providerStatus: shipments.providerStatus, createdAt: shipments.createdAt })
      .from(shipments)
      .where(eq(shipments.orderId, row.order.id))
      .orderBy(desc(shipments.createdAt))
      .limit(1);

    const deadline = row.order.paymentDeadlineAt;
    const lateDays = deadline && row.order.status === "awaiting_payment"
      ? Math.max(0, Math.floor((Date.now() - new Date(deadline).getTime()) / 86_400_000))
      : 0;

    return {
      ref: row.order.ref,
      itemTitle: row.itemTitle,
      itemSku: row.itemSku,
      itemCategory: row.itemCategory,
      hammerCents: row.order.hammerCents,
      premiumCents: row.order.premiumCents,
      vatCents: row.order.vatCents,
      shippingCents: row.order.shippingCents,
      handlingCents: row.order.handlingCents,
      creditAppliedCents: row.order.creditAppliedCents,
      totalCents: row.order.totalCents,
      status: row.order.status,
      fulfilment: row.order.fulfilment,
      shippingTo: row.order.shippingTo,
      insuranceCents: row.order.insuranceCents,
      pickupProxyName: row.order.pickupProxyName,
      recipientPhone: row.order.recipientPhone,
      paymentDeadlineAt: deadline,
      paidAt: row.order.paidAt,
      pickupCode: row.order.pickupCode,
      pickupDeadlineAt: row.order.pickupDeadlineAt,
      createdAt: row.order.createdAt,
      lateDays,
      paidCents,
      feesCents,
      fees: feeRows,
      lastPayment: lastPayment ?? null,
      invoice: invoice ? { number: invoice.number, issuedAt: invoice.issuedAt } : null,
      shipment: shipment ?? null,
      returnCase: openReturn ?? null,
      refunds: refundRows,
    };
  });

  /**
   * Продление срока оплаты (макет № 67). Даём один раз и без вопросов —
   * так и написано клиенту на экране. Повтор ловим по журналу.
   */
  app.post("/api/public/me/orders/:ref/extend", async (req, reply) => {
    const bidderId = requireBidder(req, reply);
    if (!bidderId) return;
    const { ref } = req.params as { ref: string };
    const [row] = await ctx.db
      .select({ id: orders.id, status: orders.status, deadline: orders.paymentDeadlineAt })
      .from(orders)
      .where(and(eq(orders.ref, ref), eq(orders.customerId, bidderId)));
    if (!row) return reply.code(404).send({ error: "not_found" });
    if (row.status !== "awaiting_payment") return reply.code(409).send({ error: "not_payable" });

    const used = await ctx.db
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(and(eq(auditLog.type, "order"), eq(auditLog.target, ref), eq(auditLog.action, "payment_extended")))
      .limit(1);
    if (used.length) return reply.code(409).send({ error: "already_extended" });

    const base = row.deadline && new Date(row.deadline).getTime() > Date.now() ? new Date(row.deadline) : new Date();
    const next = new Date(base.getTime() + 7 * 86_400_000);
    await ctx.db.update(orders).set({ paymentDeadlineAt: next }).where(eq(orders.id, row.id));
    await ctx.db.insert(auditLog).values({
      type: "order", target: ref, action: "payment_extended",
      actorLabel: "buyer", detail: { orderId: row.id, until: next.toISOString() },
    });
    return { paymentDeadlineAt: next.toISOString() };
  });

  /**
   * Забирает другой человек (макет № 76). Имя показывается на стойке рядом
   * с кодом выдачи; доверенность не нужна — код и есть допуск.
   */
  app.post("/api/public/me/orders/:ref/proxy", async (req, reply) => {
    const bidderId = requireBidder(req, reply);
    if (!bidderId) return;
    const { ref } = req.params as { ref: string };
    const body = z.object({ name: z.string().max(120) }).safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "bad_request" });

    const [row] = await ctx.db
      .select({ id: orders.id, status: orders.status, fulfilment: orders.fulfilment })
      .from(orders)
      .where(and(eq(orders.ref, ref), eq(orders.customerId, bidderId)));
    if (!row) return reply.code(404).send({ error: "not_found" });
    if (row.fulfilment !== "pickup" || row.status !== "paid") {
      return reply.code(409).send({ error: "not_collectable" });
    }
    const name = body.data.name.trim();
    await ctx.db.update(orders).set({ pickupProxyName: name }).where(eq(orders.id, row.id));
    await ctx.db.insert(auditLog).values({
      type: "order", target: ref, action: name ? "pickup_proxy_set" : "pickup_proxy_cleared",
      actorLabel: "buyer", detail: { orderId: row.id, name },
    });
    return { pickupProxyName: name };
  });

  /**
   * Посылка вернулась на склад — покупатель просит отправить её повторно
   * (макет № 77b). Повторная отправка платная: заводим счёт в customer_fees,
   * а сам ярлык печатает склад, когда деньги придут.
   */
  app.post("/api/public/me/orders/:ref/reship", async (req, reply) => {
    const bidderId = requireBidder(req, reply);
    if (!bidderId) return;
    const { ref } = req.params as { ref: string };
    const [row] = await ctx.db
      .select({ id: orders.id, status: orders.status, marketCode: orders.marketCode, fulfilment: orders.fulfilment })
      .from(orders)
      .where(and(eq(orders.ref, ref), eq(orders.customerId, bidderId)));
    if (!row) return reply.code(404).send({ error: "not_found" });
    if (row.status !== "paid" || row.fulfilment === "pickup") return reply.code(409).send({ error: "not_shippable" });

    const [ship] = await ctx.db
      .select({ status: shipments.status })
      .from(shipments)
      .where(eq(shipments.orderId, row.id))
      .orderBy(desc(shipments.createdAt))
      .limit(1);
    if (!ship || (ship.status !== "returned" && ship.status !== "unclaimed")) {
      return reply.code(409).send({ error: "not_returned" });
    }

    const existing = await ctx.db
      .select({ id: customerFees.id })
      .from(customerFees)
      .where(and(eq(customerFees.orderId, row.id), eq(customerFees.type, "reship"), eq(customerFees.status, "outstanding")))
      .limit(1);
    if (existing.length) return reply.code(409).send({ error: "already_requested" });

    const [market] = await ctx.db.select().from(markets).where(eq(markets.code, row.marketCode));
    const amountCents = market?.courierPriceCents ?? 690;
    await ctx.db.insert(customerFees).values({
      customerId: bidderId, orderId: row.id, orderRef: ref, type: "reship",
      amountCents, note: "buyer requested reshipment",
    });
    await ctx.db.insert(auditLog).values({
      type: "order", target: ref, action: "reship_requested",
      actorLabel: "buyer", detail: { orderId: row.id, amountCents },
    });
    return { amountCents };
  });

  /**
   * Заявка на возврат в течение 14 дней (макет № 68). Решение принимает
   * склад в панели — здесь только регистрируем обращение покупателя.
   */
  app.post("/api/public/me/orders/:ref/return", async (req, reply) => {
    const bidderId = requireBidder(req, reply);
    if (!bidderId) return;
    const { ref } = req.params as { ref: string };
    const body = z
      .object({
        reason: z.enum(["not_as_described", "damaged", "changed_mind", "other"]),
        note: z.string().max(2000).optional(),
      })
      .safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "bad_request" });

    const [row] = await ctx.db
      .select({ order: orders, alias: customers.alias })
      .from(orders)
      .innerJoin(customers, eq(orders.customerId, customers.id))
      .where(and(eq(orders.ref, ref), eq(orders.customerId, bidderId)));
    if (!row || row.order.status !== "paid") return reply.code(404).send({ error: "not_found" });

    const existing = await ctx.db
      .select({ id: returnCases.id })
      .from(returnCases)
      .where(and(eq(returnCases.orderId, row.order.id), eq(returnCases.status, "open")))
      .limit(1);
    if (existing.length) return reply.code(409).send({ error: "already_open" });

    const paidAt = row.order.paidAt ? new Date(row.order.paidAt).getTime() : Date.now();
    const withinWindow = Date.now() - paidAt <= 14 * 86_400_000;

    const caseRef = await ctx.db.transaction(async (tx) => {
      await tx.insert(counters).values({ key: "return_case", value: 0 }).onConflictDoNothing();
      const [seq] = await tx
        .update(counters)
        .set({ value: sql`${counters.value} + 1` })
        .where(eq(counters.key, "return_case"))
        .returning({ value: counters.value });
      const nextRef = `RET-${String(seq!.value).padStart(4, "0")}`;
      await tx.insert(returnCases).values({
        ref: nextRef,
        orderId: row.order.id,
        orderRef: row.order.ref,
        itemId: row.order.itemId,
        customerId: bidderId,
        customerAlias: row.alias,
        reason: body.data.reason,
        note: body.data.note ?? "",
        withinWindow,
        openedByLabel: "buyer",
      });
      return nextRef;
    });

    return { ref: caseRef, withinWindow };
  });

  app.post("/api/public/listings/:id/buy", async (req, reply) => {
    const bidderId = requireBidder(req, reply);
    if (!bidderId) return;
    if (!(await requireVerifiedEmail(bidderId, reply))) return;
    const { id } = req.params as { id: string };
    const result = await buyNow(ctx, { listingId: id, customerId: bidderId });
    if (!result.ok) {
      const status = result.code === "LISTING_NOT_FOUND" ? 404 : result.code === "NOT_AVAILABLE" ? 409 : 422;
      return reply.code(status).send(result);
    }
    return result;
  });
}
