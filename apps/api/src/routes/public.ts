import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  auctions,
  affiliates,
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
  loyaltyLedger,
  payments,
  pickupTickets,
  referralCodes,
  referrals,
  refunds,
  returnCases,
  pushSubscriptions,
  savedSearches,
  shipments,
  userCategoryStats,
  verifyPassword,
  watchlist,
} from "@auction/db";
import { and, asc, desc, eq, gt, gte, ilike, inArray, isNull, lt, or, sql } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { signAccessToken } from "../auth/jwt.js";
import {
  createResetToken,
  findValidResetToken,
  markResetTokenUsed,
  resetRequestAllowed,
} from "../auth/passwordReset.js";
import type { AppContext } from "../context.js";
import { placeBid } from "../engine/bids.js";
import { InsufficientCreditError, getOrCreateCredit, moveCredit } from "../engine/credits.js";
import { renderInvoiceHtml, type InvoiceData } from "../engine/invoices.js";
import { renderInvoicePdf } from "../engine/invoicePdf.js";
import { companionCategory, ensureReferralCode, logUserEvent } from "../engine/growth.js";
import { redeemGiftCard } from "../engine/giftCards.js";
import { CATEGORIES } from "@auction/domain/categories";
import { getOrCreateLoyalty, movePoints, tierFor } from "../engine/loyalty.js";
import { applyUnsubscribe } from "../engine/marketing.js";
import { enqueueNotification, langFor, renderNotification, sendPasswordReset } from "../engine/notifications.js";
import { ensureWelcomeCode, extendWelcomeOnVerify, findPersonalCode } from "../engine/promo.js";
import { getSettings } from "../engine/settings.js";
import { verifyUnsubscribeToken } from "../engine/unsubscribe.js";
import { registerSocialAuthRoutes } from "./socialAuth.js";
import { buyNow } from "../engine/purchase.js";
import { heldTotal } from "../engine/reservations.js";

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

/**
 * Человеческое имя устройства для письма о безопасности: браузер и система
 * из User-Agent. Точный IP в письмо не кладём — он ничего не говорит
 * получателю и лишний раз путешествует по почте.
 */
export function deviceLabelOf(req: { headers: Record<string, unknown> } | undefined): string {
  const ua = String(req?.headers?.["user-agent"] ?? "");
  if (!ua) return "—";
  const browser = /Edg\//.test(ua) ? "Edge"
    : /OPR\//.test(ua) ? "Opera"
      : /Chrome\//.test(ua) ? "Chrome"
        : /Safari\//.test(ua) ? "Safari"
          : /Firefox\//.test(ua) ? "Firefox" : null;
  const os = /Windows/.test(ua) ? "Windows"
    : /Android/.test(ua) ? "Android"
      : /(iPhone|iPad|iOS)/.test(ua) ? "iOS"
        : /Mac OS X/.test(ua) ? "macOS"
          : /Linux/.test(ua) ? "Linux" : null;
  return [browser, os].filter(Boolean).join(" · ") || "—";
}

/** Семейство устройства: по нему решаем, знакомое оно или новое. */
const deviceFamily = (ua: string | null): string => deviceLabelOf({ headers: { "user-agent": ua ?? "" } });

export function registerPublicRoutes(app: FastifyInstance, ctx: AppContext): void {
  // ── Bidder auth ───────────────────────────────────────────────────────────

  /**
   * Выдать пару токенов и записать сессию.
   *
   * `method` — чем человек воспользовался СЕЙЧАС. Наличие googleId говорит
   * лишь, что связка когда-то создана; при разборе обращения важно другое —
   * как он входит на самом деле, потому что «не могу войти» у того, кто
   * всегда жал кнопку Google, и у того, кто помнил пароль, — разные истории.
   * Обновление токена методом не считается: это не вход.
   */
  async function issueTokens(
    customer: { id: string; email: string; alias: string },
    req?: FastifyRequest,
    method?: "password" | "google" | "facebook" | "telegram",
  ) {
    const refreshToken = randomBytes(48).toString("base64url");
    // Письмо A3 «вход с нового устройства»: смотрим ДО записи новой сессии,
    // видели ли мы уже такой браузер+систему у этого человека. Первый вход
    // после регистрации письмом не сопровождается — человек и так на сайте.
    const thisDevice = deviceLabelOf(req);
    const isNewDevice = method
      ? await (async () => {
          const seen = await ctx.db
            .select({ ua: customerRefreshTokens.ua })
            .from(customerRefreshTokens)
            .where(eq(customerRefreshTokens.customerId, customer.id))
            .limit(50);
          if (seen.length === 0) return false;
          return !seen.some((s) => deviceFamily(s.ua) === thisDevice);
        })()
      : false;
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
    if (method) {
      await ctx.db
        .update(customers)
        .set({ lastLoginMethod: method, lastLoginAt: ctx.now() })
        .where(eq(customers.id, customer.id));
    }
    if (isNewDevice) {
      await enqueueNotification(ctx, ctx.db, {
        customerId: customer.id,
        type: "security_alert",
        template: { alias: "", lotTitle: "", securityEvent: "new_device", deviceLabel: thisDevice, eventAt: ctx.now() },
        // Одно письмо на устройство в сутки: перезаход в том же браузере
        // после чистки cookie не должен слать вторую тревогу.
        dedupeKey: `security:new_device:${customer.id}:${thisDevice}:${ctx.now().toISOString().slice(0, 10)}`,
      }).catch(() => undefined);
    }
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
    // Приветственный код (IZ-P01) — сервисный блок этого же письма. Код
    // личный и до подтверждения почты бесполезен, поэтому показать его до
    // верификации безопасно, а мотивации подтвердить — больше.
    const welcome = await findPersonalCode(ctx.db, customer.id, ["welcome_auto", "referral_referred"]);
    await enqueueNotification(ctx, ctx.db, {
      customerId: customer.id,
      type: "verify_email",
      template: {
        alias: "", lotTitle: "", actionUrl: link,
        ...(welcome && welcome.usedCount === 0
          ? {
              promoCode: welcome.code,
              promoPercent: welcome.value,
              promoDeadline: welcome.validTo ?? undefined,
            }
          : {}),
      },
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
    /** Реферальный код пригласившего (из ссылки «Uzaicini draugu»). */
    ref: z.string().min(3).max(24).optional(),
    /** Код партнёра (affiliate, MD §6.7) из ссылки ?aff=CODE. */
    aff: z.string().min(3).max(24).optional(),
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

    // Реферал (MD §1.6.1): пришёл по чужой личной ссылке — фиксируем связку.
    // Совпадение IP с пригласившим — не отказ, а флаг на ручную проверку:
    // обе награды придерживаются, пока админ не решит.
    let referred = false;
    if (body.data.ref) {
      const refCode = body.data.ref.trim().toUpperCase();
      const [owner] = await ctx.db
        .select({ customerId: referralCodes.customerId })
        .from(referralCodes)
        .where(eq(referralCodes.code, refCode));
      if (owner && owner.customerId !== row.id) {
        const ip = req.ip;
        const [sameIp] = ip
          ? await ctx.db
              .select({ id: customerRefreshTokens.id })
              .from(customerRefreshTokens)
              .where(and(eq(customerRefreshTokens.customerId, owner.customerId), eq(customerRefreshTokens.ip, ip)))
              .limit(1)
          : [];
        await ctx.db
          .insert(referrals)
          .values({
            referrerCustomerId: owner.customerId,
            referredCustomerId: row.id,
            fraudFlag: !!sameIp,
          })
          .onConflictDoNothing();
        referred = true;
      }
    }
    // Партнёрская ссылка (MD §6.7): first-touch, как attribution — пишется
    // один раз; неизвестный или выключенный код тихо игнорируется.
    if (body.data.aff) {
      const [partner] = await ctx.db
        .select({ id: affiliates.id })
        .from(affiliates)
        .where(and(eq(affiliates.code, body.data.aff.trim().toUpperCase()), eq(affiliates.isActive, true)));
      if (partner) {
        try {
          await ctx.db.update(customers).set({ affiliateId: partner.id }).where(eq(customers.id, row.id));
        } catch { /* партнёрская метка не должна ломать регистрацию */ }
      }
    }
    // Приветственный код −N% на первую покупку (IZ-P01): рождается здесь,
    // уезжает в письме подтверждения; приглашённому — повышенный процент.
    await ensureWelcomeCode(ctx, ctx.db, row.id, { referred }).catch(() => undefined);

    // Письмо со ссылкой уходит сразу; до подтверждения ставки закрыты.
    await sendVerificationEmail(row);
    return issueTokens(row, req, "password");
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
    return issueTokens(customer, req, "password");
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
      await sendPasswordReset(ctx, {
        toEmail: customer.email,
        alias: customer.alias,
        lang: langFor(customer.lang, customer.country),
        link,
      });
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
    // Письмо A3: о смене пароля человек узнаёт всегда — если менял не он,
    // это единственный сигнал, что аккаунт трогали.
    await enqueueNotification(ctx, ctx.db, {
      customerId: customer.id,
      type: "security_alert",
      template: { alias: "", lotTitle: "", securityEvent: "password_changed", eventAt: ctx.now(), deviceLabel: deviceLabelOf(req) },
    }).catch(() => undefined);
    return { ok: true };
  });

  /** Ротация с поблажкой: две вкладки делят один refresh-токен, и обе,
   *  проснувшись, шлют его одновременно. Строгая ротация (мгновенный отзыв
   *  использованного токена) вторую вкладку выбрасывала из аккаунта — те
   *  самые «случайные разлогины». Поэтому использованный токен не гасится,
   *  а доживает минуту: опоздавшая вкладка успевает получить собственную
   *  свежую пару. Выход, смена пароля и «выйти везде» ставят revokedAt —
   *  для них смерть токена по-прежнему мгновенная. */
  const REFRESH_REUSE_GRACE_MS = 60_000;

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
    const graceEnd = new Date(ctx.now().getTime() + REFRESH_REUSE_GRACE_MS);
    if (row.expiresAt.getTime() > graceEnd.getTime()) {
      await ctx.db.update(customerRefreshTokens).set({ expiresAt: graceEnd }).where(eq(customerRefreshTokens.id, row.id));
    }
    return issueTokens(customer, req);
  });

  /** Выход: refresh-токен гасится в базе, а не только стирается в браузере —
   *  украденная позже копия уже ничего не откроет. Сам токен и есть пропуск,
   *  поэтому маршрут без авторизации; ответ всегда ok — чужим не сообщаем,
   *  жив ли был токен. */
  app.post("/api/public/auth/logout", async (req) => {
    const body = z.object({ refreshToken: z.string().min(10) }).safeParse(req.body);
    if (body.success) {
      await ctx.db
        .update(customerRefreshTokens)
        .set({ revokedAt: ctx.now() })
        .where(and(eq(customerRefreshTokens.tokenHash, sha256(body.data.refreshToken)), isNull(customerRefreshTokens.revokedAt)));
    }
    return { ok: true };
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
    // v15: журнал поведения — просмотр лота вошедшим (write-only, мимо UI).
    if (me) logUserEvent(ctx, { customerId: me, eventType: "view_lot", category: row.item.category, listingId: row.listing.id });
    const iLead = me !== null && row.auction.leaderCustomerId === me && row.auction.leaderMaxCents !== null;
    // §7.5: соц-доказательство из живых данных — наблюдающие (вэлмес на этот
    // аукцион) и ставки за последний час. Никаких выдуманных чисел.
    const hourAgo = new Date(ctx.now().getTime() - 3_600_000);
    const [watchers] = await ctx.db
      .select({ n: sql<string>`count(*)` })
      .from(watchlist)
      .where(eq(watchlist.auctionId, id));
    const [recentBids] = await ctx.db
      .select({ n: sql<string>`count(*)` })
      .from(bids)
      .where(and(eq(bids.auctionId, id), gte(bids.createdAt, hourAgo), isNull(bids.voidedAt)));
    return {
      auction: publicAuction(row),
      watchersCount: Number(watchers?.n ?? 0),
      bidsLastHour: Number(recentBids?.n ?? 0),
      minNextBidCents: await minNext(row, iLead ? row.auction.leaderMaxCents! : null),
      // Собственный максимум — только самому лидеру. Без него витрина
      // предлагала лидеру «минимум соперника», который для него самого
      // не проходит («выше собственного максимума»).
      myMaxCents: iLead ? row.auction.leaderMaxCents : null,
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

  /** §7.2: похожие живые лоты (та же категория, сопоставимая цена) — для
   *  экрана закрытого аукциона, тот же диапазон, что в письме. */
  app.get("/api/public/auctions/:id/similar", async (req, reply) => {
    const { id } = req.params as { id: string };
    const [row] = await ctx.db
      .select({ auction: auctions, listing: listings, item: items })
      .from(auctions)
      .innerJoin(listings, eq(auctions.listingId, listings.id))
      .innerJoin(items, eq(listings.itemId, items.id))
      .where(eq(auctions.id, id));
    if (!row) return reply.code(404).send({ error: "not_found" });
    const anchor = row.auction.currentPriceCents ?? row.listing.startPriceCents ?? 0;
    const rows = await ctx.db
      .select({ id: listings.id, title: listings.title, priceCents: listings.priceCents, type: listings.type, category: items.category })
      .from(listings)
      .innerJoin(items, eq(listings.itemId, items.id))
      .where(and(eq(listings.status, "published"), eq(items.category, row.item.category)))
      .orderBy(desc(listings.updatedAt))
      .limit(20);
    const band = rows
      .filter((r) => r.priceCents !== null && r.id !== row.listing.id)
      .filter((r) => anchor === 0 || (r.priceCents! >= anchor * 0.5 && r.priceCents! <= anchor * 1.6))
      .slice(0, 5);
    // Аукционным лотам витрина линкует /auction/{auctionId}, не listing id.
    const liveAuctions = band.length
      ? await ctx.db
          .select({ id: auctions.id, listingId: auctions.listingId })
          .from(auctions)
          .where(and(inArray(auctions.listingId, band.map((b) => b.id)), eq(auctions.status, "running")))
      : [];
    const auctionByListing = new Map(liveAuctions.map((a) => [a.listingId, a.id]));
    return { lots: band.map((b) => ({ ...b, auctionId: auctionByListing.get(b.id) ?? null })) };
  });

  /** Минимальная следующая ставка. Для лидера — персональная: движок
   *  принимает от него только сумму выше его собственного максимума, и
   *  общий «цена + шаг» может оказаться ниже. Подсказку округляем вверх до
   *  чистого шага, чтобы не предлагать человеку суммы вроде 155,11 €. */
  async function minNext(
    row: { auction: typeof auctions.$inferSelect; listing: typeof listings.$inferSelect },
    myMaxCents: number | null = null,
  ) {
    const { incrementAt } = await import("@auction/domain");
    const { markets } = await import("@auction/db");
    if (row.auction.currentPriceCents === null) return row.listing.startPriceCents ?? 0;
    const [market] = await ctx.db.select().from(markets).where(eq(markets.code, row.listing.marketCode));
    const inc = incrementAt(row.auction.currentPriceCents, market!.incrementTable);
    const standard = row.auction.currentPriceCents + inc;
    if (myMaxCents === null || standard > myMaxCents) return standard;
    return Math.ceil((myMaxCents + 1) / inc) * inc;
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
    // Первая ли это успешная ставка человека вообще — сигнал активации для
    // рекламы (FirstBidPlaced против BidPlaced). Решает движок по журналу
    // ставок, витрина только передаёт дальше.
    const [bidTally] = await ctx.db
      .select({ n: sql<string>`count(*)` })
      .from(bids)
      .where(and(eq(bids.customerId, bidderId), isNull(bids.voidedAt)));
    // v15: журнал поведения — успешная ставка (мимо критического пути).
    void lotCategory(id).then((lot) => {
      if (lot) logUserEvent(ctx, { customerId: bidderId, eventType: "place_bid", category: lot.category, listingId: lot.listingId });
    }).catch(() => undefined);
    return {
      ok: true,
      // Идентификатор события аналитики — рождается на сервере вместе с
      // принятой ставкой (задача IT): повторная обработка того же ответа не
      // создаёт нового, а браузерный пиксель и серверная копия Meta
      // склеиваются по нему в одну конверсию.
      eventId: `place_bid-${randomUUID()}`,
      firstBid: Number(bidTally?.n ?? 0) <= 1,
      priceChanged: result.priceChanged,
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
          // Согласие из кабинета снимает и отписку по ссылке из письма —
          // иначе галочка была бы включена, а письма всё равно бы не шли.
          ? { marketingOptIn: true, marketingOptInAt: now, marketingSource: "account", marketingOptOutAt: null, unsubscribedAt: null }
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
        // Согласие из кабинета снимает и отписку по ссылке из письма.
        patch.unsubscribedAt = null;
      } else {
        // Дату согласия не стираем: отзыв тоже нужно уметь показать.
        patch.marketingOptIn = false;
        patch.marketingOptOutAt = now;
      }
    }
    let emailChanged = false;
    /** Прежний адрес — на него уйдёт предупреждение о смене (письмо A3). */
    let previousEmail: { email: string; alias: string; lang: string | null; country: string | null } | null = null;
    if (body.data.email !== undefined) {
      const nextEmail = body.data.email.toLowerCase();
      const [current] = await ctx.db.select().from(customers).where(eq(customers.id, bidderId));
      if (current && current.email !== nextEmail) {
        const [taken] = await ctx.db.select({ id: customers.id }).from(customers).where(eq(customers.email, nextEmail));
        if (taken) return reply.code(409).send({ error: "email_exists" });
        patch.email = nextEmail;
        patch.emailVerifiedAt = null;
        emailChanged = true;
        previousEmail = { email: current.email, alias: current.alias, lang: current.lang, country: current.country };
      }
    }
    if (Object.keys(patch).length === 0) return reply.code(400).send({ error: "empty_patch" });
    const [row] = await ctx.db
      .update(customers)
      .set(patch)
      .where(eq(customers.id, bidderId))
      .returning({ id: customers.id, email: customers.email, alias: customers.alias, marketingOptIn: customers.marketingOptIn });
    if (!row) return reply.code(401).send({ error: "unauthenticated" });
    if (emailChanged) {
      await sendVerificationEmail({ id: row.id, email: row.email });
      // Письмо A3 уходит на ПРЕЖНИЙ адрес: если почту сменил чужой, увидеть
      // это можно только там. На новый адрес идёт письмо-подтверждение.
      // Поэтому отправляем напрямую — очередь взяла бы уже новый адрес.
      if (previousEmail) {
        const prev = previousEmail;
        void (async () => {
          const lang = langFor(prev.lang, prev.country);
          const msg = await renderNotification(ctx, "security_alert", lang, {
            alias: prev.alias,
            lotTitle: "",
            securityEvent: "email_changed",
            deviceLabel: deviceLabelOf(req),
            eventAt: ctx.now(),
          });
          await ctx.email.send({ to: prev.email, subject: msg.subject, text: msg.text, html: msg.html });
        })().catch((err) => req.log?.error({ err }, "email-change alert failed"));
      }
    }
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
          // Тип продажи решает движок, а не витрина: заказ либо родился из
          // торгов (есть auctionId), либо из фикс-цены. Аналитика делит
          // воронку по этому полю (sale_type: auction | buy_now).
          saleType: r.order.auctionId ? "auction" : "buy_now",
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
          // Телефон получателя: подставляем в поле оплаты, чтобы не набирать
          // заново, и отдаём Google Ads Enhanced Conversions при согласии.
          recipientPhone: r.order.recipientPhone,
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
    // Хранение считаем отдельно: это не штраф за нарушение, а плата за
    // услугу, и в кабинете она должна объясняться своими словами. Общая
    // сумма остаётся общей — ею меряется блокировка ставок и покупок.
    const storageCents = rows
      .filter((f) => f.type === "storage")
      .reduce((sum, f) => sum + f.amountCents, 0);
    return {
      fees: rows,
      outstandingCents: rows.reduce((sum, f) => sum + f.amountCents, 0),
      storageCents,
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
    // Остаток за вычетом живых резервов: придержанная на оформлении единица
    // с витрины уже снята, хотя окончательно её заберёт только заказ.
    const page = rows.slice(0, limit);
    const held = await Promise.all(page.map((r) => heldTotal(ctx, r.listing.id)));
    return {
      listings: page.map((r, i) => ({
        ...publicListing(r),
        stock: Math.max(r.listing.quantity - held[i]!, 0),
      })),
      hasMore: rows.length > limit,
    };
  });


  /** Категория лота по id витрины (листинг или аукцион) — для журнала
   *  поведения. Лёгкий запрос, зовётся мимо критического пути. */
  async function lotCategory(anyId: string): Promise<{ category: string | null; listingId: string } | null> {
    const [byListing] = await ctx.db
      .select({ category: items.category, listingId: listings.id })
      .from(listings)
      .innerJoin(items, eq(listings.itemId, items.id))
      .where(eq(listings.id, anyId));
    if (byListing) return byListing;
    const [byAuction] = await ctx.db
      .select({ category: items.category, listingId: listings.id })
      .from(auctions)
      .innerJoin(listings, eq(auctions.listingId, listings.id))
      .innerJoin(items, eq(listings.itemId, items.id))
      .where(eq(auctions.id, anyId));
    return byAuction ?? null;
  }

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
    const soldOut =
      row.listing.status !== "published" || row.item.status !== "listed" || row.listing.quantity <= 0;
    const stock = soldOut ? 0 : Math.max(row.listing.quantity - (await heldTotal(ctx, row.listing.id)), 0);
    // Цена — финальная: комиссия и НДС внутри, итог равен витринной цене.
    const estimatedTotalCents = row.listing.priceCents ?? 0;
    return { listing: { ...publicListing(row), soldOut, stock, estimatedTotalCents } };
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

    // Часы welcome-кода начинают тикать от подтверждения (MD §1.5.1), не от
    // регистрации — человек, открывший письмо через три дня, срок не теряет.
    await extendWelcomeOnVerify(ctx, ctx.db, c.id).catch(() => undefined);

    // Реферальная награда, ступень 1 (MD §1.6.1): пригласивший получает
    // баллы за подтверждённую регистрацию. Fraud-флаг держит выплату до
    // ручной проверки в админке.
    await ctx.db.transaction(async (tx) => {
      const [r] = await tx.select().from(referrals).where(eq(referrals.referredCustomerId, c.id)).for("update");
      if (!r || r.status !== "pending" || r.fraudFlag) return;
      const s = await getSettings(ctx);
      if (s.referral_signup_points_cents > 0) {
        await movePoints(tx, r.referrerCustomerId, {
          reason: "referral_signup",
          amountCents: s.referral_signup_points_cents,
          referralId: r.id,
        }, ctx.now());
      }
      await tx
        .update(referrals)
        .set({ status: "signup_rewarded", signupRewardedAt: ctx.now() })
        .where(eq(referrals.id, r.id));
    }).catch((err) => req.log.error({ err }, "referral signup reward failed"));

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

  // ═══ БАЛЛЫ ЛОЯЛЬНОСТИ И РЕФЕРАЛЫ (план v15) ═════════════════════════════

  /** Баланс и журнал баллов. 1 балл = 1 € = 100 центов; потолок списания —
   *  доля итога заказа из настроек (заказ целиком баллами не закрывается). */
  app.get("/api/public/me/points", async (req, reply) => {
    const bidderId = requireBidder(req, reply);
    if (!bidderId) return;
    const account = await getOrCreateLoyalty(ctx.db, bidderId);
    const s = await getSettings(ctx);
    const rows = await ctx.db
      .select()
      .from(loyaltyLedger)
      .where(eq(loyaltyLedger.accountId, account.id))
      .orderBy(desc(loyaltyLedger.createdAt))
      .limit(50);
    const tier = await tierFor(ctx, ctx.db, bidderId);
    return {
      balanceCents: account.balanceCents,
      redeemMaxBp: s.points_redeem_max_bp,
      earnPerEurCents: s.points_per_eur_cents,
      // §6.5: уровень и путь до следующего — для страницы /punkti.
      tier: tier.tier,
      tierEarnBp: tier.earnBp,
      lifetimeEarnedCents: tier.lifetimeEarnedCents,
      toNextTierCents: tier.toNextCents,
      ledger: rows.map((r) => ({
        reason: r.reason, amountCents: r.amountCents, orderRef: r.orderRef, createdAt: r.createdAt,
      })),
    };
  });

  /** Погашение подарочной карты: номинал уходит в кредит счёта. */
  app.post("/api/public/me/gift-card", async (req, reply) => {
    const bidderId = requireBidder(req, reply);
    if (!bidderId) return;
    const body = z.object({ code: z.string().min(6).max(24) }).safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "invalid_body" });
    const result = await redeemGiftCard(ctx, { code: body.data.code, customerId: bidderId });
    if (!result.ok) return reply.code(422).send({ ok: false, reason: result.reason });
    return { ok: true, amountCents: result.amountCents, creditBalanceCents: result.creditBalanceCents };
  });

  /** §6.4: интересы при знакомстве — категории сеют user_category_stats,
   *  персонализация работает до первой покупки. */
  app.post("/api/public/me/interests", async (req, reply) => {
    const bidderId = requireBidder(req, reply);
    if (!bidderId) return;
    const body = z.object({ categories: z.array(z.string().min(2).max(60)).min(1).max(8) }).safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "invalid_body" });
    const valid = body.data.categories.filter((c) => CATEGORIES.some((k) => k.code === c));
    if (valid.length === 0) return reply.code(400).send({ error: "unknown_categories" });
    for (const category of valid) {
      logUserEvent(ctx, { customerId: bidderId, eventType: "viewed_category", category });
      // Вес выбранного интереса — как пять просмотров: заметен для топ-
      // категории, но реальные покупки быстро его перевешивают.
      await ctx.db.execute(sql`
        insert into user_category_stats (customer_id, category, view_count, updated_at)
        values (${bidderId}, ${category}, 5, now())
        on conflict (customer_id, category)
        do update set view_count = user_category_stats.view_count + 5, updated_at = now()
      `);
    }
    return { ok: true, saved: valid };
  });

  /** Бейдж вэлмес: сколько наблюдаемых лотов заканчивается в ближайшие сутки. */
  app.get("/api/public/me/wishlist-alerts", async (req, reply) => {
    const bidderId = requireBidder(req, reply);
    if (!bidderId) return;
    const soon = new Date(ctx.now().getTime() + 24 * 3_600_000);
    const rows = await ctx.db.execute(sql`
      select count(*) as n from watchlist w
      join auctions a on a.id = w.auction_id
      where w.customer_id = ${bidderId} and a.status = 'running' and a.ends_at <= ${soon}
    `);
    const first = ((rows as unknown as { rows?: Array<{ n: string }> }).rows ?? (rows as unknown as Array<{ n: string }>))[0];
    return { endingSoon: Number(first?.n ?? 0) };
  });

  /** §7.1 + §4: персональные рекомендации — топ-категория клиента, компаньон
   *  по co-occurrence, живые лоты; гостю — просто свежие. */
  app.get("/api/public/recommendations", async (req) => {
    const me = req.bidder?.sub ?? null;
    let category: string | null = null;
    let companion: string | null = null;
    if (me) {
      const stats = await ctx.db
        .select()
        .from(userCategoryStats)
        .where(eq(userCategoryStats.customerId, me))
        .orderBy(desc(userCategoryStats.purchaseCount), desc(userCategoryStats.viewCount))
        .limit(1);
      const top = stats[0];
      if (top && (top.purchaseCount > 0 || top.viewCount > 0) && top.category !== "other") {
        category = top.category;
        companion = await companionCategory(ctx, top.category);
      }
    }
    const pick = async (cat: string | null, limit: number) => {
      const rows = await ctx.db
        .select({ id: listings.id, title: listings.title, priceCents: listings.priceCents, type: listings.type, category: items.category })
        .from(listings)
        .innerJoin(items, eq(listings.itemId, items.id))
        .where(and(eq(listings.status, "published"), cat ? eq(items.category, cat) : undefined))
        .orderBy(desc(listings.updatedAt))
        .limit(limit);
      return rows.filter((r) => r.priceCents !== null);
    };
    const main = await pick(category, 8);
    const extra = companion ? await pick(companion, 4) : [];
    // Аукционным лотам витрина линкует /auction/{auctionId}.
    const all = [...main, ...extra];
    const liveA = all.length
      ? await ctx.db
          .select({ id: auctions.id, listingId: auctions.listingId })
          .from(auctions)
          .where(and(inArray(auctions.listingId, all.map((l) => l.id)), eq(auctions.status, "running")))
      : [];
    const aByListing = new Map(liveA.map((a) => [a.listingId, a.id]));
    const withHref = (l: (typeof all)[number]) =>
      l.type === "fixed" ? l : { ...l, id: aByListing.get(l.id) ?? l.id };
    return {
      category,
      companionCategory: companion,
      lots: main.filter((l) => l.type === "fixed" || aByListing.has(l.id)).map(withHref),
      companionLots: extra.filter((l) => l.type === "fixed" || aByListing.has(l.id)).map(withHref),
    };
  });

  /** Личная реферальная ссылка (создаётся при первом запросе) + статистика. */
  app.get("/api/public/me/referral", async (req, reply) => {
    const bidderId = requireBidder(req, reply);
    if (!bidderId) return;
    const code = await ensureReferralCode(ctx, bidderId);
    const s = await getSettings(ctx);
    const mine = await ctx.db.select().from(referrals).where(eq(referrals.referrerCustomerId, bidderId));
    return {
      code,
      url: `${ctx.config.storefrontBaseUrl}/register?ref=${code}`,
      rewards: {
        signupCents: s.referral_signup_points_cents,
        orderCents: s.referral_order_points_cents,
        friendPercent: s.referral_percent,
      },
      stats: {
        invited: mine.length,
        signupRewarded: mine.filter((r) => r.status !== "pending").length,
        orderRewarded: mine.filter((r) => r.status === "order_rewarded").length,
        onHold: mine.filter((r) => r.fraudFlag && r.status === "pending").length,
      },
    };
  });

  // ═══ WEB PUSH (MD §6.8) ══════════════════════════════════════════════════

  /** Публичный VAPID-ключ — браузеру для подписки. */
  app.get("/api/public/push/vapid-key", async () => {
    const { ensureVapidKeys } = await import("../engine/push.js");
    const keys = await ensureVapidKeys(ctx);
    return { publicKey: keys.publicKey };
  });

  app.post("/api/public/push/subscribe", async (req, reply) => {
    const bidderId = requireBidder(req, reply);
    if (!bidderId) return;
    const body = z
      .object({
        endpoint: z.string().url().max(1_000),
        keys: z.object({ p256dh: z.string().min(10).max(300), auth: z.string().min(5).max(100) }),
      })
      .safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "invalid_body" });
    await ctx.db
      .insert(pushSubscriptions)
      .values({
        customerId: bidderId,
        endpoint: body.data.endpoint,
        p256dh: body.data.keys.p256dh,
        auth: body.data.keys.auth,
        userAgent: (req.headers["user-agent"] ?? "").slice(0, 300) || null,
      })
      .onConflictDoUpdate({
        target: pushSubscriptions.endpoint,
        set: { customerId: bidderId, p256dh: body.data.keys.p256dh, auth: body.data.keys.auth, failCount: 0 },
      });
    return { ok: true };
  });

  app.delete("/api/public/push/subscribe", async (req, reply) => {
    const bidderId = requireBidder(req, reply);
    if (!bidderId) return;
    const body = z.object({ endpoint: z.string().url().max(1_000) }).safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "invalid_body" });
    await ctx.db
      .delete(pushSubscriptions)
      .where(and(eq(pushSubscriptions.endpoint, body.data.endpoint), eq(pushSubscriptions.customerId, bidderId)));
    return { ok: true };
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
  /**
   * Откуда пришёл клиент: utm-метки, реферер, посадочная.
   *
   * Касаний два. ПЕРВОЕ пишется один раз — попытки переписать игнорируются,
   * первое касание переписать нельзя по определению; по нему считается цена
   * привлечения. ПОСЛЕДНЕЕ обновляется на каждом помеченном визите — по нему
   * видно, что привело человека к покупке именно сейчас, и только так письмо
   * и ретаргетинг вообще получают свою долю выручки.
   *
   * Заодно принимаем id браузера из плашки cookie: он сшивает согласия,
   * данные до регистрации, с уже появившимся аккаунтом.
   */
  app.post("/api/public/me/attribution", async (req, reply) => {
    const bidderId = requireBidder(req, reply);
    if (!bidderId) return;
    const short = z.string().max(120).optional();
    const touch = z.object({
      source: short, medium: short, campaign: short, content: short, term: short,
      referrer: z.string().max(400).optional(),
      landing: z.string().max(400).optional(),
    });
    const body = z
      .object({
        first: touch.optional(),
        last: touch.optional(),
        visitorId: z.string().max(80).optional(),
      })
      // Старый плоский вид (одно касание в корне тела) остаётся рабочим:
      // витрина у кого-то в кэше, и ронять её на 400 незачем.
      .and(touch.partial())
      .safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "invalid_body" });
    const { first, last, visitorId, ...flat } = body.data;
    const strip = (t: Record<string, string | undefined> | undefined) => {
      if (!t) return null;
      const clean = Object.fromEntries(Object.entries(t).filter(([, v]) => v));
      return Object.keys(clean).length > 0 ? { ...clean, at: ctx.now().toISOString() } : null;
    };
    const firstTouch = strip(first) ?? strip(flat);
    const lastTouch = strip(last) ?? firstTouch;

    if (firstTouch) {
      await ctx.db
        .update(customers)
        .set({ attribution: firstTouch })
        .where(and(eq(customers.id, bidderId), isNull(customers.attribution)));
    }
    if (lastTouch) {
      await ctx.db
        .update(customers)
        .set({ attributionLast: lastTouch, attributionTouches: sql`${customers.attributionTouches} + 1` })
        .where(eq(customers.id, bidderId));
    }
    // Id браузера тоже пишем один раз: у аккаунта он первый, а не последний —
    // перезапись увела бы согласия гостя к чужому браузеру.
    if (visitorId) {
      await ctx.db
        .update(customers)
        .set({ visitorId })
        .where(and(eq(customers.id, bidderId), isNull(customers.visitorId)));
    }
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

  // ── Отписка от рассылки ─────────────────────────────────────────────────

  /**
   * Работает без входа в аккаунт — иначе это не отписка, а препятствие.
   * GET ничего не меняет и уводит человека на страницу витрины: ссылку могут
   * открыть предпросмотрщик почты или антивирус, и молча выключать рассылку
   * от их визита нельзя. Меняет состояние только POST — его шлёт либо кнопка
   * на странице, либо сам почтовик (One-Click).
   */
  const unsubToken = z.object({ t: z.string().min(10).max(200) });

  app.get("/api/public/unsubscribe", async (req, reply) => {
    const q = unsubToken.safeParse(req.query ?? {});
    const site = ctx.config.storefrontBaseUrl;
    if (!q.success) return reply.redirect(`${site}/atteikties`, 302);
    return reply.redirect(`${site}/atteikties?t=${encodeURIComponent(q.data.t)}`, 302);
  });

  app.post("/api/public/unsubscribe", async (req, reply) => {
    const q = unsubToken.safeParse({ ...(req.query as object), ...(typeof req.body === "object" ? req.body : {}) });
    if (!q.success) return reply.code(400).send({ error: "invalid_token" });
    const customerId = verifyUnsubscribeToken(q.data.t, ctx.config.jwtSecret);
    if (!customerId) return reply.code(400).send({ error: "invalid_token" });
    await applyUnsubscribe(ctx, customerId);
    // Повторное нажатие отвечает так же: человеку важен результат, а не то,
    // была ли отписка уже сделана.
    return { ok: true };
  });

  /** Ошиблись кнопкой — возвращаем подписку тем же токеном. */
  app.post("/api/public/resubscribe", async (req, reply) => {
    const q = unsubToken.safeParse({ ...(req.query as object), ...(typeof req.body === "object" ? req.body : {}) });
    if (!q.success) return reply.code(400).send({ error: "invalid_token" });
    const customerId = verifyUnsubscribeToken(q.data.t, ctx.config.jwtSecret);
    if (!customerId) return reply.code(400).send({ error: "invalid_token" });
    await ctx.db
      .update(customers)
      .set({ unsubscribedAt: null, marketingOptIn: true, marketingOptInAt: ctx.now(), marketingOptOutAt: null })
      .where(and(eq(customers.id, customerId), isNull(customers.erasedAt)));
    return { ok: true };
  });

  // ── Вэлмес: отслеживаемые лоты ──────────────────────────────────────────

  /**
   * Список живёт в базе, а не в браузере: сердечко, поставленное с телефона,
   * обязано быть на месте и в ноутбуке, и через полгода после чистки кэша.
   * Наружу отдаём и принимаем плоский список идентификаторов — витрине всё
   * равно, торги это или лот «купить сразу», а в базе ссылка своя на каждое.
   */
  const WATCH_LIMIT = 500;

  /** Разложить пришедшие идентификаторы по двум колонкам; чужого не берём. */
  async function watchRows(customerId: string, ids: string[]) {
    if (ids.length === 0) return [];
    const live = await ctx.db.select({ id: auctions.id }).from(auctions).where(inArray(auctions.id, ids));
    const fixed = await ctx.db.select({ id: listings.id }).from(listings).where(inArray(listings.id, ids));
    return [
      ...live.map((a) => ({ customerId, auctionId: a.id, listingId: null })),
      ...fixed.map((l) => ({ customerId, auctionId: null, listingId: l.id })),
    ];
  }

  async function watchIds(customerId: string): Promise<string[]> {
    const rows = await ctx.db
      .select({ auctionId: watchlist.auctionId, listingId: watchlist.listingId })
      .from(watchlist)
      .where(eq(watchlist.customerId, customerId))
      .orderBy(desc(watchlist.createdAt));
    return rows.map((r) => r.auctionId ?? r.listingId).filter((x): x is string => x !== null);
  }

  app.get("/api/public/me/watchlist", async (req, reply) => {
    const bidderId = requireBidder(req, reply);
    if (!bidderId) return;
    return { ids: await watchIds(bidderId) };
  });

  /** Слияние, а не замена: при первом входе список из браузера переезжает в
   *  базу, ничего не затирая. Снятие сердечка идёт отдельным DELETE. */
  app.post("/api/public/me/watchlist", async (req, reply) => {
    const bidderId = requireBidder(req, reply);
    if (!bidderId) return;
    const body = z.object({ ids: z.array(z.string().uuid()).max(WATCH_LIMIT) }).safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "invalid_body" });
    const rows = await watchRows(bidderId, [...new Set(body.data.ids)]);
    if (rows.length > 0) await ctx.db.insert(watchlist).values(rows).onConflictDoNothing();
    return { ids: await watchIds(bidderId) };
  });

  app.post("/api/public/me/watchlist/:id", async (req, reply) => {
    const bidderId = requireBidder(req, reply);
    if (!bidderId) return;
    const { id } = req.params as { id: string };
    const [count] = await ctx.db
      .select({ n: sql<string>`count(*)` })
      .from(watchlist)
      .where(eq(watchlist.customerId, bidderId));
    if (Number(count?.n ?? 0) >= WATCH_LIMIT) return reply.code(409).send({ error: "too_many" });
    const rows = await watchRows(bidderId, [id]);
    if (rows.length === 0) return reply.code(404).send({ error: "not_found" });
    await ctx.db.insert(watchlist).values(rows).onConflictDoNothing();
    // v15: журнал поведения — сердечко поставлено.
    void lotCategory(id).then((lot) => {
      if (lot) logUserEvent(ctx, { customerId: bidderId, eventType: "add_wishlist", category: lot.category, listingId: lot.listingId });
    }).catch(() => undefined);
    return { ok: true };
  });

  app.delete("/api/public/me/watchlist/:id", async (req, reply) => {
    const bidderId = requireBidder(req, reply);
    if (!bidderId) return;
    const { id } = req.params as { id: string };
    await ctx.db
      .delete(watchlist)
      .where(
        and(
          eq(watchlist.customerId, bidderId),
          or(eq(watchlist.auctionId, id), eq(watchlist.listingId, id)),
        ),
      );
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
    const body = z.object({ visitor_id: z.string().regex(/^[a-zA-Z0-9_-]{8,64}$/).optional() }).safeParse(req.body ?? {});
    const result = await buyNow(ctx, {
      listingId: id,
      customerId: bidderId,
      holderIds: body.success && body.data.visitor_id ? [body.data.visitor_id] : [],
    });
    if (!result.ok) {
      const status = result.code === "LISTING_NOT_FOUND" ? 404 : result.code === "NOT_AVAILABLE" ? 409 : 422;
      return reply.code(status).send(result);
    }
    return result;
  });
}
