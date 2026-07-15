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
  /** Skip demo data (markets/roles are always ensured). */
  demoData?: boolean;
  /**
   * Create the 7 demo role admins with the PUBLISHED password + fixed TOTP
   * secret. Dev/test convenience only — MUST stay off in production (the
   * seed CLI enforces this; see seed.ts).
   */
  demoAdmins?: boolean;
  now?: Date;
}

export async function seedDatabase(db: Db, opts: SeedOptions = {}): Promise<void> {
  const demoData = opts.demoData ?? true;
  const demoAdmins = opts.demoAdmins ?? true;
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
        pickupDeadlineDays: m.pickupDeadlineDays,
        restockFeeBp: m.restockFeeBp,
      })
      .onConflictDoNothing();
  }

  // ── Warehouse locations (FRONT/BACK zones the pickup boards count) ────────
  for (const zone of ["FRONT", "BACK"] as const) {
    for (const aisle of ["A1", "A2"]) {
      for (const shelf of ["S1", "S2"]) {
        await db
          .insert(t.warehouseLocations)
          .values({ zone, aisle, rack: "R1", shelf, label: `${zone}-${aisle}-R1-${shelf}` })
          .onConflictDoNothing();
      }
    }
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
    if (demoAdmins) {
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
  }

  await db.insert(t.counters).values({ key: "order_ref", value: 1000 }).onConflictDoNothing();
  // Receiving: auto-SKU + consignment refs. sku starts above the demo LOT-00xx range.
  await db.insert(t.counters).values({ key: "sku", value: 100 }).onConflictDoNothing();
  await db.insert(t.counters).values({ key: "consignment_ref", value: 0 }).onConflictDoNothing();

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
          { type: "heading", text: L("Izsoli.lv", "Izsoli.lv", "Izsoli.lv") },
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
          title: L("Par mums · Izsoli.lv", "О нас · Izsoli.lv", "About us · Izsoli.lv"),
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
          title: L("Kā solīt · Izsoli.lv", "Как делать ставки", "How to bid · Izsoli.lv"),
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
    { sku: "LOT-0001", category: "jewellery_watches", title: "Rolex Datejust 36 ref. 16234, 1994", condition: "lightly_used", conditionNotes: "Hairline scratches on the clasp; movement serviced 2023.", location: "A-01-03", weightGrams: 350, status: "live" },
    { sku: "LOT-0002", category: "art_antiques", title: "Jāzeps Grosvalds — Watercolour, signed", condition: "used", conditionNotes: "Light foxing at the lower margin; frame with minor chips.", location: "B-02-01", weightGrams: 1200, status: "live" },
    { sku: "LOT-0003", category: "furniture", title: "Art Deco walnut sideboard, 1930s", condition: "refurbished", conditionNotes: "", location: "C-01-01", weightGrams: 48000, status: "live" },
    { sku: "LOT-0004", category: "electronics", title: "Soviet-era Zenit-E camera kit", condition: "as_is_untested", conditionNotes: "", location: "A-03-11", weightGrams: 1500, status: "listed" },
    { sku: "LOT-0005", category: "jewellery_watches", title: "Baltic amber necklace, 52 g", condition: "open_package_inspected", conditionNotes: "", location: "S-01-02", weightGrams: 80, status: "won" },
    { sku: "LOT-0006", category: "art_antiques", title: "Kuznetsov porcelain tea service, 12 pcs", condition: "used_with_issue", conditionNotes: "One saucer with a hairline crack; gilding worn on two cups.", location: "B-01-07", weightGrams: 4200, status: "listed" },
    { sku: "LOT-0007", category: "jewellery_watches", title: "Omega Seamaster DeVille, 1967", condition: "refurbished", conditionNotes: "", location: "A-01-04", weightGrams: 300, status: "draft" },
    { sku: "LOT-0008", category: "furniture", title: "Mid-century teak lounge chair", condition: "previously_assembled", conditionNotes: "", location: "C-02-03", weightGrams: 9000, status: "draft" },
    { sku: "LOT-0009", category: "sports_outdoors", title: "WWII-era field binoculars, cased", condition: "used", conditionNotes: "Optics clear; leather case scuffed with worn strap.", location: "A-04-01", weightGrams: 1100, status: "unsold" },
    { sku: "LOT-0010", category: "art_antiques", title: "Riga silver spoon set, 875 hallmark", condition: "as_is", conditionNotes: "", location: "S-01-05", weightGrams: 400, status: "listed" },
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

/**
 * Production bootstrap: ensure exactly one real super admin exists, created
 * from env-provided credentials. 2FA starts unenrolled — the mandatory-2FA
 * login flow forces the owner to enroll their own secret on first sign-in.
 * No-op when any admin user already exists.
 */
export async function bootstrapAdmin(db: Db, email: string, password: string, name = "Owner"): Promise<"created" | "exists"> {
  const existing = await db.select({ id: t.adminUsers.id }).from(t.adminUsers).limit(1);
  if (existing.length > 0) return "exists";
  if (password.length < 12) throw new Error("INITIAL_ADMIN_PASSWORD must be at least 12 characters");
  await db.insert(t.adminUsers).values({
    email: email.toLowerCase(),
    name,
    passwordHash: await hashPassword(password),
    roleId: "super_admin",
  });
  await db.insert(t.auditLog).values({
    actorId: null,
    actorLabel: "System",
    type: "team",
    action: "bootstrap_admin",
    target: email.toLowerCase(),
  });
  return "created";
}

/**
 * Production starter content — real Izsoli.lv pages in lv/ru/en, seeded once
 * (slug conflicts are skipped, so re-running never overwrites edits made in
 * the admin). About + how-to-bid go live immediately; terms + privacy are
 * seeded as DRAFTS: they contain the operative clauses (10% premium, 72h
 * payment, 14-day pickup, 5% restock fee, zero-tolerance suspension, GDPR)
 * but MUST be reviewed by a lawyer before publishing.
 */
export async function seedStarterContent(db: Db): Promise<void> {
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
          { type: "heading", text: L("Izsoli.lv", "Izsoli.lv", "Izsoli.lv") },
          {
            type: "text",
            text: L(
              "Izsoli.lv ir tiešsaistes izsoļu nams, ko darbina Skakunov’s SIA. Pārdodam preces izsolēs un par fiksētu cenu — elektroniku, mēbeles, instrumentus un citas preces no mūsu noliktavas Rīgā. Katrai precei ir godīgs stāvokļa apraksts un fotogrāfijas.",
              "Izsoli.lv — интернет-аукцион компании Skakunov’s SIA. Мы продаём товары на аукционах и по фиксированной цене — электронику, мебель, инструменты и многое другое с нашего склада в Риге. У каждого лота честное описание состояния и фотографии.",
              "Izsoli.lv is an online auction house operated by Skakunov’s SIA. We sell goods by auction and at fixed prices — electronics, furniture, tools and more from our Riga warehouse. Every lot carries an honest condition grade and photos.",
            ),
          },
          {
            type: "text",
            text: L(
              "Uzvarētāji saņem preces mūsu noliktavā Rīgā, uzrādot saņemšanas kodu. Reģistrējieties, solījiet un laimīgu cenu!",
              "Победители получают товары на нашем складе в Риге по коду получения. Регистрируйтесь, делайте ставки — удачной цены!",
              "Winners collect their items at our Riga warehouse using a pickup code. Register, bid, and good luck!",
            ),
          },
        ],
        seo: {
          title: L("Par mums · Izsoli.lv", "О нас · Izsoli.lv", "About us · Izsoli.lv"),
          description: L(
            "Tiešsaistes izsoles Latvijā — godīgi soļi, stāvokļa apraksti un saņemšana Rīgā.",
            "Онлайн-аукционы в Латвии — честные ставки, описания состояния, выдача в Риге.",
            "Online auctions in Latvia — fair bidding, condition grading, pickup in Riga.",
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
              "Norādiet savu maksimālo cenu — sistēma solīs jūsu vietā ar minimālo soli, tikai tik, cik nepieciešams, lai jūs paliktu vadībā. Jūsu maksimālā cena citiem nav redzama.",
              "Укажите свой максимум — система будет ставить за вас с минимальным шагом, ровно столько, сколько нужно, чтобы вы оставались лидером. Ваш максимум никому не виден.",
              "Enter your maximum bid — the system bids for you by the minimum increment, only as much as needed to keep you in the lead. Your maximum is never shown to anyone.",
            ),
          },
          {
            type: "faq",
            question: L("Kas notiek izsoles beigās?", "Что происходит в конце аукциона?", "What happens at the end?"),
            answer: L(
              "Solījums pēdējās 60 sekundēs automātiski pagarina izsoli, tāpēc pēdējās sekundes triki nedarbojas. Uzvar augstākais solījums.",
              "Ставка в последние 60 секунд автоматически продлевает аукцион, поэтому «снайпинг» не работает. Побеждает высшая ставка.",
              "A bid in the final 60 seconds automatically extends the auction, so sniping does not work. The highest bid wins.",
            ),
          },
          {
            type: "faq",
            question: L("Cik man būs jāmaksā?", "Сколько я заплачу?", "How much will I pay?"),
            answer: L(
              "Nosolītā cena + 10% komisija, plus PVN. Precīza summa ir redzama rēķinā uzreiz pēc uzvaras. Apmaksas termiņš — 72 stundas.",
              "Цена молотка + комиссия 10%, плюс НДС. Точная сумма — в счёте сразу после победы. Срок оплаты — 72 часа.",
              "The hammer price + a 10% buyer’s premium, plus VAT. The exact total is on your invoice immediately after winning. Payment is due within 72 hours.",
            ),
          },
          {
            type: "faq",
            question: L("Kā saņemt preci?", "Как получить товар?", "How do I collect my item?"),
            answer: L(
              "Pēc apmaksas jūs saņemat 6 ciparu saņemšanas kodu. Ierodieties mūsu noliktavā Rīgā 14 dienu laikā, ievadiet kodu pašapkalpošanās kioskā, un jūsu pasūtījumu sagatavos dažu minūšu laikā.",
              "После оплаты вы получите 6-значный код получения. Приезжайте на наш склад в Риге в течение 14 дней, введите код в киоске самообслуживания — заказ соберут за несколько минут.",
              "After payment you receive a 6-digit pickup code. Visit our Riga warehouse within 14 days, enter the code at the self-service kiosk, and your order is picked within minutes.",
            ),
          },
          {
            type: "faq",
            question: L("Kas ir stāvokļa apzīmējumi?", "Что такое обозначения состояния?", "What are condition grades?"),
            answer: L(
              "Katra prece ir novērtēta pēc mūsu 16 pakāpju skalas — no pilnīgi jaunas līdz “kā ir”. Pilns apraksts: izsoli.lv/conditions.",
              "Каждый товар оценён по нашей 16-ступенчатой шкале — от совершенно нового до «как есть». Полное описание: izsoli.lv/conditions.",
              "Every item is graded on our 16-step scale — from brand new to as-is. Full reference: izsoli.lv/conditions.",
            ),
          },
        ],
        seo: {
          title: L("Kā solīt · Izsoli.lv", "Как делать ставки · Izsoli.lv", "How to bid · Izsoli.lv"),
          description: L(
            "Soli pa solim: maksimālā cena, 10% komisija, apmaksa 72h, saņemšana Rīgā 14 dienās.",
            "Пошагово: максимум, комиссия 10%, оплата 72 часа, получение в Риге за 14 дней.",
            "Step by step: set a maximum, 10% premium, pay in 72h, collect in Riga within 14 days.",
          ),
        },
      },
      {
        slug: "terms",
        title: L("Lietošanas noteikumi", "Условия использования", "Terms of service"),
        status: "draft",
        position: 3,
        blocks: [
          { type: "heading", text: L("Lietošanas noteikumi (projekts)", "Условия использования (проект)", "Terms of service (draft)") },
          {
            type: "text",
            text: L(
              "Pakalpojumu sniedz Skakunov’s SIA, Rīga (“Izsoli.lv”). Reģistrējoties jūs apliecināt, ka esat vismaz 18 gadus vecs un sniegtie dati ir patiesi.",
              "Услуги предоставляет Skakunov’s SIA, Рига («Izsoli.lv»). Регистрируясь, вы подтверждаете, что вам не менее 18 лет и предоставленные данные верны.",
              "The service is operated by Skakunov’s SIA, Riga (“Izsoli.lv”). By registering you confirm you are at least 18 years old and that the details you provide are accurate.",
            ),
          },
          {
            type: "text",
            text: L(
              "Solījums ir juridiski saistošs pirkuma piedāvājums. Uzvarot izsolē, jums 72 stundu laikā jāapmaksā rēķins: nosolītā cena + 10% komisija + PVN. Ja apmaksa netiek veikta termiņā, pasūtījums tiek atcelts un tiek piemērota atkārtotas izvietošanas maksa 5% apmērā no pasūtījuma kopsummas; konts tiek apturēts līdz tās nomaksai.",
              "Ставка — юридически обязывающее предложение о покупке. Выиграв, вы обязаны оплатить счёт в течение 72 часов: цена молотка + комиссия 10% + НДС. При неоплате заказ отменяется и взимается сбор за повторное размещение в размере 5% от суммы заказа; аккаунт приостанавливается до его оплаты.",
              "A bid is a legally binding offer to purchase. If you win, the invoice — hammer price + 10% buyer’s premium + VAT — is due within 72 hours. Unpaid orders are cancelled and a restocking fee of 5% of the order total applies; the account is paused until it is settled.",
            ),
          },
          {
            type: "text",
            text: L(
              "Apmaksātās preces jāizņem mūsu noliktavā Rīgā 14 dienu laikā. Ja prece netiek izņemta, pasūtījums tiek atcelts, tiek ieturēta 5% atkārtotas izvietošanas maksa, un atlikums tiek atmaksāts.",
              "Оплаченные товары необходимо забрать на нашем складе в Риге в течение 14 дней. Если товар не забран, заказ отменяется, удерживается сбор 5%, остаток возвращается.",
              "Paid items must be collected at our Riga warehouse within 14 days. Uncollected orders are cancelled, a 5% restocking fee is retained, and the remainder is refunded.",
            ),
          },
          {
            type: "text",
            text: L(
              "Preces tiek pārdotas ar norādīto stāvokļa novērtējumu (izsoli.lv/conditions) un piezīmēm. Agresīva, aizskaroša vai draudoša uzvedība pret darbiniekiem netiek pieļauta — konts var tikt apturēts nekavējoties.",
              "Товары продаются с указанной оценкой состояния (izsoli.lv/conditions) и примечаниями. Агрессивное, оскорбительное или угрожающее поведение по отношению к персоналу не допускается — аккаунт может быть приостановлен немедленно.",
              "Items are sold with the stated condition grade (izsoli.lv/conditions) and notes. Aggressive, abusive or threatening behaviour towards staff is not tolerated — accounts may be suspended immediately.",
            ),
          },
          {
            type: "text",
            text: L(
              "Noteikumiem piemērojami Latvijas Republikas tiesību akti. ⚠️ PROJEKTS — pirms publicēšanas jāapstiprina juristam.",
              "К условиям применяется право Латвийской Республики. ⚠️ ПРОЕКТ — перед публикацией требуется утверждение юриста.",
              "These terms are governed by the laws of the Republic of Latvia. ⚠️ DRAFT — must be approved by a lawyer before publishing.",
            ),
          },
        ],
        seo: {
          title: L("Noteikumi · Izsoli.lv", "Условия · Izsoli.lv", "Terms · Izsoli.lv"),
          description: L("Izsoli.lv lietošanas noteikumi.", "Условия использования Izsoli.lv.", "Izsoli.lv terms of service."),
        },
      },
      {
        slug: "privacy",
        title: L("Privātuma politika", "Политика конфиденциальности", "Privacy policy"),
        status: "draft",
        position: 4,
        blocks: [
          { type: "heading", text: L("Privātuma politika (projekts)", "Политика конфиденциальности (проект)", "Privacy policy (draft)") },
          {
            type: "text",
            text: L(
              "Datu pārzinis: Skakunov’s SIA, Rīga. Mēs apstrādājam jūsu konta datus (e-pasts, vārds, valsts), solījumu un pirkumu vēsturi, kā arī rēķinu datus, lai sniegtu izsoļu pakalpojumu un izpildītu likumā noteiktos pienākumus.",
              "Контролёр данных: Skakunov’s SIA, Рига. Мы обрабатываем данные аккаунта (e-mail, имя, страна), историю ставок и покупок, а также данные счетов — для оказания услуг аукциона и исполнения требований закона.",
              "Data controller: Skakunov’s SIA, Riga. We process your account data (email, name, country), your bidding and purchase history, and invoicing data — to provide the auction service and to meet legal obligations.",
            ),
          },
          {
            type: "text",
            text: L(
              "Rēķinu dati tiek glabāti grāmatvedības likumos noteikto laiku. Jums ir tiesības piekļūt saviem datiem, tos labot un pieprasīt dzēšanu — dzēšot kontu, personas dati tiek neatgriezeniski anonimizēti, saglabājot tikai likumā prasītos rēķinu ierakstus. Sazinieties: info@izsoli.lv.",
              "Данные счетов хранятся в течение срока, установленного законом о бухгалтерии. Вы вправе получить доступ к своим данным, исправить их и потребовать удаления — при удалении аккаунта персональные данные необратимо анонимизируются, сохраняются только записи счетов, требуемые законом. Контакт: info@izsoli.lv.",
              "Invoice records are retained for the period required by accounting law. You may access and correct your data and request erasure — on account erasure, personal data is irreversibly anonymised, keeping only the invoice records the law requires. Contact: info@izsoli.lv.",
            ),
          },
          {
            type: "text",
            text: L(
              "Mēs izmantojam tikai darbībai nepieciešamās sīkdatnes (pieteikšanās sesija, valodas izvēle) — ne izsekošanai, ne reklāmai. ⚠️ PROJEKTS — pirms publicēšanas jāapstiprina juristam.",
              "Мы используем только необходимые для работы cookies (сессия входа, выбор языка) — не для трекинга и рекламы. ⚠️ ПРОЕКТ — перед публикацией требуется утверждение юриста.",
              "We use only strictly necessary cookies (login session, language choice) — no tracking, no advertising. ⚠️ DRAFT — must be approved by a lawyer before publishing.",
            ),
          },
        ],
        seo: {
          title: L("Privātums · Izsoli.lv", "Конфиденциальность · Izsoli.lv", "Privacy · Izsoli.lv"),
          description: L("Kā Izsoli.lv apstrādā jūsu datus.", "Как Izsoli.lv обрабатывает ваши данные.", "How Izsoli.lv handles your data."),
        },
      },
    ])
    .onConflictDoNothing();
}
