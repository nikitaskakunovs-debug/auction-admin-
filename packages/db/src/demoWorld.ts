import { computeInvoice, resolveBid, type BidState, type LedgerEntry } from "@auction/domain";
import { and, eq, inArray, isNull, like, or, sql } from "drizzle-orm";
import { createDb } from "./client.js";
import type { Db } from "./client.js";
import { hashPassword } from "./password.js";
import * as t from "./schema.js";

/**
 * Демо-мир: все типы клиентов и весь жизненный цикл заказа — чтобы прокликать
 * витрину и панель от и до, не дожидаясь настоящих покупателей.
 *
 *   node packages/db/dist/demoWorld.js          создать (второй раз откажется)
 *   node packages/db/dist/demoWorld.js remove   убрать всё, что создал
 *
 * Дополняет demoCatalog.js (зоопарк карточек каталога): тот — про лоты,
 * этот — про людей и заказы. Ставить можно в любом порядке.
 *
 * Клиенты живут на @demo.izsoli.lv, пароль у всех одинаковый — Demo123! —
 * каждым можно войти на витрине и посмотреть его кабинет. Лоты заказов несут
 * артикулы DEMO-ORD-*, по этим меткам remove находит и вычищает всё своё.
 */

const MODE = process.argv[2] === "remove" ? "remove" : "create";

/** Пароль всех демо-клиентов — вход на витрине. Только dev/staging-данные. */
export const DEMO_PASSWORD = "Demo123!";

const PREMIUM_BP = 1_000;
const VAT_BP = 2_100;

/** Каждый — отдельный типаж; кабинет каждого показывает свой сценарий. */
const CLIENTS = [
  {
    key: "aija",
    email: "aija@demo.izsoli.lv", alias: "demo_aija", name: "Aija Demo",
    country: "LV", lang: "lv", verified: true, marketing: true,
    attribution: { source: "google", medium: "cpc", campaign: "vasara_lv", landing: "/katalogs" },
    note: "Активный B2C: ставки, заказ в ожидании оплаты, заказ к выдаче, возврат",
  },
  {
    key: "marks",
    email: "marks@demo.izsoli.lv", alias: "demo_marks", name: "Marks Demo",
    country: "LV", lang: "ru", verified: true, marketing: true,
    attribution: { source: "facebook", medium: "paid_social", campaign: "atlaides" },
    lastTouch: { source: "email", medium: "email", campaign: "izsoli_digest", landing: "/katalogs" },
    note: "VIP с авансом: кредит на счету, заказ с зачётом аванса, посылка в пути",
  },
  {
    key: "ruta",
    email: "ruta@demo.izsoli.lv", alias: "demo_ruta", name: "Rūta Demo",
    country: "EE", lang: "en", verified: true, marketing: false,
    company: "Demo Trade OÜ", vatNo: "EE102030405",
    vies: { valid: true, checkedAt: new Date().toISOString(), consult: "DEMO-VIES-1" },
    note: "B2B из Эстонии: фирма с VAT, reverse charge, счёт на юрлицо",
  },
  {
    key: "jauns",
    email: "janis@demo.izsoli.lv", alias: "demo_janis", name: "Jānis Demo",
    country: "LV", lang: "lv", verified: false, marketing: false,
    note: "Новичок: почта не подтверждена — ставки и покупки закрыты",
  },
  {
    key: "tomas",
    email: "tomas@demo.izsoli.lv", alias: "demo_tomas", name: "Tomas Demo",
    country: "LT", lang: "en", verified: true, marketing: true, strikes: 1,
    note: "Должник: неоплаченный заказ отменён, висит restock-fee — торги закрыты",
  },
  {
    key: "bloketais",
    email: "rihards@demo.izsoli.lv", alias: "demo_rihards", name: "Rihards Demo",
    country: "LV", lang: "lv", verified: true, marketing: false,
    blocked: true, blockedReason: "Agresīva uzvedība pret darbiniekiem (zero-tolerance)",
    note: "Заблокирован: zero-tolerance, в кабинете и на витрине всё закрыто",
  },
  {
    key: "atteicies",
    email: "liene@demo.izsoli.lv", alias: "demo_liene", name: "Liene Demo",
    country: "LV", lang: "lv", verified: true, marketing: false,
    unsubscribed: true,
    note: "Отписалась от рассылки по ссылке из письма; сервисные письма идут",
  },
  {
    key: "atlecis",
    email: "gatis@demo.izsoli.lv", alias: "demo_gatis", name: "Gatis Demo",
    country: "LV", lang: "lv", verified: true, marketing: true,
    bounced: true,
    note: "Почта отбилась (bounce) — никакие письма больше не уходят",
  },
  {
    key: "telegram",
    email: "demo.telegram@nav.izsoli.lv", alias: "demo_ozolzile", name: "Telegram Demo",
    country: "LV", lang: "ru", verified: true, marketing: false,
    telegramId: "999000111", noPassword: true,
    note: "Соцвход: служебный адрес, пароля нет — вход только через Telegram",
  },
] as const;

/** Позиции заказов: у каждой — свой этап жизненного цикла. */
const ORDER_ITEMS: Record<string, { title: string; category: string; grossCents: number }> = {
  "DEMO-ORD-01": { title: "Longines Master Collection, 2021", category: "jewellery_watches", grossCents: 98_000 },
  "DEMO-ORD-02": { title: "KitchenAid Artisan mikseris, sarkans", category: "appliances", grossCents: 36_300 },
  "DEMO-ORD-03": { title: "Sonos Beam Gen 2 soundbar", category: "electronics", grossCents: 42_350 },
  "DEMO-ORD-04": { title: "Garmin Fenix 7 Pro pulkstenis", category: "electronics", grossCents: 60_500 },
  "DEMO-ORD-05": { title: "Persiešu paklājs 200×300, vilna", category: "home_garden", grossCents: 84_700 },
  "DEMO-ORD-06": { title: "Ozolkoka ēdamgalds 8 personām", category: "furniture", grossCents: 121_000 },
  "DEMO-ORD-07": { title: "PlayStation 5 Slim + 2 kontrolieri", category: "electronics", grossCents: 54_450 },
  "DEMO-ORD-08": { title: "Makita akumulatoru komplekts 18V", category: "tools", grossCents: 24_200 },
  "DEMO-ORD-09": { title: "Marshall Stanmore III skaļrunis", category: "electronics", grossCents: 33_880 },
  "DEMO-ORD-10": { title: "Samsonite koferu komplekts, 3 gab.", category: "fashion", grossCents: 29_040 },
  "DEMO-ORD-11": { title: "Antīks rakstāmgalds, 19. gs.", category: "art_antiques", grossCents: 145_200 },
};

/** Именованный счётчик — тем же замком строки, что пользуется движок. */
async function bump(db: Db, key: string): Promise<number> {
  await db.insert(t.counters).values({ key, value: 0 }).onConflictDoNothing();
  const [row] = await db
    .update(t.counters)
    .set({ value: sql`${t.counters.value} + 1` })
    .where(eq(t.counters.key, key))
    .returning({ value: t.counters.value });
  return Number(row!.value);
}

async function create(db: Db): Promise<void> {
  const [already] = await db
    .select({ n: sql<string>`count(*)` })
    .from(t.items)
    .where(like(t.items.sku, "DEMO-ORD-%"));
  if (Number(already?.n ?? 0) > 0) {
    console.log("демо-мир уже создан — сначала: node packages/db/dist/demoWorld.js remove");
    process.exitCode = 1;
    return;
  }

  const now = new Date();
  const hours = (n: number) => new Date(now.getTime() + n * 3_600_000);
  const days = (n: number) => hours(n * 24);
  const passwordHash = await hashPassword(DEMO_PASSWORD);

  // ── Клиенты: каждый типаж, upsert по адресу (demoCatalog мог создать часть) ─
  const ids: Record<string, string> = {};
  for (const c of CLIENTS) {
    // Последнее касание есть не у всех: у части демо-клиентов оно совпадает
    // с первым, и тогда карточка честно рисует один блок вместо двух.
    const last: { source?: string; medium?: string; campaign?: string; landing?: string } | null =
      "lastTouch" in c ? c.lastTouch : null;
    const values = {
      email: c.email,
      alias: c.alias,
      name: c.name,
      country: c.country,
      lang: c.lang,
      marketCode: ["LV", "EE", "LT"].includes(c.country) ? c.country : "LV",
      passwordHash: "noPassword" in c && c.noPassword ? null : passwordHash,
      emailVerifiedAt: c.verified ? days(-30) : null,
      marketingOptIn: c.marketing && !("unsubscribed" in c && c.unsubscribed),
      marketingOptInAt: c.marketing ? days(-30) : null,
      marketingSource: c.marketing ? "register" : null,
      marketingOptOutAt: "unsubscribed" in c && c.unsubscribed ? days(-3) : null,
      unsubscribedAt: "unsubscribed" in c && c.unsubscribed ? days(-3) : null,
      emailBouncedAt: "bounced" in c && c.bounced ? days(-5) : null,
      blocked: "blocked" in c && c.blocked === true,
      blockedReason: "blockedReason" in c ? c.blockedReason : null,
      blockedAt: "blocked" in c && c.blocked ? days(-10) : null,
      strikes: "strikes" in c ? c.strikes : 0,
      company: "company" in c ? c.company : null,
      vatNo: "vatNo" in c ? c.vatNo : null,
      vies: "vies" in c ? c.vies : null,
      telegramId: "telegramId" in c ? c.telegramId : null,
      attribution: "attribution" in c ? { ...c.attribution, at: days(-30).toISOString() } : null,
      // Последнее касание отличается от первого: так в карточке и в отчёте
      // видна разница между «кто привёл» и «что вернуло».
      attributionLast: last
        ? { ...last, at: days(-2).toISOString() }
        : "attribution" in c ? { ...c.attribution, at: days(-30).toISOString() } : null,
      attributionTouches: last ? 4 : "attribution" in c ? 1 : 0,
      visitorId: `demo-visitor-${c.key}`,
      lastLoginMethod: "telegramId" in c ? "telegram" : "password",
      lastLoginAt: days(-1),
      notes: c.note,
    };
    await db.insert(t.customers).values(values).onConflictDoNothing();
    // Уже был (создан demoCatalog или прошлым прогоном без remove) — дописываем
    // типаж поверх, ничего не ломая.
    await db.update(t.customers).set(values).where(eq(t.customers.email, c.email));
    const [row] = await db.select({ id: t.customers.id }).from(t.customers).where(eq(t.customers.email, c.email));
    ids[c.key] = row!.id;
  }

  // Удалённый аккаунт (GDPR): так выглядит клиент после самоудаления — от него
  // остаются только снимки в заказах и обезличенная строка.
  const [erased] = await db
    .insert(t.customers)
    .values({
      email: "erased.demo@demo.izsoli.lv",
      alias: "dzests_konts",
      name: null,
      country: null,
      marketCode: "LV",
      erasedAt: days(-7),
      notes: "Демо: аккаунт удалён по запросу клиента, данные обезличены",
    })
    .onConflictDoNothing()
    .returning({ id: t.customers.id });
  if (erased) ids.izdzests = erased.id;
  else {
    const [row] = await db.select({ id: t.customers.id }).from(t.customers).where(eq(t.customers.email, "erased.demo@demo.izsoli.lv"));
    ids.izdzests = row!.id;
  }

  // Метка VIP для marks — берём из словаря тегов, если он на месте.
  const [vip] = await db.select({ id: t.customerTagDefs.id }).from(t.customerTagDefs).where(eq(t.customerTagDefs.name, "VIP"));
  if (vip) await db.update(t.customers).set({ tags: [vip.id] }).where(eq(t.customers.id, ids.marks!));

  // ── Кабинетные мелочи: реквизиты, поиски, префы, аванс ────────────────────
  await db.insert(t.billingProfiles).values([
    { customerId: ids.aija!, kind: "person", name: "Aija Demo", address: "Brīvības iela 1-1", city: "Rīga", zip: "LV-1010", country: "LV", isDefault: true },
    { customerId: ids.ruta!, kind: "company", name: "Demo Trade OÜ", regNo: "14098765", vatNo: "EE102030405", address: "Tartu mnt 2", city: "Tallinn", zip: "10145", country: "EE", invoiceEmail: "invoices@demo.izsoli.lv", isDefault: true, vies: { valid: true, checkedAt: now.toISOString(), consult: "DEMO-VIES-1" } },
    { customerId: ids.marks!, kind: "person", name: "Marks Demo", address: "Lāčplēša iela 25-7", city: "Rīga", zip: "LV-1011", country: "LV", isDefault: true },
  ]);

  await db.insert(t.savedSearches).values([
    { customerId: ids.aija!, name: "Rolex pulksteņi", query: { q: "rolex", category: "jewellery_watches" }, alertEmail: true, lastRunAt: days(-1) },
    { customerId: ids.aija!, name: "Dizaina mēbeles līdz 500 €", query: { category: "furniture", priceMaxCents: 50_000 }, alertEmail: false },
    { customerId: ids.marks!, name: "LEGO Technic", query: { q: "lego", category: "kids_toys" }, alertEmail: true, lastRunAt: days(-1) },
  ]);

  await db.insert(t.notificationPrefs).values([
    { customerId: ids.aija!, event: "outbid", email: true },
    { customerId: ids.atteicies!, event: "outbid", email: false },
  ]).onConflictDoNothing();

  // Аванс у marks: пополнение и остаток 50 €.
  const [credit] = await db
    .insert(t.credits)
    .values({ customerId: ids.marks!, balanceCents: 5_000, expiresAt: days(60) })
    .onConflictDoNothing()
    .returning({ id: t.credits.id });
  if (credit) {
    await db.insert(t.creditEntries).values([
      { creditId: credit.id, kind: "overpay", amountCents: 7_000, orderRef: "A-DEMO", note: "pārmaksa — demo" },
      { creditId: credit.id, kind: "used_for_order", amountCents: -2_000, orderRef: "pending", note: "ieskaitīts pasūtījumā — demo" },
    ]);
  }

  // Вэлмес: aija следит за парой живых лотов каталога (если зоопарк уже стоит).
  const liveDemo = await db
    .select({ id: t.auctions.id })
    .from(t.auctions)
    .innerJoin(t.listings, eq(t.auctions.listingId, t.listings.id))
    .innerJoin(t.items, eq(t.listings.itemId, t.items.id))
    .where(and(eq(t.auctions.status, "live"), like(t.items.sku, "DEMO-%")))
    .limit(2);
  if (liveDemo.length > 0) {
    await db.insert(t.watchlist).values(liveDemo.map((a) => ({ customerId: ids.aija!, auctionId: a.id }))).onConflictDoNothing();
  }

  // ── Заказы: каждый — свой этап жизненного цикла ───────────────────────────

  const itemIds: Record<string, string> = {};
  const makeItem = async (sku: string, status: string) => {
    const def = ORDER_ITEMS[sku]!;
    const [row] = await db
      .insert(t.items)
      .values({
        sku,
        title: def.title,
        category: def.category,
        status,
        marketCode: "LV",
        condition: "lightly_used",
        description: `${def.title}. Demo pasūtījuma lots — pilna dzīves cikla pārbaudei.`,
        location: "FRONT-A1-R1-S1",
        weightGrams: 2_000,
        photos: [],
      })
      .returning({ id: t.items.id });
    itemIds[sku] = row!.id;
    return row!.id;
  };

  const orderIds: Record<string, string> = {};
  const orderRefs: string[] = [];

  /** Заказ из «купить сразу»: цена финальная, движок раскладывает её вниз. */
  const makeOrder = async (args: {
    sku: string;
    itemStatus: string;
    customerKey: string;
    status: "awaiting_payment" | "paid" | "cancelled" | "refunded";
    createdDaysAgo: number;
    paidDaysAgo?: number;
    reverseCharge?: boolean;
    fulfilment?: string;
    shippingCents?: number;
    handlingCents?: number;
    insuranceCents?: number;
    shippingTo?: { provider: string; machineId: string; name: string; zip: string; country: string; address?: string; city?: string; accessNote?: string };
    recipientName?: string;
    recipientPhone?: string;
    pickupCode?: string;
    pickupDeadlineDays?: number;
    paymentDeadlineHours?: number;
    cancelReason?: string;
    restockFeeCents?: number;
    creditAppliedCents?: number;
    billingSnapshot?: NonNullable<typeof t.orders.$inferInsert.billingSnapshot>;
    attribution?: { source?: string; medium?: string; campaign?: string };
    attributionLast?: { source?: string; medium?: string; campaign?: string };
    listingSold?: boolean;
  }) => {
    const def = ORDER_ITEMS[args.sku]!;
    const itemId = await makeItem(args.sku, args.itemStatus);
    const [listing] = await db
      .insert(t.listings)
      .values({
        itemId,
        type: "fixed",
        title: def.title,
        marketCode: "LV",
        priceCents: def.grossCents,
        quantity: 1,
        status: args.listingSold === false ? "published" : "archived",
      })
      .returning({ id: t.listings.id });

    const inv = computeInvoice({
      grossCents: def.grossCents,
      buyerPremiumBp: PREMIUM_BP,
      vatRateBp: VAT_BP,
      reverseCharge: args.reverseCharge ?? false,
      shippingCents: args.shippingCents ?? 0,
    });
    const client = CLIENTS.find((c) => c.key === args.customerKey);
    const ref = `A-${await bump(db, "order_ref")}`;
    const created = days(-args.createdDaysAgo);
    const [order] = await db
      .insert(t.orders)
      .values({
        ref,
        listingId: listing!.id,
        itemId,
        customerId: ids[args.customerKey]!,
        customerAlias: client?.alias ?? "dzests_konts",
        customerEmail: client?.email ?? "erased.demo@demo.izsoli.lv",
        marketCode: "LV",
        hammerCents: inv.hammerCents,
        premiumCents: inv.premiumCents,
        vatCents: inv.vatCents,
        vatRateBp: inv.vatRateBp,
        shippingCents: inv.shippingCents,
        handlingCents: args.handlingCents ?? 0,
        insuranceCents: args.insuranceCents ?? 0,
        totalCents: inv.totalCents + (args.handlingCents ?? 0) + (args.insuranceCents ?? 0),
        reverseCharge: inv.reverseCharge,
        status: args.status,
        createdAt: created,
        paymentDeadlineAt: args.paymentDeadlineHours !== undefined ? hours(args.paymentDeadlineHours) : null,
        paidAt: args.paidDaysAgo !== undefined ? days(-args.paidDaysAgo) : null,
        cancelledAt: args.status === "cancelled" ? days(-args.createdDaysAgo + 3) : null,
        cancelReason: args.cancelReason ?? null,
        pickupCode: args.pickupCode ?? null,
        pickupDeadlineAt: args.pickupDeadlineDays !== undefined ? days(args.pickupDeadlineDays) : null,
        fulfilment: args.fulfilment ?? "pickup",
        shippingTo: args.shippingTo ?? null,
        recipientName: args.recipientName ?? null,
        recipientPhone: args.recipientPhone ?? null,
        restockFeeCents: args.restockFeeCents ?? null,
        creditAppliedCents: args.creditAppliedCents ?? 0,
        billingSnapshot: args.billingSnapshot ?? null,
        attribution: args.attribution ? { ...args.attribution, at: created.toISOString() } : null,
        attributionLast: args.attributionLast
          ? { ...args.attributionLast, at: created.toISOString() }
          : args.attribution ? { ...args.attribution, at: created.toISOString() } : null,
      })
      .returning({ id: t.orders.id });
    orderIds[args.sku] = order!.id;
    orderRefs.push(ref);
    return { id: order!.id, ref, inv, itemId, listingId: listing!.id, client };
  };

  /** Счёт к заказу — та же нумерация серии, что в движке. */
  const makeInvoice = async (o: Awaited<ReturnType<typeof makeOrder>>, buyer: { name: string; company?: string | null; vatNo?: string | null; regNo?: string | null; address?: string | null; country?: string | null }) => {
    const series = `LV-${now.getUTCFullYear()}`;
    const number = `${series}-${String(await bump(db, `invoice:${series}`)).padStart(5, "0")}`;
    const [markets] = await db.select({ legalName: t.markets.legalName }).from(t.markets).where(eq(t.markets.code, "LV"));
    const [item] = await db.select({ sku: t.items.sku, title: t.items.title }).from(t.items).where(eq(t.items.id, o.itemId));
    await db.insert(t.invoices).values({
      orderId: o.id,
      number,
      series,
      data: {
        orderRef: o.ref,
        marketCode: "LV",
        seller: { legalName: markets?.legalName ?? "Skakunov's SIA", country: "LV" },
        buyer: {
          alias: o.client?.alias ?? "dzests_konts",
          email: o.client?.email ?? "",
          name: buyer.name,
          company: buyer.company ?? null,
          vatNo: buyer.vatNo ?? null,
          regNo: buyer.regNo ?? null,
          address: buyer.address ?? null,
          country: buyer.country ?? "LV",
        },
        item: { sku: item!.sku, title: item!.title },
        hammerCents: o.inv.hammerCents,
        premiumCents: o.inv.premiumCents,
        netCents: o.inv.netCents,
        vatCents: o.inv.vatCents,
        vatRateBp: o.inv.vatRateBp,
        shippingCents: o.inv.shippingCents,
        handlingCents: 0,
        totalCents: o.inv.totalCents,
        reverseCharge: o.inv.reverseCharge,
      },
      issuedAt: now,
    });
  };

  const paidPayment = (orderId: string, amountCents: number, method: string, daysAgo: number) =>
    db.insert(t.payments).values({
      orderId,
      provider: "klix",
      channel: "web",
      providerId: `demo-${orderId.slice(0, 8)}`,
      status: "paid",
      amountCents,
      method,
      providerStatus: "paid",
      createdAt: days(-daysAgo),
      updatedAt: days(-daysAgo),
    });

  // O1 — aija выиграла торги, счёт ждёт оплаты; была брошенная попытка Klix.
  {
    const def = ORDER_ITEMS["DEMO-ORD-01"]!;
    const itemId = await makeItem("DEMO-ORD-01", "won");
    const [listing] = await db
      .insert(t.listings)
      .values({ itemId, type: "auction", title: def.title, marketCode: "LV", startPriceCents: 60_000, status: "published" })
      .returning({ id: t.listings.id });

    let state: BidState = { startPriceCents: 60_000, reserveCents: null, currentPriceCents: null, leader: null };
    const ledger: Array<LedgerEntry & { seq: number; maxCents: number }> = [];
    let seq = 0;
    for (const b of [
      { id: ids.marks!, maxCents: 80_000 },
      { id: ids.aija!, maxCents: 100_000 },
    ]) {
      const r = resolveBid(state, { bidderId: b.id, maxCents: b.maxCents, seq: ++seq });
      if (!r.ok) throw new Error(`demo bid rejected: ${r.code}`);
      state = r.state;
      for (const row of r.ledger) ledger.push({ ...row, seq, maxCents: row.bidderId === b.id ? b.maxCents : state.leader!.maxCents });
    }
    const [auction] = await db
      .insert(t.auctions)
      .values({
        listingId: listing!.id, status: "ended_won",
        startsAt: days(-4), endsAt: hours(-10), closedAt: hours(-10),
        currentPriceCents: state.currentPriceCents,
        leaderCustomerId: state.leader!.bidderId, leaderMaxCents: state.leader!.maxCents, leaderSeq: state.leader!.seq,
        bidCount: seq, reserveMet: true,
      })
      .returning({ id: t.auctions.id });
    for (const row of ledger) {
      await db.insert(t.bids).values({
        auctionId: auction!.id, customerId: row.bidderId, amountCents: row.amountCents,
        maxCents: row.maxCents, auto: row.auto, seq: row.seq,
        outbid: row.outbid || row.bidderId !== state.leader!.bidderId,
      });
    }

    const inv = computeInvoice({ grossCents: state.currentPriceCents!, buyerPremiumBp: PREMIUM_BP, vatRateBp: VAT_BP });
    const ref = `A-${await bump(db, "order_ref")}`;
    const [order] = await db
      .insert(t.orders)
      .values({
        ref, auctionId: auction!.id, listingId: listing!.id, itemId,
        customerId: ids.aija!, customerAlias: "demo_aija", customerEmail: "aija@demo.izsoli.lv",
        marketCode: "LV",
        hammerCents: inv.hammerCents, premiumCents: inv.premiumCents, vatCents: inv.vatCents,
        vatRateBp: inv.vatRateBp, totalCents: inv.totalCents,
        status: "awaiting_payment", paymentDeadlineAt: hours(60), createdAt: hours(-10),
        attribution: { source: "google", medium: "cpc", campaign: "vasara_lv", at: hours(-10).toISOString() },
      })
      .returning({ id: t.orders.id });
    orderIds["DEMO-ORD-01"] = order!.id;
    orderRefs.push(ref);
    await db.insert(t.payments).values({
      orderId: order!.id, provider: "klix", channel: "web", status: "expired",
      amountCents: inv.totalCents, providerStatus: "expired", method: null,
      createdAt: hours(-8), updatedAt: hours(-6),
    });
  }

  // O2 — aija: оплачен, готов к выдаче; талон очереди уже на табло.
  {
    const o = await makeOrder({
      sku: "DEMO-ORD-02", itemStatus: "paid", customerKey: "aija", status: "paid",
      createdDaysAgo: 2, paidDaysAgo: 1, pickupCode: "418209", pickupDeadlineDays: 13,
      attribution: { source: "google", medium: "cpc", campaign: "vasara_lv" },
    });
    await paidPayment(o.id, o.inv.totalCents, "swedbank_lv_pis", 1);
    await makeInvoice(o, { name: "Aija Demo", address: "Brīvības iela 1-1, Rīga", country: "LV" });
    const dayKey = now.toISOString().slice(0, 10);
    const [ticket] = await db
      .insert(t.pickupTickets)
      .values({ number: 501, dayKey, customerId: ids.aija!, status: "waiting", checkedInVia: "kiosk" })
      .onConflictDoNothing()
      .returning({ id: t.pickupTickets.id });
    if (ticket) {
      await db.insert(t.pickupTicketItems).values({ ticketId: ticket.id, orderId: o.id, itemId: o.itemId, status: "pending" });
    }
  }

  // O3 — marks: посылка Omniva в пути.
  {
    const o = await makeOrder({
      sku: "DEMO-ORD-03", itemStatus: "shipped", customerKey: "marks", status: "paid",
      createdDaysAgo: 3, paidDaysAgo: 2, fulfilment: "omniva_pm", shippingCents: 349,
      shippingTo: { provider: "omniva", machineId: "88817", name: "Rīga Alfa pakomāts", zip: "LV-1005", country: "LV" },
      recipientName: "Marks Demo", recipientPhone: "+37120000001",
      attribution: { source: "facebook", medium: "paid_social", campaign: "atlaides" },
      // Привела реклама, а вернула рассылка — ровно тот случай, ради которого
      // в отчёте есть вторая модель.
      attributionLast: { source: "email", medium: "email", campaign: "izsoli_digest" },
    });
    await paidPayment(o.id, o.inv.totalCents, "klix card", 2);
    await makeInvoice(o, { name: "Marks Demo", address: "Lāčplēša iela 25-7, Rīga", country: "LV" });
    await db.insert(t.shipments).values({
      orderId: o.id, provider: "omniva", barcode: "CC900100200LV", status: "in_transit",
      providerStatus: "PACKET_IN_TRANSIT",
      events: [
        { code: "PACKET_IN_TRANSIT", at: days(-1).toISOString(), description: "Ceļā uz pakomātu", location: "Rīga ST" },
        { code: "PACKET_REGISTERED", at: days(-2).toISOString(), description: "Reģistrēts nosūtīšanai" },
      ],
      labelPrintedAt: days(-2), createdAt: days(-2), updatedAt: days(-1),
    });
  }

  // O4 — telegram-клиент: DPD доставлен, забран из автомата.
  {
    const o = await makeOrder({
      sku: "DEMO-ORD-04", itemStatus: "delivered", customerKey: "telegram", status: "paid",
      createdDaysAgo: 9, paidDaysAgo: 8, fulfilment: "dpd_pm", shippingCents: 299,
      shippingTo: { provider: "dpd", machineId: "LV90005", name: "DPD Paku Skapis Origo", zip: "LV-1050", country: "LV" },
      recipientName: "Telegram Demo", recipientPhone: "+37120000002",
    });
    await paidPayment(o.id, o.inv.totalCents, "klix_pay_later", 8);
    await makeInvoice(o, { name: "Telegram Demo", country: "LV" });
    await db.insert(t.shipments).values({
      orderId: o.id, provider: "dpd", barcode: "05806002345678", status: "delivered",
      providerStatus: "DELIVERED",
      events: [
        { code: "DELIVERED", at: days(-6).toISOString(), description: "Izsniegts saņēmējam", location: "Rīga, Origo" },
        { code: "AT_POINT", at: days(-7).toISOString(), description: "Piegādāts paku skapī" },
        { code: "IN_TRANSIT", at: days(-8).toISOString(), description: "Ceļā" },
      ],
      labelPrintedAt: days(-8), createdAt: days(-8), updatedAt: days(-6),
    });
  }

  // O5 — удалённый клиент: старый закрытый заказ, в панели остаются снимки.
  {
    const o = await makeOrder({
      sku: "DEMO-ORD-05", itemStatus: "closed", customerKey: "izdzests", status: "paid",
      createdDaysAgo: 40, paidDaysAgo: 39, pickupCode: "770011",
    });
    await paidPayment(o.id, o.inv.totalCents, "cash", 39);
    await makeInvoice(o, { name: "Dzēsts klients", country: "LV" });
  }

  // O6 — marks: крупногабарит, фрахт по адресу, ждёт оплаты.
  await makeOrder({
    sku: "DEMO-ORD-06", itemStatus: "awaiting_payment", customerKey: "marks", status: "awaiting_payment",
    createdDaysAgo: 0, paymentDeadlineHours: 70, fulfilment: "freight",
    shippingCents: 4_500, handlingCents: 1_000,
    shippingTo: { provider: "freight", machineId: "", name: "Marks Demo", zip: "LV-1011", country: "LV", address: "Lāčplēša iela 25-7", city: "Rīga", accessNote: "3. stāvs bez lifta, šauras kāpnes" },
    recipientName: "Marks Demo", recipientPhone: "+37120000001",
    creditAppliedCents: 2_000,
  });

  // O7 — tomas-должник: не оплатил в срок, заказ отменён, висит restock 5%.
  {
    const o = await makeOrder({
      sku: "DEMO-ORD-07", itemStatus: "unpaid_cancelled", customerKey: "tomas", status: "cancelled",
      createdDaysAgo: 6, cancelReason: "unpaid", restockFeeCents: 2_723,
    });
    await db.insert(t.customerFees).values({
      customerId: ids.tomas!, orderId: o.id, orderRef: o.ref, type: "unpaid_restock",
      amountCents: 2_723, status: "outstanding", note: "auto: payment deadline passed",
      createdAt: days(-3),
    });
  }

  // O8 — liene: оплатила, не забрала 14 дней — отмена, 5% удержано, остаток возвращён.
  {
    const o = await makeOrder({
      sku: "DEMO-ORD-08", itemStatus: "no_pickup_cancelled", customerKey: "atteicies", status: "cancelled",
      createdDaysAgo: 20, paidDaysAgo: 19, cancelReason: "no_pickup", restockFeeCents: 1_210,
    });
    await paidPayment(o.id, o.inv.totalCents, "klix card", 19);
    await makeInvoice(o, { name: "Liene Demo", country: "LV" });
    await db.insert(t.customerFees).values({
      customerId: ids.atteicies!, orderId: o.id, orderRef: o.ref, type: "no_pickup_restock",
      amountCents: 1_210, status: "settled", note: "ieturēts no atmaksas", settledAt: days(-5), createdAt: days(-5),
    });
    await db.insert(t.refunds).values({
      orderId: o.id, amountCents: o.inv.totalCents - 1_210, reason: "nav izņemts 14 dienās — atmaksa bez 5% maksas", createdAt: days(-5),
    });
  }

  // O9 — rihards (до блокировки): возврат решён, деньги вернули полностью.
  {
    const o = await makeOrder({
      sku: "DEMO-ORD-09", itemStatus: "returned", customerKey: "bloketais", status: "refunded",
      createdDaysAgo: 15, paidDaysAgo: 14,
    });
    await paidPayment(o.id, o.inv.totalCents, "klix card", 14);
    await makeInvoice(o, { name: "Rihards Demo", country: "LV" });
    await db.insert(t.refunds).values({ orderId: o.id, amountCents: o.inv.totalCents, reason: "prece neatbilda aprakstam", createdAt: days(-11) });
    await db.insert(t.returnCases).values({
      ref: `RET-${String(await bump(db, "return_ref")).padStart(4, "0")}`,
      orderId: o.id, orderRef: o.ref, itemId: o.itemId, customerId: ids.bloketais!,
      customerAlias: "demo_rihards", reason: "not_as_described",
      note: "Skaļrunim nedarbojas Bluetooth — aprakstā nebija minēts.",
      status: "resolved", decision: "refund_full", refundCents: o.inv.totalCents,
      destination: "quarantine", refundMethod: "klix", withinWindow: true,
      openedByLabel: "Support Demo", resolvedByLabel: "Support Demo",
      createdAt: days(-12), resolvedAt: days(-11),
    });
  }

  // O10 — aija: доставлено, открыта жалоба «повреждено» — решения ещё нет.
  {
    const o = await makeOrder({
      sku: "DEMO-ORD-10", itemStatus: "delivered", customerKey: "aija", status: "paid",
      createdDaysAgo: 8, paidDaysAgo: 7, pickupCode: "515151",
    });
    await paidPayment(o.id, o.inv.totalCents, "swedbank_lv_pis", 7);
    await makeInvoice(o, { name: "Aija Demo", address: "Brīvības iela 1-1, Rīga", country: "LV" });
    await db.insert(t.returnCases).values({
      ref: `RET-${String(await bump(db, "return_ref")).padStart(4, "0")}`,
      orderId: o.id, orderRef: o.ref, itemId: o.itemId, customerId: ids.aija!,
      customerAlias: "demo_aija", reason: "damaged",
      note: "Vienam koferim ieplīsis ritenis — pamanīju mājās.",
      status: "open", withinWindow: true, openedByLabel: "Support Demo", createdAt: days(-1),
    });
  }

  // O11 — ruta, B2B Igaunija: reverse charge — счёт фирме без латвийского НДС.
  {
    const o = await makeOrder({
      sku: "DEMO-ORD-11", itemStatus: "paid", customerKey: "ruta", status: "paid",
      createdDaysAgo: 4, paidDaysAgo: 3, reverseCharge: true, pickupCode: "606060", pickupDeadlineDays: 10,
      billingSnapshot: {
        kind: "company", name: "Demo Trade OÜ", regNo: "14098765", vatNo: "EE102030405",
        address: "Tartu mnt 2", city: "Tallinn", zip: "10145", country: "EE",
        invoiceEmail: "invoices@demo.izsoli.lv",
      },
    });
    await paidPayment(o.id, o.inv.totalCents, "lhv_ee_pis", 3);
    await makeInvoice(o, { name: "Demo Trade OÜ", company: "Demo Trade OÜ", vatNo: "EE102030405", regNo: "14098765", address: "Tartu mnt 2, Tallinn", country: "EE" });
  }

  // ── Склад и закупки: поставщик и открытая поставка ────────────────────────
  const [supplier] = await db
    .insert(t.suppliers)
    .values({
      name: "Demo piegādātājs SIA", regNo: "40001234567", vatNo: "LV40001234567",
      email: "supply@demo.izsoli.lv", phone: "+37167000000",
      address: "Maskavas iela 250, Rīga", paymentTermsDays: 30,
      notes: "Демо-поставщик для проверки приёмки", active: true,
    })
    .onConflictDoNothing()
    .returning({ id: t.suppliers.id });
  if (supplier) {
    await db.insert(t.consignments).values({
      ref: `CON-${String(await bump(db, "consignment_ref")).padStart(4, "0")}`,
      supplier: "Demo piegādātājs SIA", supplierId: supplier.id,
      marketCode: "LV", status: "open", expectedCount: 24,
      extraCostCents: 8_500, notes: "Palete ar elektroniku — demo priekš приёмки",
    });
  }

  // ── Реклама в ленте ───────────────────────────────────────────────────────
  await db.insert(t.adCards).values({
    advertiser: "Demo", title: "Piegāde uz pakomātu no 2,99 €",
    body: "Omniva un DPD visā Latvijā — izvēlies skapīti pie kases.",
    ctaLabel: "Kā tas strādā", href: "/piegade", kind: "banner",
    showLabel: false, theme: "green", everyN: 10, active: true,
    startsAt: days(-1), endsAt: days(30),
  });

  // ── Витрина исходящих писем в панели ──────────────────────────────────────
  await db.insert(t.notifications).values([
    {
      customerId: ids.aija!, type: "won", toEmail: "aija@demo.izsoli.lv", lang: "lv",
      subject: "Apsveicam — Longines Master Collection ir jūsu!",
      body: "Pasūtījums gaida apmaksu 72 stundu laikā. [won]",
      status: "sent", sentAt: hours(-10), attempts: 1, createdAt: hours(-10),
    },
    {
      customerId: ids.aija!, type: "payment_reminder", toEmail: "aija@demo.izsoli.lv", lang: "lv",
      subject: "Atgādinājums: apmaksa līdz rītdienai",
      body: "Pasūtījuma apmaksas termiņš tuvojas. [payment_reminder]",
      status: "pending", createdAt: now,
    },
    {
      customerId: ids.marks!, type: "saved_search_hits", kind: "marketing", toEmail: "marks@demo.izsoli.lv", lang: "ru",
      subject: "Новые лоты: LEGO Technic (2)",
      body: "По вашему сохранённому поиску появились новые лоты. [saved_search_hits]",
      status: "pending", scheduledFor: hours(20), createdAt: now,
    },
  ]);

  await db.insert(t.auditLog).values({
    actorLabel: "System", type: "settings", action: "seed_demo_world", target: "database",
    detail: { orders: orderRefs.length, clients: CLIENTS.length + 1 },
  });

  console.log(`демо-мир создан: ${CLIENTS.length + 1} клиентов, ${orderRefs.length} заказов (${orderRefs.join(", ")})`);
  console.log(`пароль всех демо-клиентов: ${DEMO_PASSWORD}`);
}

async function remove(db: Db): Promise<void> {
  // Заказы находим по артикулам лотов DEMO-ORD-*.
  const demoItems = await db.select({ id: t.items.id }).from(t.items).where(like(t.items.sku, "DEMO-ORD-%"));
  const itemIds = demoItems.map((i) => i.id);

  if (itemIds.length > 0) {
    const demoOrders = await db.select({ id: t.orders.id }).from(t.orders).where(inArray(t.orders.itemId, itemIds));
    const orderIds = demoOrders.map((o) => o.id);
    if (orderIds.length > 0) {
      // Сначала всё, что смотрит на заказ без каскада, потом сами заказы.
      const tickets = await db.select({ ticketId: t.pickupTicketItems.ticketId }).from(t.pickupTicketItems).where(inArray(t.pickupTicketItems.orderId, orderIds));
      await db.delete(t.pickupTicketItems).where(inArray(t.pickupTicketItems.orderId, orderIds));
      const ticketIds = [...new Set(tickets.map((x) => x.ticketId))];
      if (ticketIds.length > 0) await db.delete(t.pickupTickets).where(inArray(t.pickupTickets.id, ticketIds));
      await db.delete(t.returnCases).where(inArray(t.returnCases.orderId, orderIds));
      await db.delete(t.customerFees).where(inArray(t.customerFees.orderId, orderIds));
      await db.delete(t.invoices).where(inArray(t.invoices.orderId, orderIds));
      await db.delete(t.orders).where(inArray(t.orders.id, orderIds)); // payments/refunds/shipments — каскадом
    }
    const demoListings = await db.select({ id: t.listings.id }).from(t.listings).where(inArray(t.listings.itemId, itemIds));
    const listingIds = demoListings.map((l) => l.id);
    if (listingIds.length > 0) {
      const demoAuctions = await db.select({ id: t.auctions.id }).from(t.auctions).where(inArray(t.auctions.listingId, listingIds));
      const auctionIds = demoAuctions.map((a) => a.id);
      if (auctionIds.length > 0) {
        await db.delete(t.bids).where(inArray(t.bids.auctionId, auctionIds));
        await db.delete(t.auctions).where(inArray(t.auctions.id, auctionIds));
      }
      await db.delete(t.listings).where(inArray(t.listings.id, listingIds));
    }
    await db.delete(t.items).where(inArray(t.items.id, itemIds));
    console.log(`удалено ${itemIds.length} демо-лотов заказов`);
  }

  // Клиенты — кроме тех, у кого остались ставки или заказы вне демо-мира
  // (например, поставленные на лотах demoCatalog): их трогать нельзя.
  const demoCustomers = await db
    .select({ id: t.customers.id, email: t.customers.email })
    .from(t.customers)
    .where(or(like(t.customers.email, "%@demo.izsoli.lv"), like(t.customers.email, "demo.%@nav.izsoli.lv")));
  let removed = 0;
  for (const c of demoCustomers) {
    const [bids] = await db.select({ n: sql<string>`count(*)` }).from(t.bids).where(eq(t.bids.customerId, c.id));
    const [orders] = await db.select({ n: sql<string>`count(*)` }).from(t.orders).where(eq(t.orders.customerId, c.id));
    if (Number(bids?.n ?? 0) === 0 && Number(orders?.n ?? 0) === 0) {
      await db.delete(t.customers).where(eq(t.customers.id, c.id));
      removed++;
    }
  }
  console.log(`удалено ${removed} демо-клиентов из ${demoCustomers.length}`);

  await db.delete(t.adCards).where(eq(t.adCards.advertiser, "Demo"));
  const demoSuppliers = await db.select({ id: t.suppliers.id }).from(t.suppliers).where(eq(t.suppliers.name, "Demo piegādātājs SIA"));
  for (const s of demoSuppliers) {
    await db.delete(t.consignments).where(and(eq(t.consignments.supplierId, s.id), isNull(t.consignments.closedAt)));
    await db.delete(t.suppliers).where(eq(t.suppliers.id, s.id));
  }
  console.log("реклама и демо-поставщик убраны");
}

const { db, pool } = createDb();
try {
  if (MODE === "remove") await remove(db);
  else await create(db);
} finally {
  await pool.end();
}
