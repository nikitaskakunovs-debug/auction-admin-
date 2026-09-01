import { customers, items, listings, markets } from "@auction/db";
import { computeInvoice } from "@auction/domain";
import { eq, inArray } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { buyNow } from "../engine/purchase.js";
import { heldByOthers, myHoldUntil, releaseHold, reserveUnit } from "../engine/reservations.js";

/**
 * Гостевая корзина лотов «Pērc uzreiz».
 *
 * До сих пор корзиной был список неоплаченных заказов, а заказ появлялся
 * только после входа — гость видел кнопку «Ienāciet, lai pirktu» и терялся
 * до того, как что-то выбрал. Теперь лот можно отложить без аккаунта:
 * корзина живёт на сервере под идентификатором браузера (тем же, что сшивает
 * согласие на cookie), а вход требуется только при оформлении.
 *
 * Принципы:
 *  — корзина НЕ резервирует лот: уникальную вещь честно забирает тот, кто
 *    первым дошёл до оформления; атомарность гарантирует buyNow (FOR UPDATE);
 *  — цены в корзине — снимок на момент добавления; при показе и оформлении
 *    сервер сверяет их с живыми и явно сообщает об изменении;
 *  — при входе корзина браузера сливается с корзиной аккаунта, уникальный
 *    лот не задваивается;
 *  — заказ, счёт и событие Purchase появляются только после оформления
 *    авторизованным человеком — гостевая корзина к деньгам не прикасается.
 */

/** Тот же формат, что у izsoli_visitor_v1 на витрине (UUID и близкие к нему). */
const visitorSchema = z.string().regex(/^[a-zA-Z0-9_-]{8,64}$/);

const TTL_SEC = 30 * 86_400;
const MAX_ITEMS = 50;

interface CartEntry {
  /** id продажи (listings.id). */
  id: string;
  /** Цена в момент добавления — чтобы честно сказать «цена изменилась». */
  priceCents: number;
  at: number;
}

const keyOfVisitor = (v: string) => `cart:v:${v}`;
const keyOfCustomer = (c: string) => `cart:c:${c}`;

async function readEntries(ctx: AppContext, key: string): Promise<CartEntry[]> {
  try {
    const raw = await ctx.redis.get(key);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? (parsed as CartEntry[]).filter((e) => typeof e?.id === "string") : [];
  } catch {
    return [];
  }
}

async function writeEntries(ctx: AppContext, key: string, entries: CartEntry[]): Promise<void> {
  if (entries.length === 0) {
    await ctx.redis.del(key);
    return;
  }
  await ctx.redis.set(key, JSON.stringify(entries.slice(0, MAX_ITEMS)), "EX", TTL_SEC);
}

/**
 * Чья корзина обслуживается и не пора ли слить гостевую с корзиной аккаунта.
 *
 * Слияние происходит лениво — при первом же обращении с токеном И
 * идентификатором браузера, то есть сразу после входа или регистрации, каким
 * бы путём они ни случились (пароль, соцсеть, Telegram). Уникальный лот при
 * слиянии не задваивается; побеждает более ранний снимок цены.
 */
async function resolveCart(
  ctx: AppContext,
  args: { customerId: string | null; visitorId: string | null },
): Promise<{ key: string | null; entries: CartEntry[] }> {
  const { customerId, visitorId } = args;
  if (customerId) {
    const key = keyOfCustomer(customerId);
    let entries = await readEntries(ctx, key);
    if (visitorId) {
      const guestKey = keyOfVisitor(visitorId);
      const guest = await readEntries(ctx, guestKey);
      if (guest.length > 0) {
        const have = new Set(entries.map((e) => e.id));
        entries = [...entries, ...guest.filter((e) => !have.has(e.id))];
        await writeEntries(ctx, key, entries);
        await ctx.redis.del(guestKey);
      }
    }
    return { key, entries };
  }
  if (visitorId) return { key: keyOfVisitor(visitorId), entries: await readEntries(ctx, keyOfVisitor(visitorId)) };
  return { key: null, entries: [] };
}

export function registerCartRoutes(app: FastifyInstance, ctx: AppContext): void {
  const requireBidder = (req: FastifyRequest, reply: FastifyReply): string | null => {
    const id = req.bidder?.sub ?? null;
    if (!id) void reply.code(401).send({ error: "unauthorized" });
    return id;
  };

  /** Живые данные лотов корзины одним запросом. */
  async function loadRows(ids: string[]) {
    if (ids.length === 0) return [];
    return ctx.db
      .select({ listing: listings, item: items })
      .from(listings)
      .innerJoin(items, eq(listings.itemId, items.id))
      .where(inArray(listings.id, ids));
  }

  function viewOf(entry: CartEntry, row: { listing: typeof listings.$inferSelect; item: typeof items.$inferSelect } | undefined, market: { buyerPremiumBp: number; vatRateBp: number } | undefined) {
    if (!row || !market || row.listing.priceCents === null) return null;
    const available =
      row.listing.status === "published" && row.listing.quantity > 0 && row.item.status === "listed";
    // Раскладка та же, что выпишет счёт: цена финальная, комиссия и НДС внутри.
    const inv = computeInvoice({
      grossCents: row.listing.priceCents,
      buyerPremiumBp: market.buyerPremiumBp,
      vatRateBp: market.vatRateBp,
      reverseCharge: false,
    });
    return {
      listingId: row.listing.id,
      sku: row.item.sku,
      title: row.listing.title,
      category: row.item.category,
      photo: row.item.photos?.[0] ?? null,
      marketCode: row.listing.marketCode,
      quantity: 1,
      currency: "EUR",
      hammerCents: inv.hammerCents,
      premiumCents: inv.premiumCents,
      vatCents: inv.vatCents,
      vatRateBp: inv.vatRateBp,
      totalCents: inv.totalCents,
      available,
      priceChanged: available && entry.priceCents !== row.listing.priceCents,
    };
  }

  const who = (req: FastifyRequest, rawVisitor: unknown) => {
    const visitor = visitorSchema.safeParse(rawVisitor);
    return {
      customerId: req.bidder?.sub ?? null,
      visitorId: visitor.success ? visitor.data : null,
    };
  };

  app.get("/api/public/cart", async (req, reply) => {
    const q = req.query as { visitor_id?: string };
    const ids = who(req, q.visitor_id);
    if (!ids.customerId && !ids.visitorId) return reply.code(400).send({ error: "no_identity" });
    const { key, entries } = await resolveCart(ctx, ids);

    const rows = await loadRows(entries.map((e) => e.id));
    const byId = new Map(rows.map((r) => [r.listing.id, r]));
    const marketRows = await ctx.db.select().from(markets);
    const byMarket = new Map(marketRows.map((m) => [m.code, m]));

    const mine = [ids.visitorId ?? "", ids.customerId ?? ""].filter(Boolean);
    const itemsOut = [];
    const alive: CartEntry[] = [];
    for (const e of entries) {
      const view = viewOf(e, byId.get(e.id), byMarket.get(byId.get(e.id)?.listing.marketCode ?? ""));
      // Продажа исчезла из базы совсем — такой записи в корзине делать нечего.
      if (!view) continue;
      alive.push(e);
      // Единицы, придержанные другими оформляющими, человеку недоступны;
      // его собственный резерв — наоборот, гарантия и таймер.
      const row = byId.get(e.id)!;
      const others = view.available ? await heldByOthers(ctx, e.id, mine) : 0;
      const reservedUntil = await myHoldUntil(ctx, e.id, mine);
      itemsOut.push({
        ...view,
        available: view.available && row.listing.quantity - others > 0,
        stock: Math.max(row.listing.quantity - others, 0),
        reservedUntil,
      });
    }
    if (key && alive.length !== entries.length) await writeEntries(ctx, key, alive);

    return {
      items: itemsOut,
      count: itemsOut.filter((i) => i.available).length,
      totalCents: itemsOut.filter((i) => i.available).reduce((s, i) => s + i.totalCents, 0),
    };
  });

  app.post("/api/public/cart", async (req, reply) => {
    const body = z
      .object({ listing_id: z.string().uuid(), visitor_id: visitorSchema.optional() })
      .safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "invalid_body" });
    const ids = who(req, body.data.visitor_id);
    if (!ids.customerId && !ids.visitorId) return reply.code(400).send({ error: "no_identity" });

    const [row] = await loadRows([body.data.listing_id]);
    const canBuy =
      row &&
      row.listing.type === "fixed" &&
      row.listing.status === "published" &&
      row.listing.quantity > 0 &&
      row.item.status === "listed" &&
      row.listing.priceCents !== null;
    if (!canBuy) return reply.code(409).send({ error: "not_available" });

    const { key, entries } = await resolveCart(ctx, ids);
    const added = !entries.some((e) => e.id === row.listing.id);
    if (added) {
      if (entries.length >= MAX_ITEMS) return reply.code(409).send({ error: "cart_full" });
      entries.push({ id: row.listing.id, priceCents: row.listing.priceCents!, at: ctx.now().getTime() });
    }
    // Запись освежает срок хранения и при повторном добавлении.
    await writeEntries(ctx, key!, entries);
    return { ok: true, added, count: entries.length };
  });

  app.delete("/api/public/cart/:listingId", async (req, reply) => {
    const { listingId } = req.params as { listingId: string };
    const q = req.query as { visitor_id?: string };
    const ids = who(req, q.visitor_id);
    if (!ids.customerId && !ids.visitorId) return reply.code(400).send({ error: "no_identity" });
    const { key, entries } = await resolveCart(ctx, ids);
    const next = entries.filter((e) => e.id !== listingId);
    if (key) await writeEntries(ctx, key, next);
    await releaseHold(ctx, listingId, [ids.visitorId ?? "", ids.customerId ?? ""].filter(Boolean));
    return { ok: true, count: next.length };
  });

  /**
   * Начало оформления: за человеком на десять минут закрепляется по ОДНОЙ
   * единице каждого лота корзины — чтобы вход или регистрация не стоили ему
   * выбранного. Резерв поштучный: при остатке 10 занята одна единица, а не
   * весь лот. Повторное нажатие срок не продлевает; таймер виден в GET /cart.
   */
  app.post("/api/public/cart/checkout-start", async (req, reply) => {
    const body = z.object({ visitor_id: visitorSchema.optional() }).safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "invalid_body" });
    const ids = who(req, body.data.visitor_id);
    if (!ids.customerId && !ids.visitorId) return reply.code(400).send({ error: "no_identity" });
    const holder = ids.visitorId ?? ids.customerId!;
    const also = [ids.customerId ?? ""].filter(Boolean);

    const { entries } = await resolveCart(ctx, ids);
    if (entries.length === 0) return reply.code(409).send({ error: "cart_empty" });
    const rows = await loadRows(entries.map((e) => e.id));
    const byId = new Map(rows.map((r) => [r.listing.id, r]));

    const reserved: Array<{ listingId: string; until: number }> = [];
    const missed: string[] = [];
    for (const e of entries) {
      const row = byId.get(e.id);
      const sellable =
        row && row.listing.status === "published" && row.listing.quantity > 0 && row.item.status === "listed";
      if (!sellable) { missed.push(e.id); continue; }
      const until = await reserveUnit(ctx, { listingId: e.id, holder, also, quantity: row.listing.quantity });
      if (until === null) missed.push(e.id);
      else reserved.push({ listingId: e.id, until });
    }
    return {
      ok: true,
      reserved,
      missed,
      reservedUntil: reserved.length > 0 ? Math.min(...reserved.map((r) => r.until)) : null,
    };
  });

  /**
   * Оформление: корзина превращается в заказы. Только с аккаунтом — гостевых
   * заказов не бывает. Каждый лот проходит через buyNow: там блокировка строк
   * FOR UPDATE, и один уникальный лот физически не могут купить двое.
   */
  app.post("/api/public/cart/checkout", async (req, reply) => {
    const bidderId = requireBidder(req, reply);
    if (!bidderId) return;
    if (ctx.config.requireVerifiedEmail) {
      const [c] = await ctx.db
        .select({ verifiedAt: customers.emailVerifiedAt })
        .from(customers)
        .where(eq(customers.id, bidderId));
      if (c && c.verifiedAt === null) return reply.code(403).send({ ok: false, code: "EMAIL_NOT_VERIFIED" });
    }
    const body = z
      .object({
        visitor_id: visitorSchema.optional(),
        // Человек волен оформить не всё: неотмеченные лоты остаются лежать.
        listing_ids: z.array(z.string().uuid()).max(MAX_ITEMS).optional(),
      })
      .safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "invalid_body" });

    const { key, entries: allEntries } = await resolveCart(ctx, { customerId: bidderId, visitorId: body.data.visitor_id ?? null });
    const wanted = body.data.listing_ids ? new Set(body.data.listing_ids) : null;
    const entries = wanted ? allEntries.filter((e) => wanted.has(e.id)) : allEntries;
    const kept = wanted ? allEntries.filter((e) => !wanted.has(e.id)) : [];
    if (entries.length === 0) return reply.code(409).send({ error: "cart_empty" });

    const rows = await loadRows(entries.map((e) => e.id));
    const titleOf = new Map(rows.map((r) => [r.listing.id, r.listing.title]));

    const created: Array<{ ref: string; totalCents: number; listingId: string }> = [];
    const unavailable: Array<{ listingId: string; title: string }> = [];
    const remaining: CartEntry[] = [];

    for (const e of entries) {
      const result = await buyNow(ctx, {
        listingId: e.id,
        customerId: bidderId,
        holderIds: body.data.visitor_id ? [body.data.visitor_id] : [],
      });
      if (result.ok) {
        created.push({ ref: result.orderRef, totalCents: result.totalCents, listingId: e.id });
        continue;
      }
      if (result.code === "BIDDER_BLOCKED" || result.code === "FEES_OUTSTANDING") {
        // Дело не в лоте, а в аккаунте — корзину не трогаем, оформление стоит.
        remaining.push(e, ...entries.slice(entries.indexOf(e) + 1), ...kept);
        await writeEntries(ctx, key!, remaining);
        return reply.code(422).send({ ok: false, code: result.code, orders: created });
      }
      // Лот ушёл другому или снят — из корзины он удаляется, покупателю об
      // этом говорят прямо, на оплату его не пускают.
      unavailable.push({ listingId: e.id, title: titleOf.get(e.id) ?? "" });
    }

    await writeEntries(ctx, key!, kept);
    return { ok: true, orders: created, unavailable };
  });
}
