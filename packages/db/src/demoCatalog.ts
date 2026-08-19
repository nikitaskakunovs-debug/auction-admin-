import { CATEGORIES, CONDITIONS, resolveBid, type BidState, type LedgerEntry } from "@auction/domain";
import { inArray, like, sql } from "drizzle-orm";
import { createDb } from "./client.js";
import type { Db } from "./client.js";
import * as t from "./schema.js";

/**
 * Demo catalog CLI: three lots for EVERY category, in different states, so the
 * whole card zoo is visible at once — in the admin panel and on the storefront.
 *
 *   node packages/db/dist/demoCatalog.js          create (refuses if present)
 *   node packages/db/dist/demoCatalog.js remove   delete everything it created
 *
 * Per category:
 *   A — live auction (reserve / no-reserve / bid battles / ending soon vary)
 *   B — fixed-price "buy now" listing
 *   C — rotates by category: scheduled auction → ended & sold → ended with
 *       reserve not met → draft item that never reached the storefront
 *
 * Everything is tagged: SKUs start with DEMO-, demo bidders live under
 * @demo.izsoli.lv — `remove` finds it all by those marks. Bids are replayed
 * through the domain resolver, so seeded auctions look exactly like the
 * engine would have left them.
 */

const MODE = process.argv[2] === "remove" ? "remove" : "create";

/** [auction title, fixed-price title, third-state title] per category. */
const TITLES: Record<string, [string, string, string]> = {
  electronics: ["Apple MacBook Pro 14 M3, 2024", "Sony WH-1000XM5 austiņas", "Nintendo Switch OLED komplekts"],
  appliances: ["Miele W1 veļas mašīna", "De'Longhi Magnifica S kafijas automāts", "Dyson V15 Detect putekļsūcējs"],
  furniture: ["Hans Wegner stila ozolkoka krēsls", "Stockholm dīvāns, zaļš samts", "Art Deco riekstkoka kumode"],
  tools: ["Makita DHP486 triecienurbjmašīna", "Bosch GTS 10 XC galda zāģis", "Kärcher K7 augstspiediena mazgātājs"],
  home_garden: ["Weber Genesis II gāzes grils", "Husqvarna Automower 305", "Fiskars dārza instrumentu komplekts"],
  jewellery_watches: ["Omega Speedmaster Professional, 2019", "Dzintara krelles ar sudrabu, 925", "Longines HydroConquest 41 mm"],
  art_antiques: ["Vilhelms Purvītis — ainava, litogrāfija", "Kuzņecova porcelāna servīze, 6 personām", "Rīgas sudraba karošu komplekts, 875"],
  sports_outdoors: ["Trek Fuel EX 8 kalnu velosipēds", "Thule Motion XT jumta kaste", "Salomon slēpju komplekts, 170 cm"],
  kids_toys: ["LEGO Technic Liebherr R 9800, 42100", "Bugaboo Fox 5 rati", "BRIO koka dzelzceļa komplekts"],
  fashion: ["Louis Vuitton Neverfull MM soma", "Canada Goose Expedition parka, M", "Ray-Ban Aviator saulesbrilles"],
  food_household: ["Bordeaux 2015 kolekcija, 6 pudeles", "Riedel Veloce glāžu komplekts, 12 gab.", "Le Creuset čuguna katls, 24 cm"],
  other: ["Vinila plašu kolekcija, 50 gab.", "Fender Stratocaster ģitāra, MIM", "Zeiss binoklis 10×42"],
};

/** Rough price level per category, in cents — keeps the demo believable. */
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

const sku3 = (code: string) => code.replace(/[^a-z]/g, "").slice(0, 3).toUpperCase();

async function create(db: Db): Promise<void> {
  const [existing] = await db
    .select({ n: sql<string>`count(*)` })
    .from(t.items)
    .where(like(t.items.sku, "DEMO-%"));
  if (Number(existing?.n ?? 0) > 0) {
    console.log(`демо-лоты уже есть (${existing!.n} шт.) — сначала: node packages/db/dist/demoCatalog.js remove`);
    process.exitCode = 1;
    return;
  }

  const now = new Date();
  const hours = (n: number) => new Date(now.getTime() + n * 3_600_000);

  const bidderRows = await db
    .insert(t.customers)
    .values(DEMO_BIDDERS.map((b) => ({ ...b, marketCode: b.country })))
    .onConflictDoNothing()
    .returning({ id: t.customers.id, alias: t.customers.alias });
  // onConflictDoNothing returns only fresh rows — fetch the rest by email.
  const allBidders = await db
    .select({ id: t.customers.id, alias: t.customers.alias })
    .from(t.customers)
    .where(inArray(t.customers.email, DEMO_BIDDERS.map((b) => b.email)));
  const byAlias = Object.fromEntries(allBidders.map((c) => [c.alias, c.id]));
  void bidderRows;

  /** Walks the full condition scale so every grade appears somewhere. */
  let condIdx = 0;
  const nextCondition = () => {
    const c = CONDITIONS[condIdx++ % CONDITIONS.length]!;
    return {
      condition: c.code,
      conditionNotes: c.requiresNotes ? "Redzamas lietošanas pēdas — skat. foto un aprakstu." : "",
    };
  };

  const makeItem = async (sku: string, category: string, title: string, status: string) => {
    const [row] = await db
      .insert(t.items)
      .values({
        sku, category, title, status,
        marketCode: "LV",
        description: `${title}. Demo lots — izveidots kataloga pārbaudei.`,
        location: `A-0${(condIdx % 4) + 1}-0${(condIdx % 9) + 1}`,
        weightGrams: 500 + (condIdx % 7) * 900,
        photos: [],
        ...nextCondition(),
      })
      .returning({ id: t.items.id });
    return row!.id;
  };

  /** Same bid replay the main seed uses: state is what the engine would leave. */
  const makeAuction = async (args: {
    itemId: string; title: string; startPriceCents: number; reserveCents?: number | null;
    startsAt: Date; endsAt: Date;
    status: "scheduled" | "live" | "ended_won" | "ended_reserve_not_met" | "ended_no_bids";
    bids: Array<{ alias: string; maxCents: number }>;
  }) => {
    const [listing] = await db
      .insert(t.listings)
      .values({
        itemId: args.itemId, type: "auction", title: args.title, marketCode: "LV",
        startPriceCents: args.startPriceCents, reserveCents: args.reserveCents ?? null,
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
      if (!r.ok) throw new Error(`demo bid rejected: ${b.alias} ${b.maxCents} → ${r.code}`);
      state = r.state;
      for (const row of r.ledger) {
        ledger.push({ ...row, seq, maxCents: row.bidderId === byAlias[b.alias] ? b.maxCents : state.leader!.maxCents });
      }
    }

    const ended = args.status.startsWith("ended");
    const [auction] = await db
      .insert(t.auctions)
      .values({
        listingId: listing!.id, status: args.status,
        startsAt: args.startsAt, endsAt: args.endsAt,
        currentPriceCents: state.currentPriceCents,
        leaderCustomerId: state.leader?.bidderId ?? null,
        leaderMaxCents: state.leader?.maxCents ?? null,
        leaderSeq: state.leader?.seq ?? null,
        bidCount: seq,
        reserveMet:
          state.reserveCents === null
            ? state.leader !== null
            : (state.leader?.maxCents ?? 0) >= state.reserveCents,
        closedAt: ended ? args.endsAt : null,
      })
      .returning({ id: t.auctions.id });

    for (const row of ledger) {
      await db.insert(t.bids).values({
        auctionId: auction!.id, customerId: row.bidderId,
        amountCents: row.amountCents, maxCents: row.maxCents,
        auto: row.auto, seq: row.seq,
        outbid: row.outbid || (state.leader !== null && row.bidderId !== state.leader.bidderId),
      });
    }
  };

  let made = 0;
  for (const [i, cat] of CATEGORIES.entries()) {
    const [titleA, titleB, titleC] = TITLES[cat.code] ?? [cat.label, cat.label, cat.label];
    const base = BASE_CENTS[cat.code] ?? 30_000;
    const pfx = `DEMO-${sku3(cat.code)}`;

    // A — live auction. Reserve, bids and the remaining time vary by index so
    // the cards show every flavour: bid battle, untouched, "ending soon".
    const withReserve = i % 3 === 0;
    const withBids = i % 2 === 0;
    const itemA = await makeItem(`${pfx}-A`, cat.code, titleA, "live");
    await makeAuction({
      itemId: itemA, title: titleA,
      startPriceCents: Math.round(base / 2),
      reserveCents: withReserve ? Math.round(base * 1.4) : null,
      startsAt: hours(-6 - i), endsAt: hours(i % 4 === 0 ? 1 : 6 + i * 3),
      status: "live",
      bids: withBids
        ? [
            { alias: "demo_aija", maxCents: Math.round(base * 0.8) },
            { alias: "demo_marks", maxCents: Math.round(base * 1.1) },
          ]
        : [],
    });
    made++;

    // B — fixed price. A couple of categories get quantity 3 (multi-stock).
    const itemB = await makeItem(`${pfx}-B`, cat.code, titleB, "listed");
    await db.insert(t.listings).values({
      itemId: itemB, type: "fixed", title: titleB, marketCode: "LV",
      priceCents: Math.round(base * 1.2), quantity: i % 5 === 0 ? 3 : 1,
      status: "published",
    });
    made++;

    // C — the rotating third state.
    const third = i % 4;
    if (third === 0) {
      const itemC = await makeItem(`${pfx}-C`, cat.code, titleC, "listed");
      await makeAuction({
        itemId: itemC, title: titleC, startPriceCents: Math.round(base * 0.6),
        startsAt: hours(24), endsAt: hours(48), status: "scheduled", bids: [],
      });
    } else if (third === 1) {
      const itemC = await makeItem(`${pfx}-C`, cat.code, titleC, "won");
      await makeAuction({
        itemId: itemC, title: titleC, startPriceCents: Math.round(base * 0.5),
        startsAt: hours(-72), endsAt: hours(-2), status: "ended_won",
        bids: [
          { alias: "demo_ruta", maxCents: Math.round(base * 0.9) },
          { alias: "demo_aija", maxCents: Math.round(base * 0.7) },
        ],
      });
    } else if (third === 2) {
      const itemC = await makeItem(`${pfx}-C`, cat.code, titleC, "unsold");
      await makeAuction({
        itemId: itemC, title: titleC, startPriceCents: Math.round(base * 0.5),
        reserveCents: base * 2,
        startsAt: hours(-72), endsAt: hours(-4), status: "ended_reserve_not_met",
        bids: [{ alias: "demo_marks", maxCents: Math.round(base * 0.8) }],
      });
    } else {
      // Draft: exists only in the admin panel — never reached the storefront.
      await makeItem(`${pfx}-C`, cat.code, titleC, "draft");
    }
    made++;
  }

  console.log(`создано ${made} демо-лотов в ${CATEGORIES.length} категориях (SKU: DEMO-…)`);
  console.log("смотреть: каталог и «Купить сразу» — /katalogs · завершённые — /rezultati · черновики и все статусы — админка, Krājumi");
  console.log("убрать всё: node packages/db/dist/demoCatalog.js remove");
}

async function remove(db: Db): Promise<void> {
  const demoItems = await db
    .select({ id: t.items.id })
    .from(t.items)
    .where(like(t.items.sku, "DEMO-%"));
  const itemIds = demoItems.map((r) => r.id);

  if (itemIds.length > 0) {
    const demoListings = await db
      .select({ id: t.listings.id })
      .from(t.listings)
      .where(inArray(t.listings.itemId, itemIds));
    const listingIds = demoListings.map((r) => r.id);

    if (listingIds.length > 0) {
      const demoAuctions = await db
        .select({ id: t.auctions.id })
        .from(t.auctions)
        .where(inArray(t.auctions.listingId, listingIds));
      const auctionIds = demoAuctions.map((r) => r.id);
      if (auctionIds.length > 0) {
        await db.delete(t.bids).where(inArray(t.bids.auctionId, auctionIds));
        await db.delete(t.auctions).where(inArray(t.auctions.id, auctionIds));
      }
      await db.delete(t.listings).where(inArray(t.listings.id, listingIds));
    }

    // A demo lot someone actually bought has a real order pointing at it —
    // that is bookkeeping now, so the item stays and gets reported instead.
    const ordered = await db
      .select({ itemId: t.orders.itemId })
      .from(t.orders)
      .where(inArray(t.orders.itemId, itemIds));
    const keep = new Set(ordered.map((r) => r.itemId));
    const deletable = itemIds.filter((id) => !keep.has(id));
    if (deletable.length > 0) await db.delete(t.items).where(inArray(t.items.id, deletable));
    if (keep.size > 0) console.log(`оставлено ${keep.size} лотов — на них есть настоящие заказы`);
    console.log(`удалено ${deletable.length} демо-лотов`);
  } else {
    console.log("демо-лотов нет");
  }

  // Demo bidders go too — unless they placed bids on REAL auctions meanwhile.
  const demoCustomers = await db
    .select({ id: t.customers.id })
    .from(t.customers)
    .where(inArray(t.customers.email, DEMO_BIDDERS.map((b) => b.email)));
  for (const c of demoCustomers) {
    const [stillBidding] = await db
      .select({ n: sql<string>`count(*)` })
      .from(t.bids)
      .where(sql`${t.bids.customerId} = ${c.id}`);
    if (Number(stillBidding?.n ?? 0) === 0) {
      await db.delete(t.customers).where(sql`${t.customers.id} = ${c.id}`);
    }
  }
}

const { db, pool } = createDb();
try {
  if (MODE === "remove") await remove(db);
  else await create(db);
} finally {
  await pool.end();
}
