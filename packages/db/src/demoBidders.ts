import { resolveBid, type BidState, type LedgerEntry } from "@auction/domain";
import { eq, inArray, like, sql } from "drizzle-orm";
import { createDb } from "./client.js";
import type { Db } from "./client.js";
import { hashPassword } from "./password.js";
import * as t from "./schema.js";

/**
 * Тестовые аккаунты со сценариями ставок — по ПЯТЬ на каждый типаж.
 *
 *   node packages/db/dist/demoBidders.js           создать (откажется, если есть)
 *   node packages/db/dist/demoBidders.js remove    убрать всё созданное
 *
 * Сценарии (в скобках — начало почты, номера 1–5):
 *   svaigs     — абсолютно новый клиент, ни одной ставки
 *   zaudejis   — одна ставка, торги закончились, перебит — проиграл
 *   uzvarejis  — одна ставка, торги закончились победой — заказ ждёт оплаты
 *   jaukts     — две ставки: одна выиграна (заказ), одна проиграна
 *   vada       — одна ставка на ЖИВЫХ торгах, сейчас лидирует
 *   parsists   — одна ставка на живых торгах, сейчас перебит
 *   veterans   — три ставки: победа с заказом, проигрыш и живое лидерство
 *
 * Вход: <сценарий>.<n>@bidders.izsoli.lv, пароль у всех Demo123! — почта
 * подтверждена, ставить и покупать можно сразу. Ставки проиграны через
 * доменный резольвер, поэтому торги выглядят ровно так, как их оставил бы
 * движок; у побед — настоящие заказы «ждёт оплаты». Соперник во всех
 * сценариях один — konkurents@bidders.izsoli.lv.
 *
 * Всё помечено: артикулы DEMO-BT-, клиенты на @bidders.izsoli.lv — remove
 * находит и убирает всё по этим меткам.
 */

const MODE = process.argv[2] === "remove" ? "remove" : "create";

/** Тот же пароль, что у остальных демо-клиентов (demoWorld). Импортировать
 *  его оттуда нельзя: demoWorld.js — CLI, импорт запустил бы весь сид. */
const DEMO_PASSWORD = "Demo123!";

const DOMAIN = "bidders.izsoli.lv";
const SKU_PREFIX = "DEMO-BT";
const PER_SCENARIO = 5;

/** LV-ставки движка: комиссия 10 % СВЕРХ молотка, НДС 21 % сверх суммы. */
const PREMIUM_BP = 1_000;
const VAT_BP = 2_100;

const SCENARIOS = [
  { key: "svaigs", name: "Svaigais klients" },
  { key: "zaudejis", name: "Zaudējis solītājs" },
  { key: "uzvarejis", name: "Uzvarējis solītājs" },
  { key: "jaukts", name: "Jauktais solītājs" },
  { key: "vada", name: "Vadošais solītājs" },
  { key: "parsists", name: "Pārsistais solītājs" },
  { key: "veterans", name: "Pieredzējušais solītājs" },
] as const;

const TITLES = [
  "Nikon Z6 II kamera", "Bose 700 austiņas", "Eames stila krēsls", "Makita zāģis",
  "Tissot PRX pulkstenis", "iPad Air 2024", "Dyson fēns", "KitchenAid mikseris",
  "Trek velosipēds", "LEGO Star Wars UCS", "Vinila atskaņotājs", "Segway skrejritenis",
];

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
    .from(t.customers)
    .where(like(t.customers.email, `%@${DOMAIN}`));
  if (Number(already?.n ?? 0) > 0) {
    console.log("аккаунты ставок уже есть — сначала: node packages/db/dist/demoBidders.js remove");
    process.exitCode = 1;
    return;
  }

  const now = new Date();
  const hours = (n: number) => new Date(now.getTime() + n * 3_600_000);
  const passwordHash = await hashPassword(DEMO_PASSWORD);
  let sku = 0;
  let title = 0;

  const mkCustomer = async (email: string, alias: string, name: string): Promise<string> => {
    const [row] = await db
      .insert(t.customers)
      .values({
        email, alias, name, country: "LV", marketCode: "LV", lang: "lv",
        passwordHash,
        emailVerifiedAt: hours(-24 * 20),
        lastLoginMethod: "password",
        lastLoginAt: hours(-2),
        notes: "Тестовый аккаунт сценариев ставок (demoBidders).",
      })
      .returning({ id: t.customers.id });
    return row!.id;
  };

  // Соперник один на всех: он перебивает проигравших и проигрывает лидерам.
  const rivalId = await mkCustomer(`konkurents@${DOMAIN}`, "bt_konkurents", "Konkurents Demo");

  /** Аукцион с проигрышем ставок через доменный резольвер — как в движке. */
  const mkAuction = async (args: {
    startPriceCents: number;
    live: boolean;
    bids: Array<{ customerId: string; maxCents: number }>;
  }) => {
    sku += 1;
    const lotTitle = TITLES[title++ % TITLES.length]!;
    const [item] = await db
      .insert(t.items)
      .values({
        sku: `${SKU_PREFIX}-${String(sku).padStart(3, "0")}`,
        title: lotTitle, marketCode: "LV", category: "electronics",
        status: args.live ? "live" : "won",
        description: `${lotTitle}. Демо-лот сценариев ставок.`,
      })
      .returning({ id: t.items.id });
    const [listing] = await db
      .insert(t.listings)
      .values({
        itemId: item!.id, type: "auction", title: lotTitle, marketCode: "LV",
        startPriceCents: args.startPriceCents, status: "published",
      })
      .returning({ id: t.listings.id });

    let state: BidState = {
      startPriceCents: args.startPriceCents,
      reserveCents: null,
      currentPriceCents: null,
      leader: null,
    };
    const ledger: Array<LedgerEntry & { seq: number; maxCents: number }> = [];
    let seq = 0;
    for (const b of args.bids) {
      const r = resolveBid(state, { bidderId: b.customerId, maxCents: b.maxCents, seq: ++seq });
      if (!r.ok) throw new Error(`demo bid rejected: ${b.maxCents} → ${r.code}`);
      state = r.state;
      for (const row of r.ledger) {
        ledger.push({ ...row, seq, maxCents: row.bidderId === b.customerId ? b.maxCents : state.leader!.maxCents });
      }
    }

    const [auction] = await db
      .insert(t.auctions)
      .values({
        listingId: listing!.id,
        status: args.live ? "live" : "ended_won",
        startsAt: hours(args.live ? -6 : -72),
        endsAt: args.live ? hours(8) : hours(-24),
        currentPriceCents: state.currentPriceCents,
        leaderCustomerId: state.leader?.bidderId ?? null,
        leaderMaxCents: state.leader?.maxCents ?? null,
        leaderSeq: state.leader?.seq ?? null,
        bidCount: seq,
        reserveMet: state.leader !== null,
        closedAt: args.live ? null : hours(-24),
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

    return {
      auctionId: auction!.id, listingId: listing!.id, itemId: item!.id,
      title: lotTitle, hammerCents: state.currentPriceCents ?? args.startPriceCents,
      winnerId: state.leader?.bidderId ?? null,
    };
  };

  /** Победа становится настоящим заказом «ждёт оплаты» — как после торгов. */
  const mkOrder = async (a: Awaited<ReturnType<typeof mkAuction>>, customer: { id: string; email: string; alias: string }) => {
    const premiumCents = Math.round((a.hammerCents * PREMIUM_BP) / 10_000);
    const vatCents = Math.round(((a.hammerCents + premiumCents) * VAT_BP) / 10_000);
    await db.insert(t.orders).values({
      ref: `A-${await bump(db, "order_ref")}`,
      auctionId: a.auctionId, listingId: a.listingId, itemId: a.itemId,
      customerId: customer.id, customerAlias: customer.alias, customerEmail: customer.email,
      marketCode: "LV",
      hammerCents: a.hammerCents, premiumCents, vatCents, vatRateBp: VAT_BP,
      totalCents: a.hammerCents + premiumCents + vatCents,
      status: "awaiting_payment",
      paymentDeadlineAt: hours(48),
    });
    await db.update(t.items).set({ status: "awaiting_payment" }).where(eq(t.items.id, a.itemId));
  };

  const rival = { id: rivalId, email: `konkurents@${DOMAIN}`, alias: "bt_konkurents" };
  let made = 0;

  for (const sc of SCENARIOS) {
    for (let i = 1; i <= PER_SCENARIO; i++) {
      const email = `${sc.key}.${i}@${DOMAIN}`;
      const me = { id: await mkCustomer(email, `bt_${sc.key}${i}`, `${sc.name} ${i}`), email, alias: `bt_${sc.key}${i}` };
      made += 1;
      const base = 5_000 + made * 500;

      // Проигранные торги: моя ставка, соперник перебил — заказ у соперника.
      const lost = async () => {
        const a = await mkAuction({
          startPriceCents: base,
          live: false,
          bids: [{ customerId: me.id, maxCents: base + 2_000 }, { customerId: rival.id, maxCents: base + 6_000 }],
        });
        await mkOrder(a, rival);
      };
      // Выигранные: соперник начал, я перебил — заказ мой, ждёт оплаты.
      const won = async () => {
        const a = await mkAuction({
          startPriceCents: base,
          live: false,
          bids: [{ customerId: rival.id, maxCents: base + 1_000 }, { customerId: me.id, maxCents: base + 5_000 }],
        });
        await mkOrder(a, me);
      };
      // Живые торги: лидирую я или соперник.
      const liveLead = () =>
        mkAuction({
          startPriceCents: base,
          live: true,
          bids: [{ customerId: rival.id, maxCents: base + 1_000 }, { customerId: me.id, maxCents: base + 4_000 }],
        });
      const liveOutbid = () =>
        mkAuction({
          startPriceCents: base,
          live: true,
          bids: [{ customerId: me.id, maxCents: base + 1_000 }, { customerId: rival.id, maxCents: base + 4_000 }],
        });

      if (sc.key === "zaudejis") await lost();
      else if (sc.key === "uzvarejis") await won();
      else if (sc.key === "jaukts") { await won(); await lost(); }
      else if (sc.key === "vada") await liveLead();
      else if (sc.key === "parsists") await liveOutbid();
      else if (sc.key === "veterans") { await won(); await lost(); await liveLead(); }
      // svaigs — ничего: совершенно чистый аккаунт.
    }
  }

  console.log(`создано ${made} аккаунтов (${SCENARIOS.length} сценариев × ${PER_SCENARIO}) + 1 соперник`);
  console.log(`почта: <сценарий>.<1-5>@${DOMAIN} · пароль у всех: ${DEMO_PASSWORD}`);
  for (const sc of SCENARIOS) console.log(`  ${sc.key.padEnd(10)} — ${sc.name}: ${sc.key}.1@${DOMAIN} … ${sc.key}.${PER_SCENARIO}@${DOMAIN}`);
  console.log("убрать всё: node packages/db/dist/demoBidders.js remove");
}

async function remove(db: Db): Promise<void> {
  const demoItems = await db
    .select({ id: t.items.id })
    .from(t.items)
    .where(like(t.items.sku, `${SKU_PREFIX}-%`));
  const itemIds = demoItems.map((r) => r.id);
  if (itemIds.length > 0) {
    await db.delete(t.orders).where(inArray(t.orders.itemId, itemIds));
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
        await db.delete(t.watchlist).where(inArray(t.watchlist.auctionId, auctionIds));
        await db.delete(t.auctions).where(inArray(t.auctions.id, auctionIds));
      }
      await db.delete(t.watchlist).where(inArray(t.watchlist.listingId, listingIds));
      await db.delete(t.listings).where(inArray(t.listings.id, listingIds));
    }
    await db.delete(t.items).where(inArray(t.items.id, itemIds));
  }
  console.log(`удалено ${itemIds.length} демо-лотов ставок`);

  // Аккаунты — пробуем удалить; кто вплёлся в настоящую историю, остаётся.
  const demoCustomers = await db
    .select({ id: t.customers.id, alias: t.customers.alias })
    .from(t.customers)
    .where(like(t.customers.email, `%@${DOMAIN}`));
  let removed = 0;
  for (const c of demoCustomers) {
    try {
      await db.delete(t.customers).where(eq(t.customers.id, c.id));
      removed += 1;
    } catch {
      console.log(`оставлен ${c.alias} — на нём висит настоящая история`);
    }
  }
  console.log(`удалено ${removed} аккаунтов из ${demoCustomers.length}`);
}

const { db, pool } = createDb();
try {
  if (MODE === "remove") await remove(db);
  else await create(db);
} finally {
  await pool.end();
}
