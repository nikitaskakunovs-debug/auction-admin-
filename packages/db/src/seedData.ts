import {
  DEFAULT_MARKETS,
  DEFAULT_ROLE_PERMISSIONS,
  ROLE_LABELS,
  ROLE_IDS,
  computeInvoice,
  resolveBid,
  type BidState,
  type LedgerEntry,
} from "@auction/domain";
import { sql } from "drizzle-orm";
import type { Db } from "./client.js";
import { hashPassword } from "./password.js";
import * as t from "./schema.js";

/** Demo admin password for every seeded role user (dev/staging only). */
export const SEED_ADMIN_PASSWORD = "Admin123!";

/**
 * Fixed TOTP secret the seeded demo admins enroll with, so dev/test can
 * compute a valid 2FA code deterministically (add it to an authenticator, or
 * derive the code in code). DEV/STAGING ONLY — real admins created through the
 * API start with 2FA off and enroll their own unique secret on first login.
 */
export const SEED_ADMIN_TOTP_SECRET = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";

const ROLE_EMAILS: Record<string, string> = {
  super_admin: "super@auction.test",
  listing_manager: "listings@auction.test",
  sales_manager: "sales@auction.test",
  operations: "ops@auction.test",
  content_editor: "content@auction.test",
  support: "support@auction.test",
  finance: "finance@auction.test",
};

interface SeedOptions {
  /** Skip demo data (markets/roles/users are always ensured). */
  demoData?: boolean;
  now?: Date;
}

export async function seedDatabase(db: Db, opts: SeedOptions = {}): Promise<void> {
  const demoData = opts.demoData ?? true;
  const now = opts.now ?? new Date();

  // ── Markets ────────────────────────────────────────────────────────────────
  for (const m of DEFAULT_MARKETS) {
    await db
      .insert(t.markets)
      .values({
        code: m.code,
        name: m.name,
        legalName: m.legalName,
        currency: m.currency,
        languages: [...m.languages],
        vatRateBp: m.vatRateBp,
        buyerPremiumBp: m.buyerPremiumBp,
        antiSnipeSec: m.antiSnipeSec,
        incrementTable: [...m.incrementTable],
      })
      .onConflictDoNothing();
  }

  // ── Roles + permissions + one admin user per role ─────────────────────────
  for (const roleId of ROLE_IDS) {
    await db
      .insert(t.adminRoles)
      .values({ id: roleId, label: ROLE_LABELS[roleId] })
      .onConflictDoNothing();
    for (const permission of DEFAULT_ROLE_PERMISSIONS[roleId]) {
      await db.insert(t.rolePermissions).values({ roleId, permission }).onConflictDoNothing();
    }
    await db
      .insert(t.adminUsers)
      .values({
        email: ROLE_EMAILS[roleId]!,
        name: ROLE_LABELS[roleId],
        passwordHash: await hashPassword(SEED_ADMIN_PASSWORD),
        roleId,
        totpSecret: SEED_ADMIN_TOTP_SECRET,
        totpEnabled: true,
      })
      .onConflictDoNothing();
  }

  await db.insert(t.counters).values({ key: "order_ref", value: 1000 }).onConflictDoNothing();

  if (!demoData) return;

  // ── CMS starter pages ──────────────────────────────────────────────────────
  const L = (lv: string, ru: string, en: string) => ({ lv, ru, en });
  await db
    .insert(t.cmsPages)
    .values([
      {
        slug: "about",
        title: L("Par mums", "О нас", "About us"),
        status: "published",
        position: 1,
        blocks: [
          { type: "heading", text: L("Baltijas izsoļu nams", "Балтийский аукционный дом", "The Baltic auction house") },
          {
            type: "text",
            text: L(
              "Mēs rīkojam tiešsaistes izsoles Latvijā, Igaunijā un Lietuvā — pulksteņi, māksla, dizains un kolekcionējami priekšmeti no mūsu noliktavas Rīgā.",
              "Мы проводим онлайн-аукционы в Латвии, Эстонии и Литве — часы, искусство, дизайн и коллекционные предметы с нашего склада в Риге.",
              "We run online auctions across Latvia, Estonia and Lithuania — watches, art, design and collectibles from our Riga warehouse.",
            ),
          },
        ],
        seo: {
          title: L("Par mums · Baltijas izsoļu nams", "О нас · Балтийский аукционный дом", "About us · Baltic Auction House"),
          description: L(
            "Tiešsaistes izsoles Baltijā kopš pirmās dienas — godīgi soļi, slēptas rezerves cenas un tiešraides solīšana.",
            "Онлайн-аукционы в Балтии — честные шаги, скрытые резервы и живые торги.",
            "Online auctions in the Baltics — fair increments, hidden reserves and live bidding.",
          ),
        },
      },
      {
        slug: "how-to-bid",
        title: L("Kā solīt", "Как делать ставки", "How to bid"),
        status: "published",
        position: 2,
        blocks: [
          { type: "heading", text: L("Kā darbojas solīšana", "Как работают ставки", "How bidding works") },
          {
            type: "text",
            text: L(
              "Norādiet savu maksimālo cenu — sistēma solīs jūsu vietā ar minimālo soli, tikai tik, cik nepieciešams, lai saglabātu vadību.",
              "Укажите свой максимум — система будет ставить за вас с минимальным шагом, ровно столько, сколько нужно, чтобы сохранить лидерство.",
              "Enter your maximum bid — the system bids on your behalf by the minimum increment, only as much as needed to keep you in the lead.",
            ),
          },
          {
            type: "faq",
            question: L("Kas ir rezerves cena?", "Что такое резервная цена?", "What is a reserve price?"),
            answer: L(
              "Slēpta minimālā pārdošanas cena. Ja tā nav sasniegta, izsole beidzas bez uzvarētāja.",
              "Скрытая минимальная цена продажи. Если она не достигнута, аукцион завершается без победителя.",
              "A hidden minimum selling price. If it is not met, the auction ends without a winner.",
            ),
          },
          {
            type: "faq",
            question: L("Kas notiek pēdējā minūtē?", "Что происходит в последнюю минуту?", "What happens in the last minute?"),
            answer: L(
              "Solījums pēdējās 60 sekundēs automātiski pagarina izsoli — nolauzt beigas nav iespējams.",
              "Ставка в последние 60 секунд автоматически продлевает аукцион — «снайпинг» не работает.",
              "A bid in the final 60 seconds automatically extends the auction — sniping does not work.",
            ),
          },
        ],
        seo: {
          title: L("Kā solīt · Baltijas izsoļu nams", "Как делать ставки", "How to bid · Baltic Auction House"),
          description: L("Soli pa solim: reģistrācija, maksimālā cena, uzvara un apmaksa.", "Пошагово: регистрация, максимум, победа и оплата.", "Step by step: register, set your max, win and pay."),
        },
      },
      {
        slug: "terms",
        title: L("Noteikumi", "Условия", "Terms"),
        status: "draft",
        position: 3,
        blocks: [
          { type: "heading", text: L("Lietošanas noteikumi", "Условия использования", "Terms of service") },
          { type: "text", text: L("Melnraksts — juridiskais teksts tiks pievienots.", "Черновик — юридический текст будет добавлен.", "Draft — legal copy to be added.") },
        ],
      },
    ])
    .onConflictDoNothing();


  // Demo data is not idempotent per-row; bail if items already exist.
  const existing = await db.select({ n: sql<number>`count(*)` }).from(t.items);
  if (Number(existing[0]!.n) > 0) return;

  // ── Customers (bidders) ────────────────────────────────────────────────────
  const customerRows = await db
    .insert(t.customers)
    .values([
      { email: "anna@example.test", alias: "anna_r", name: "Anna Roze", country: "LV", marketCode: "LV" },
      { email: "juris@example.test", alias: "collector_j", name: "Juris Kalniņš", country: "LV", marketCode: "LV" },
      { email: "mart@example.test", alias: "mart_ee", name: "Mart Tamm", country: "EE", marketCode: "EE", company: "Tamm Antiik OÜ", vatNo: "EE123456789" },
      { email: "greta@example.test", alias: "greta_lt", name: "Greta Petrauskaitė", country: "LT", marketCode: "LT" },
      { email: "olga@example.test", alias: "olga_v", name: "Olga Vasiljeva", country: "LV", marketCode: "LV" },
      { email: "tomas@example.test", alias: "tomas_b", name: "Tomas Butkus", country: "LT", marketCode: "LT", strikes: 1 },
    ])
    .returning({ id: t.customers.id, alias: t.customers.alias });
  const byAlias = Object.fromEntries(customerRows.map((c) => [c.alias, c.id]));

  // ── Items ──────────────────────────────────────────────────────────────────
  const itemDefs = [
    { sku: "LOT-0001", title: "Rolex Datejust 36 ref. 16234, 1994", condition: "very good", location: "A-01-03", weightGrams: 350, status: "live" },
    { sku: "LOT-0002", title: "Jāzeps Grosvalds — Watercolour, signed", condition: "good", location: "B-02-01", weightGrams: 1200, status: "live" },
    { sku: "LOT-0003", title: "Art Deco walnut sideboard, 1930s", condition: "restored", location: "C-01-01", weightGrams: 48000, status: "live" },
    { sku: "LOT-0004", title: "Soviet-era Zenit-E camera kit", condition: "working", location: "A-03-11", weightGrams: 1500, status: "listed" },
    { sku: "LOT-0005", title: "Baltic amber necklace, 52 g", condition: "excellent", location: "S-01-02", weightGrams: 80, status: "won" },
    { sku: "LOT-0006", title: "Kuznetsov porcelain tea service, 12 pcs", condition: "good", location: "B-01-07", weightGrams: 4200, status: "listed" },
    { sku: "LOT-0007", title: "Omega Seamaster DeVille, 1967", condition: "serviced", location: "A-01-04", weightGrams: 300, status: "draft" },
    { sku: "LOT-0008", title: "Mid-century teak lounge chair", condition: "original", location: "C-02-03", weightGrams: 9000, status: "draft" },
    { sku: "LOT-0009", title: "WWII-era field binoculars, cased", condition: "good", location: "A-04-01", weightGrams: 1100, status: "unsold" },
    { sku: "LOT-0010", title: "Riga silver spoon set, 875 hallmark", condition: "excellent", location: "S-01-05", weightGrams: 400, status: "listed" },
  ] as const;
  const itemRows = await db
    .insert(t.items)
    .values(itemDefs.map((d) => ({ ...d, marketCode: "LV", description: `${d.title}. Consigned to the warehouse; see condition report.`, photos: [] })))
    .returning({ id: t.items.id, sku: t.items.sku });
  const itemBySku = Object.fromEntries(itemRows.map((i) => [i.sku, i.id]));

  const hours = (n: number) => new Date(now.getTime() + n * 3_600_000);

  // Helper: create an auction listing + auction, replaying bids through the
  // domain resolver so seeded state is exactly what the engine would produce.
  async function seedAuction(args: {
    sku: string;
    title: string;
    startPriceCents: number;
    reserveCents?: number | null;
    startsAt: Date;
    endsAt: Date;
    status: "scheduled" | "live" | "ended_won";
    bids: Array<{ alias: string; maxCents: number }>;
  }) {
    const [listing] = await db
      .insert(t.listings)
      .values({
        itemId: itemBySku[args.sku]!,
        type: "auction",
        title: args.title,
        marketCode: "LV",
        startPriceCents: args.startPriceCents,
        reserveCents: args.reserveCents ?? null,
        status: "published",
      })
      .returning({ id: t.listings.id });

    let state: BidState = {
      startPriceCents: args.startPriceCents,
      reserveCents: args.reserveCents ?? null,
      currentPriceCents: null,
      leader: null,
    };
    const ledger: Array<LedgerEntry & { seq: number; maxCents: number }> = [];
    let seq = 0;
    for (const b of args.bids) {
      const r = resolveBid(state, { bidderId: byAlias[b.alias]!, maxCents: b.maxCents, seq: ++seq });
      if (!r.ok) throw new Error(`seed bid rejected: ${b.alias} ${b.maxCents} → ${r.code}`);
      state = r.state;
      for (const row of r.ledger) ledger.push({ ...row, seq, maxCents: row.bidderId === byAlias[b.alias] ? b.maxCents : state.leader!.maxCents });
    }

    const [auction] = await db
      .insert(t.auctions)
      .values({
        listingId: listing!.id,
        status: args.status,
        startsAt: args.startsAt,
        endsAt: args.endsAt,
        currentPriceCents: state.currentPriceCents,
        leaderCustomerId: state.leader ? state.leader.bidderId : null,
        leaderMaxCents: state.leader ? state.leader.maxCents : null,
        leaderSeq: state.leader ? state.leader.seq : null,
        bidCount: seq,
        reserveMet: state.reserveCents === null ? state.leader !== null : (state.leader?.maxCents ?? 0) >= state.reserveCents,
        closedAt: args.status === "ended_won" ? args.endsAt : null,
      })
      .returning({ id: t.auctions.id });

    // Earlier ledger rows for the same bidder that were later outbid stay marked.
    for (const row of ledger) {
      await db.insert(t.bids).values({
        auctionId: auction!.id,
        customerId: row.bidderId,
        amountCents: row.amountCents,
        maxCents: row.maxCents,
        auto: row.auto,
        outbid: row.outbid || (state.leader !== null && row.bidderId !== state.leader.bidderId),
        seq: row.seq,
      });
    }
    return { listingId: listing!.id, auctionId: auction!.id, state };
  }

  // Two live auctions with real bid battles.
  await seedAuction({
    sku: "LOT-0001",
    title: "Rolex Datejust 36 ref. 16234, 1994",
    startPriceCents: 150_000,
    reserveCents: 250_000,
    startsAt: hours(-20),
    endsAt: hours(6),
    status: "live",
    bids: [
      { alias: "anna_r", maxCents: 180_000 },
      { alias: "collector_j", maxCents: 260_000 },
      { alias: "anna_r", maxCents: 255_000 },
    ],
  });
  await seedAuction({
    sku: "LOT-0002",
    title: "Jāzeps Grosvalds — Watercolour, signed",
    startPriceCents: 40_000,
    startsAt: hours(-4),
    endsAt: hours(0.5),
    status: "live",
    bids: [
      { alias: "greta_lt", maxCents: 40_000 },
      { alias: "olga_v", maxCents: 55_000 },
    ],
  });
  await seedAuction({
    sku: "LOT-0003",
    title: "Art Deco walnut sideboard, 1930s",
    startPriceCents: 90_000,
    startsAt: hours(-1),
    endsAt: hours(48),
    status: "live",
    bids: [],
  });
  // Scheduled for tomorrow.
  await seedAuction({
    sku: "LOT-0006",
    title: "Kuznetsov porcelain tea service, 12 pcs",
    startPriceCents: 12_000,
    startsAt: hours(24),
    endsAt: hours(48),
    status: "scheduled",
    bids: [],
  });

  // An ended auction with a winner + order awaiting payment.
  const won = await seedAuction({
    sku: "LOT-0005",
    title: "Baltic amber necklace, 52 g",
    startPriceCents: 8_000,
    startsAt: hours(-72),
    endsAt: hours(-2),
    status: "ended_won",
    bids: [
      { alias: "mart_ee", maxCents: 15_000 },
      { alias: "olga_v", maxCents: 12_000 },
    ],
  });
  const hammer = won.state.currentPriceCents!;
  const inv = computeInvoice({ hammerCents: hammer, buyerPremiumBp: 1_000, vatRateBp: 2_100 });
  const winnerId = won.state.leader!.bidderId;
  await db.insert(t.orders).values({
    ref: "A-1001",
    auctionId: won.auctionId,
    listingId: won.listingId,
    itemId: itemBySku["LOT-0005"]!,
    customerId: winnerId,
    customerAlias: "mart_ee",
    customerEmail: "mart@example.test",
    marketCode: "LV",
    hammerCents: inv.hammerCents,
    premiumCents: inv.premiumCents,
    vatCents: inv.vatCents,
    vatRateBp: inv.vatRateBp,
    shippingCents: 0,
    totalCents: inv.totalCents,
    status: "awaiting_payment",
    paymentDeadlineAt: hours(70),
  });
  await db.update(t.counters).set({ value: 1001 }).where(sql`${t.counters.key} = 'order_ref'`);

  // Fixed-price listing.
  await db.insert(t.listings).values({
    itemId: itemBySku["LOT-0010"]!,
    type: "fixed",
    title: "Riga silver spoon set, 875 hallmark",
    marketCode: "LV",
    priceCents: 22_000,
    quantity: 1,
    status: "published",
  });

  await db.insert(t.auditLog).values({
    actorLabel: "System",
    type: "settings",
    action: "seed",
    target: "database",
    detail: { note: "demo data seeded" },
  });
}
