import {
  affiliates as affiliatesTable,
  auctions as auctionsTable,
  campaigns as campaignsTable,
  createDb,
  customers,
  items as itemsTable,
  listings as listingsTable,
  notifications,
  promoCodes,
  segments as segmentsTable,
} from "@auction/db";
import { CATEGORIES, resolveBid, type BidState, type LedgerEntry } from "@auction/domain";
import { bids as bidsTable } from "@auction/db";
import { eq, inArray, sql } from "drizzle-orm";
import { Redis } from "ioredis";
import { loadConfig } from "../config.js";
import type { AppContext } from "../context.js";
import { createEmailAdapter } from "../email.js";
import { createDpdClient } from "../engine/dpd.js";
import { createInbankClient } from "../engine/inbank.js";
import { createJiraClient } from "../engine/jira.js";
import { createKlixClient } from "../engine/klix.js";
import { createOmnivaClient } from "../engine/omniva.js";
import { createSlackClient } from "../engine/slack.js";
import { createStorage } from "../storage.js";
import { issueGiftCard } from "../engine/giftCards.js";
import { NOTIFICATION_TYPES, sampleInput, type Lang } from "../engine/emailCopy.js";
import { renderNotification } from "../engine/notifications.js";

/**
 * Демо-набор для приёмки маркетинга v15 + Beyond-MVP.
 *
 *   node apps/api/dist/scripts/demoGrowth.js seed --email=adrese@example.com [--lang=lv|ru|en]
 *   node apps/api/dist/scripts/demoGrowth.js remove
 *
 * seed:
 *  - в каждой категории 10 демо-лотов: 5 живых аукционов (разные сроки, часть
 *    со ставками демо-биддеров) + 5 «Pērc tagad» (SKU DEMOG-…);
 *  - промокоды всех типов: DEMO10 (−10 %), DEMO5EUR (−5 €), DEMOPIEGADE
 *    (бесплатная доставка от 30 €), DEMOKAT10 (−10 % только Elektronika);
 *  - подарочная карта 25 € (код в выводе), партнёр DEMOPARTNERIS (5 %),
 *    сегмент-пример и кампания-черновик с вариантами A/B;
 *  - на указанный адрес — по одному письму КАЖДОГО типа (кладутся в outbox,
 *    работающий API отправит их в течение минуты).
 *
 * remove: удаляет демо-лоты без заказов и выключает демо-коды/партнёра.
 * Кампанию/сегмент/карту оставляет — их видно и удобно удалить из админки.
 */

const config = loadConfig();
const { db, pool } = createDb(config.databaseUrl);
const redis = new Redis(config.redisUrl);

const ctx: AppContext = {
  db,
  pool,
  redis,
  config,
  email: createEmailAdapter(config.emailMode, config.smtp),
  storage: createStorage(config),
  klix: createKlixClient(config),
  inbank: createInbankClient(config),
  omniva: createOmnivaClient(config),
  dpd: createDpdClient(config),
  jira: createJiraClient(config),
  slack: createSlackClient(config),
  now: () => new Date(),
};

const arg = (name: string): string | null => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};

/** Пять названий на категорию; каждое живёт и аукционом, и «Pērc tagad». */
const TITLES5: Record<string, string[]> = {
  electronics: ["Apple MacBook Pro 14 M3", "Sony WH-1000XM5 austiņas", "Nintendo Switch OLED", "Samsung 55\" QLED televizors", "Canon EOS R8 komplekts"],
  appliances: ["Miele W1 veļas mašīna", "De'Longhi Magnifica S", "Dyson V15 Detect", "Bosch Serie 6 trauku mašīna", "Electrolux 700 SenseCook cepeškrāsns"],
  furniture: ["Hans Wegner stila ozolkoka krēsls", "Stockholm dīvāns, zaļš samts", "Art Deco riekstkoka kumode", "Masīvkoka ēdamgalds, 180 cm", "String plauktu sistēma"],
  tools: ["Makita DHP486 triecienurbjmašīna", "Bosch GTS 10 XC galda zāģis", "Kärcher K7 mazgātājs", "DeWalt DCS391 ripzāģis", "Metabo metināšanas aparāts"],
  home_garden: ["Weber Genesis II gāzes grils", "Husqvarna Automower 305", "Fiskars dārza komplekts", "Gardena laistīšanas sistēma", "Keter dārza mēbeļu komplekts"],
  jewellery_watches: ["Omega Speedmaster Professional", "Dzintara krelles ar sudrabu 925", "Longines HydroConquest 41", "Tissot PRX Powermatic 80", "Zelta gredzens ar briljantu 0,5 ct"],
  art_antiques: ["Vilhelms Purvītis — litogrāfija", "Kuzņecova porcelāna servīze", "Rīgas sudraba karotes, 875", "Jūgendstila sienas pulkstenis", "Eļļas glezna — jūras ainava"],
  sports_outdoors: ["Trek Fuel EX 8 velosipēds", "Thule Motion XT jumta kaste", "Salomon slēpju komplekts", "Concept2 airēšanas trenažieris", "MSR Hubba Hubba telts"],
  kids_toys: ["LEGO Technic Liebherr R 9800", "Bugaboo Fox 5 rati", "BRIO dzelzceļa komplekts", "Stokke Tripp Trapp krēsls", "PlayStation 5 + spēles bērniem"],
  fashion: ["Louis Vuitton Neverfull MM", "Canada Goose Expedition parka", "Ray-Ban Aviator brilles", "Burberry trencis, 38", "Gucci Marmont soma"],
  food_household: ["Bordeaux 2015 kolekcija, 6 pud.", "Riedel Veloce glāzes, 12 gab.", "Le Creuset čuguna katls 24 cm", "Vitamix A2500 blenderis", "Sencha un matcha tēju komplekts"],
  other: ["Vinila plašu kolekcija, 50 gab.", "Fender Stratocaster ģitāra", "Zeiss binoklis 10×42", "Filatēlijas albums 1918–1940", "Retro rakstāmmašīna Erika"],
};

const BASE_CENTS: Record<string, number> = {
  electronics: 120_000, appliances: 45_000, furniture: 30_000, tools: 18_000,
  home_garden: 40_000, jewellery_watches: 250_000, art_antiques: 60_000,
  sports_outdoors: 90_000, kids_toys: 25_000, fashion: 80_000,
  food_household: 35_000, other: 50_000,
};

const DEMO_BIDDERS = [
  { email: "aija@demo.izsoli.lv", alias: "demo_aija", name: "Aija Demo", country: "LV" },
  { email: "marks@demo.izsoli.lv", alias: "demo_marks", name: "Marks Demo", country: "LV" },
  { email: "ruta@demo.izsoli.lv", alias: "demo_ruta", name: "Rūta Demo", country: "EE" },
];

async function seedCatalog(): Promise<number> {
  const now = ctx.now();
  const hours = (n: number) => new Date(now.getTime() + n * 3_600_000);

  // Повторный запуск: старый живой набор мешал бы — просим убрать.
  const standing = await db
    .select({ id: itemsTable.id })
    .from(itemsTable)
    .where(sql`${itemsTable.sku} like 'DEMOG-%'`);
  if (standing.length > 0) {
    console.log(`демо-лоты DEMOG уже есть (${standing.length}) — сначала: node apps/api/dist/scripts/demoGrowth.js remove`);
    return 0;
  }

  await db
    .insert(customers)
    .values(DEMO_BIDDERS.map((b) => ({ ...b, marketCode: b.country })))
    .onConflictDoNothing();
  const bidders = await db
    .select({ id: customers.id, alias: customers.alias })
    .from(customers)
    .where(inArray(customers.email, DEMO_BIDDERS.map((b) => b.email)));

  let made = 0;
  for (const cat of CATEGORIES) {
    const titles = TITLES5[cat.code] ?? [cat.label];
    const base = BASE_CENTS[cat.code] ?? 30_000;
    for (let i = 0; i < 5; i += 1) {
      const title = titles[i % titles.length]!;
      const startPrice = Math.round((base * (0.4 + i * 0.18)) / 100) * 100;

      // Аукцион: сроки от «скоро закончится» до недели; на двух — ставки.
      const [itemA] = await db
        .insert(itemsTable)
        .values({
          sku: `DEMOG-${cat.code.slice(0, 3).toUpperCase()}-A${i + 1}`,
          category: cat.code, title, status: "live", marketCode: "LV",
          description: `${title}. Demo lots pārbaudei — izsole.`,
          photos: [],
          condition: ["lightly_used", "used", "open_package_inspected", "refurbished", "display_model"][i] ?? "used",
          conditionNotes: "",
        })
        .returning({ id: itemsTable.id });
      const [listingA] = await db
        .insert(listingsTable)
        .values({
          itemId: itemA!.id, type: "auction", title, marketCode: "LV",
          startPriceCents: startPrice, status: "published",
        })
        .returning({ id: listingsTable.id });

      let state: BidState = { startPriceCents: startPrice, reserveCents: null, currentPriceCents: null, leader: null };
      const ledger: Array<LedgerEntry & { seq: number; maxCents: number }> = [];
      let seq = 0;
      if (i % 5 === 1 || i % 5 === 3) {
        const plan = [
          { bidderId: bidders[0]!.id, maxCents: Math.round(startPrice * 1.3) },
          { bidderId: bidders[1]!.id, maxCents: Math.round(startPrice * 1.7) },
        ];
        for (const b of plan) {
          const r = resolveBid(state, { bidderId: b.bidderId, maxCents: b.maxCents, seq: ++seq });
          if (r.ok) {
            state = r.state;
            for (const row of r.ledger) ledger.push({ ...row, seq, maxCents: b.maxCents });
          }
        }
      }
      const [auction] = await db
        .insert(auctionsTable)
        .values({
          listingId: listingA!.id, status: "live",
          startsAt: hours(-4), endsAt: hours([3, 24, 48, 96, 168][i] ?? 48),
          currentPriceCents: state.currentPriceCents,
          leaderCustomerId: state.leader?.bidderId ?? null,
          leaderMaxCents: state.leader?.maxCents ?? null,
          leaderSeq: state.leader?.seq ?? null,
          bidCount: seq,
          reserveMet: state.leader !== null,
        })
        .returning({ id: auctionsTable.id });
      for (const row of ledger) {
        await db.insert(bidsTable).values({
          auctionId: auction!.id, customerId: row.bidderId,
          amountCents: row.amountCents, maxCents: row.maxCents,
          auto: row.auto, seq: row.seq,
          outbid: state.leader !== null && row.bidderId !== state.leader.bidderId,
        });
      }
      made += 1;

      // «Pērc tagad» — той же линейки, дороже; один с несколькими штуками.
      const [itemF] = await db
        .insert(itemsTable)
        .values({
          sku: `DEMOG-${cat.code.slice(0, 3).toUpperCase()}-F${i + 1}`,
          category: cat.code, title: `${title} (jauns)`, status: "live", marketCode: "LV",
          description: `${title}. Demo lots pārbaudei — tūlītējs pirkums.`,
          photos: [], condition: "brand_new", conditionNotes: "",
        })
        .returning({ id: itemsTable.id });
      await db.insert(listingsTable).values({
        itemId: itemF!.id, type: "fixed", title: `${title} (jauns)`, marketCode: "LV",
        priceCents: Math.round((base * (0.9 + i * 0.15)) / 100) * 100,
        quantity: i === 4 ? 3 : 1, status: "published",
      });
      made += 1;
    }
  }
  return made;
}

async function seedMarketing(): Promise<void> {
  const now = ctx.now();
  const in30d = new Date(now.getTime() + 30 * 86_400_000);
  const codes = [
    { code: "DEMO10", type: "percent", value: 10, minOrderCents: null, category: null },
    { code: "DEMO5EUR", type: "fixed", value: 500, minOrderCents: null, category: null },
    { code: "DEMOPIEGADE", type: "free_shipping", value: 0, minOrderCents: 3_000, category: null },
    { code: "DEMOKAT10", type: "percent", value: 10, minOrderCents: null, category: "electronics" },
  ];
  for (const c of codes) {
    // Повторный seed после remove возвращает выключенные коды к жизни.
    await db
      .insert(promoCodes)
      .values({ ...c, source: "manual", validTo: in30d })
      .onConflictDoUpdate({ target: promoCodes.code, set: { isActive: true, validTo: in30d } });
  }
  console.log("промокоды: DEMO10 (−10%), DEMO5EUR (−5 €), DEMOPIEGADE (бесплатная доставка от 30 €), DEMOKAT10 (−10% Elektronika)");

  const card = await issueGiftCard(ctx, { initialCents: 2_500, note: "Demo pārbaudei", issuedBy: "demoGrowth" });
  console.log(`подарочная карта 25 €: ${card.code}  (ввести на /punkti)`);

  await db
    .insert(affiliatesTable)
    .values({ name: "Demo partneris", code: "DEMOPARTNERIS", commissionBp: 500, contact: "demo@partner.lv" })
    .onConflictDoNothing();
  console.log(`партнёр: ${ctx.config.storefrontBaseUrl}/register?aff=DEMOPARTNERIS (комиссия 5%)`);

  await db
    .insert(segmentsTable)
    .values({
      name: "Demo: pirkuši vismaz reizi",
      rule: { match: "all", conditions: [{ field: "purchase_count", op: ">=", value: 1 }] },
      isActive: true,
    })
    .onConflictDoNothing();

  const existing = await db.select({ id: campaignsTable.id }).from(campaignsTable).where(eq(campaignsTable.name, "Demo A/B kampaņa"));
  if (existing.length === 0) {
    await db.insert(campaignsTable).values({
      name: "Demo A/B kampaņa",
      content: {
        lv: { subject: "Nedēļas loti — variants A", body: "Sveiki, {alias}!\n\nŠīs nedēļas interesantākie loti jau izsolē.\n\nCena, ko redzi, ir galīgā." },
        ru: { subject: "Лоты недели — вариант A", body: "Здравствуйте, {alias}!\n\nСамые интересные лоты этой недели уже на торгах." },
      },
      contentB: {
        lv: { subject: "Tikai šonedēļ — variants B", body: "Sveiki, {alias}!\n\nDaži loti noslēgsies jau šajā nedēļā — ieskaties." },
        ru: { subject: "Только на этой неделе — вариант B", body: "Здравствуйте, {alias}!\n\nНесколько лотов закроются уже на этой неделе." },
      },
      status: "draft",
    });
    console.log("кампания-черновик «Demo A/B kampaņa» — запланируйте из админки, когда захотите");
  }
}

async function seedEmails(email: string, lang: Lang): Promise<number> {
  let queued = 0;
  for (const type of NOTIFICATION_TYPES) {
    const rendered = await renderNotification(
      ctx, type, lang,
      sampleInput(type, { online: ctx.klix !== null || ctx.inbank !== null }),
    );
    const rows = await db
      .insert(notifications)
      .values({
        customerId: null,
        type,
        kind: "service", // мимо маркетинговых лимитов: это приёмка, не рассылка
        toEmail: email,
        lang,
        subject: `[DEMO] ${rendered.subject}`,
        body: rendered.text,
        html: rendered.html,
        dedupeKey: `demo:${type}:${Date.now()}`,
      })
      .onConflictDoNothing()
      .returning({ id: notifications.id });
    if (rows.length > 0) queued += 1;
  }
  return queued;
}

async function remove(): Promise<void> {
  // Порядок удаления диктуют внешние ключи: ставки → торги → выставления →
  // товары; купленное (заказ ссылается) остаётся бухгалтерией навсегда.
  const rows = await db.execute(sql`
    with victims as (
      select i.id from items i
      where i.sku like 'DEMOG-%'
        and not exists (select 1 from orders o where o.item_id = i.id)
    ),
    l as (select id from listings where item_id in (select id from victims)),
    a as (select id from auctions where listing_id in (select id from l)),
    d0 as (delete from user_events where listing_id in (select id from l)),
    d1 as (delete from bids where auction_id in (select id from a)),
    d2 as (delete from watchlist where auction_id in (select id from a) or listing_id in (select id from l)),
    d3 as (delete from auctions where id in (select id from a)),
    d4 as (delete from listings where id in (select id from l))
    delete from items where id in (select id from victims) returning id
  `);
  const n = (rows as { rows?: unknown[] }).rows?.length ?? (rows as unknown as unknown[]).length ?? 0;
  await db.update(promoCodes).set({ isActive: false }).where(inArray(promoCodes.code, ["DEMO10", "DEMO5EUR", "DEMOPIEGADE", "DEMOKAT10"]));
  await db.update(affiliatesTable).set({ isActive: false }).where(eq(affiliatesTable.code, "DEMOPARTNERIS"));
  console.log(`удалено демо-лотов: ${n}; демо-коды и партнёр выключены`);
  console.log("кампанию, сегмент и подарочную карту при желании удалите из админки");
}

const mode = process.argv[2] ?? "seed";
try {
  if (mode === "remove") {
    await remove();
  } else {
    const email = arg("email");
    const lang = (arg("lang") ?? "lv") as Lang;
    const lots = await seedCatalog();
    if (lots > 0) console.log(`создано демо-лотов: ${lots} (по 10 в каждой из ${CATEGORIES.length} категорий)`);
    await seedMarketing();
    if (email) {
      const sent = await seedEmails(email, ["lv", "ru", "en"].includes(lang) ? lang : "lv");
      console.log(`писем поставлено в очередь на ${email}: ${sent} — уйдут в течение минуты`);
    } else {
      console.log("почта не указана (--email=...) — письма не отправлялись");
    }
  }
} finally {
  await redis.quit().catch(() => undefined);
  await pool.end();
}
