/**
 * Demo scenarios — a working day's worth of realistic situations, created by
 * driving the real API exactly as the panel and the storefront do.
 *
 *   docker compose -f docker-compose.prod.yml exec api node apps/api/dist/demo/scenarios.js
 *
 * Nothing here writes to the database behind the application's back except to
 * age history (a lot bought "three weeks ago" has to actually be three weeks
 * old for the reports to say anything). Everything else goes through the same
 * routes a person clicks, which is the point: if a scenario completes, that
 * path works, and every notification it would send in real life is sent.
 *
 * Every row it creates is recorded under an `app_settings` key so
 * `apps/api/dist/demo/cleanup.js` can remove precisely this run and nothing else.
 */
import { adminUsers, appSettings, auctions, customers, items, orders, pickupTickets, stockMovements } from "@auction/db";
import { createDb } from "@auction/db";
import { and, eq } from "drizzle-orm";
import { loadConfig } from "../config.js";
import { signAccessToken } from "../auth/jwt.js";

const cfg = loadConfig();
const { db, pool } = createDb(cfg.databaseUrl);
const API = `http://127.0.0.1:${cfg.port}`;
const DAY = 86_400_000;

/** Demo buyers use plus-addressing on one real inbox: deliverable if SMTP is
 * live (so the owner actually sees the mail), and never a bounce. */
const INBOX = process.env.DEMO_EMAIL_BASE ?? "nikita.skakunovs@gmail.com";
const [INBOX_USER, INBOX_HOST] = INBOX.split("@");
const mailFor = (slug: string) => `${INBOX_USER}+demo_${slug}@${INBOX_HOST}`;

const RUN_KEY = `demo_run:${new Date().toISOString().replace(/[:.]/g, "-")}`;
const created = {
  customerIds: [] as string[],
  itemIds: [] as string[],
  consignmentIds: [] as string[],
  stockCountIds: [] as string[],
  supplierIds: [] as string[],
  returnCaseIds: [] as string[],
  locationIds: [] as string[],
};

let adminToken = "";
const log = (msg: string) => console.log(msg);

// ── plumbing ─────────────────────────────────────────────────────────────────

async function call<T>(
  method: string,
  path: string,
  opts: { token?: string; body?: unknown; expect?: number[] } = {},
): Promise<T> {
  // A POST with no body still has to look like JSON to Fastify, or it rejects
  // the request before any route sees it.
  const hasBody = opts.body !== undefined;
  const sendsBody = hasBody || method !== "GET";
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...(sendsBody ? { "content-type": "application/json" } : {}),
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
    },
    ...(sendsBody ? { body: JSON.stringify(hasBody ? opts.body : {}) } : {}),
  });
  const text = await res.text();
  const ok = opts.expect ? opts.expect.includes(res.status) : res.ok;
  if (!ok) throw new Error(`${method} ${path} → ${res.status} ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : {}) as T;
}

const admin = <T>(method: string, path: string, body?: unknown, expect?: number[]) =>
  call<T>(method, path, { token: adminToken, ...(body === undefined ? {} : { body }), ...(expect ? { expect } : {}) });

/** Sign a token for a real super admin rather than asking for a password —
 * this runs inside the API container, where the signing secret already lives,
 * and two-factor exists to protect a browser, not a server-side script. */
async function signInAsAdmin(): Promise<void> {
  const [row] = await db
    .select({ id: adminUsers.id, email: adminUsers.email, name: adminUsers.name, role: adminUsers.roleId })
    .from(adminUsers)
    .where(eq(adminUsers.roleId, "super_admin"))
    .limit(1);
  if (!row) throw new Error("no super_admin user found — is this database seeded?");
  adminToken = signAccessToken(
    { kind: "admin", sub: row.id, email: row.email, name: row.name, role: row.role },
    cfg.jwtSecret,
    3_600,
  );
  log(`acting as ${row.email}`);
}

/** Register a storefront buyer and return their bidder token + id. */
async function buyer(slug: string, name: string): Promise<{ id: string; token: string; alias: string; name: string }> {
  const alias = `demo_${slug}`;
  const body = { email: mailFor(slug), password: "DemoBuyer123!", alias, name, country: "LV" };
  // Re-running the script should extend these people's history, not fail on
  // them: a buyer who already exists is simply signed in.
  const reg = await call<{ accessToken?: string; error?: string }>("POST", "/api/public/auth/register", {
    body,
    expect: [200, 409],
  });
  const token =
    reg.accessToken ??
    (await call<{ accessToken: string }>("POST", "/api/public/auth/login", {
      body: { email: body.email, password: body.password },
    })).accessToken;
  const [row] = await db.select({ id: customers.id }).from(customers).where(eq(customers.email, body.email));
  if (!row) throw new Error(`buyer ${body.email} neither registered nor found`);
  created.customerIds.push(row.id);
  return { id: row.id, token, alias, name };
}

/** A lot on the shelf, ready to sell: item → bin → listing → live auction. */
async function lot(
  title: string,
  opts: { category?: string; startCents?: number; costCents?: number; endsInMs?: number; binId?: string },
): Promise<{ itemId: string; auctionId: string; listingId: string; sku: string }> {
  const { item } = await admin<{ item: { id: string; sku: string } }>("POST", "/api/items", {
    sku: `D-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
    title,
    marketCode: "LV",
    condition: "used_good",
    category: opts.category ?? "other",
  });
  created.itemIds.push(item.id);
  if (opts.costCents !== undefined) {
    await admin("PATCH", `/api/items/${item.id}/cost`, { costCents: opts.costCents });
  }
  if (opts.binId) {
    await admin("POST", `/api/items/${item.id}/putaway`, { locationId: opts.binId, reason: "demo — sākotnējā novietošana" });
  }
  const { listing } = await admin<{ listing: { id: string } }>("POST", "/api/listings", {
    itemId: item.id,
    type: "auction",
    title,
    marketCode: "LV",
    startPriceCents: opts.startCents ?? 2_000,
    reserveCents: null,
  });
  await admin("POST", `/api/listings/${listing.id}/publish`);
  const now = Date.now();
  const { auction } = await admin<{ auction: { id: string } }>("POST", "/api/auctions", {
    listingId: listing.id,
    startsAt: new Date(now - 2_000).toISOString(),
    endsAt: new Date(now + (opts.endsInMs ?? 3_600_000)).toISOString(),
  });
  // The scheduler opens scheduled auctions on its next tick.
  for (let i = 0; i < 20; i++) {
    const a = await admin<{ auction: { status: string } }>("GET", `/api/auctions/${auction.id}`);
    if (a.auction.status === "live") break;
    await sleep(700);
  }
  return { itemId: item.id, auctionId: auction.id, listingId: listing.id, sku: item.sku };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * End an auction now. A demo bid always lands inside the anti-snipe window,
 * which correctly pushes the finish out — real behaviour, but it would make
 * this script wait minutes per lot. Winding the finish line back is the one
 * honest shortcut: the scheduler still closes it, picks the winner and raises
 * the order exactly as it would have.
 */
async function endNow(auctionId: string): Promise<void> {
  await db.update(auctions).set({ endsAt: new Date(Date.now() - 1_000) }).where(eq(auctions.id, auctionId));
}

/** Wait for the scheduler to close an auction into an order. */
async function wonOrder(itemId: string): Promise<{ id: string; ref: string; totalCents: number }> {
  for (let i = 0; i < 40; i++) {
    const [row] = await db
      .select({ id: orders.id, ref: orders.ref, totalCents: orders.totalCents })
      .from(orders)
      .where(eq(orders.itemId, itemId));
    if (row) return row;
    await sleep(1_000);
  }
  throw new Error("auction never closed into an order — is the scheduler running?");
}

/** Take the lot home: check in, pick, hand over. */
async function collect(customerId: string): Promise<void> {
  const ci = await admin<{ ticketId: string }>("POST", "/api/pickup/checkin", { customerId });
  await admin("POST", `/api/pickup/tickets/${ci.ticketId}/claim`);
  const queue = await admin<{ tickets: Array<{ id: string; lines: Array<{ id: string }> }> }>("GET", "/api/pickup/queue");
  const ticket = queue.tickets.find((t) => t.id === ci.ticketId);
  for (const line of ticket?.lines ?? []) {
    await admin("POST", `/api/pickup/tickets/${ci.ticketId}/lines/${line.id}`, { status: "picked" });
  }
  await admin("POST", `/api/pickup/tickets/${ci.ticketId}/delivering`);
  await admin("POST", `/api/pickup/tickets/${ci.ticketId}/complete`, { overrideReason: "demo — izsniegts" });
}

/** Age a lot's history so the reports have something to say. */
async function backdate(itemId: string, days: number): Promise<void> {
  const when = new Date(Date.now() - days * DAY);
  await db.update(items).set({ createdAt: when }).where(eq(items.id, itemId));
  await db.update(stockMovements).set({ createdAt: when }).where(eq(stockMovements.itemId, itemId));
  await db.update(orders).set({ paidAt: when, createdAt: when }).where(eq(orders.itemId, itemId));
  const [order] = await db.select({ customerId: orders.customerId }).from(orders).where(eq(orders.itemId, itemId));
  if (order) {
    await db
      .update(pickupTickets)
      .set({ completedAt: when })
      .where(and(eq(pickupTickets.customerId, order.customerId), eq(pickupTickets.status, "done")));
  }
}

// ── the scenarios ────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  log("── demo scenarios ─────────────────────────────────────────");
  log(`buyer mail → ${mailFor("<name>")}`);
  await signInAsAdmin();

  // A bin to put things in, so the warehouse screens have somewhere to point.
  // Re-running is normal — a second run reuses the bin rather than stopping.
  const bin = await (async () => {
    const made = await admin<{ location?: { id: string; label: string } }>(
      "POST",
      "/api/warehouse/locations",
      { zone: "DEMO", aisle: "A1", rack: "R1" },
      [200, 409],
    );
    if (made.location) {
      created.locationIds.push(made.location.id);
      return made.location;
    }
    const all = await admin<{ locations: Array<{ id: string; label: string; zone: string }> }>(
      "GET",
      "/api/warehouse/locations",
    );
    const found = all.locations.find((l) => l.zone === "DEMO");
    if (!found) throw new Error("DEMO bin exists but could not be found");
    return found;
  })();
  log(`bin ${bin.label}`);

  // 1 ── the ordinary day: bid, win, pay at the counter, take it home.
  {
    const anna = await buyer("anna", "Anna Bērziņa");
    const l = await lot("Bosch GSR 18V urbjmašīna, kastē", { category: "tools", startCents: 3_400, costCents: 1_800, binId: bin.id });
    await call("POST", `/api/public/auctions/${l.auctionId}/bids`, { token: anna.token, body: { maxCents: 6_000 } });
    await endNow(l.auctionId);
    const order = await wonOrder(l.itemId);
    await admin("POST", "/api/desk/pay", { orderIds: [order.id], method: "cash" });
    await collect(anna.id);
    await backdate(l.itemId, 9);
    log("1 · Anna — nopirka, samaksāja skaidrā, izņēma");
  }

  // 2 ── two bidders, one loses: exercises outbid notification.
  {
    const toms = await buyer("toms", "Toms Zaļais");
    const elina = await buyer("elina", "Elīna Priede");
    const l = await lot("Omega Seamaster, 1970. gadi", { category: "jewellery_watches", startCents: 12_000, costCents: 7_000, binId: bin.id });
    await call("POST", `/api/public/auctions/${l.auctionId}/bids`, { token: toms.token, body: { maxCents: 15_000 } });
    await sleep(500);
    await call("POST", `/api/public/auctions/${l.auctionId}/bids`, { token: elina.token, body: { maxCents: 22_000 } });
    await endNow(l.auctionId);
    const order = await wonOrder(l.itemId);
    await admin("POST", "/api/desk/pay", { orderIds: [order.id], method: "card_terminal" });
    await collect(elina.id);
    await backdate(l.itemId, 21);
    log("2 · Toms pārsolīts, Elīna nopirka un izņēma");
  }

  // 3 ── won and never paid: the deadline path, left for the scheduler.
  {
    const janis = await buyer("janis", "Jānis Ozols");
    const l = await lot("Antīks pulkstenis ar atsvariem", { category: "art_antiques", startCents: 4_500, costCents: 2_000, binId: bin.id });
    await call("POST", `/api/public/auctions/${l.auctionId}/bids`, { token: janis.token, body: { maxCents: 5_500 } });
    await endNow(l.auctionId);
    const order = await wonOrder(l.itemId);
    // Put the deadline in the past; the scheduler will chase and then cancel.
    await db.update(orders).set({ paymentDeadlineAt: new Date(Date.now() - 2 * DAY) }).where(eq(orders.id, order.id));
    log("3 · Jānis — uzvarēja, nav samaksājis, termiņš pagājis (plānotājs atcels)");
  }

  // 4 ── paid, collected, brought back inside the window.
  {
    const maris = await buyer("maris", "Māris Zvaigzne");
    const l = await lot("Porcelāna servīze, 12 personām", { category: "home_garden", startCents: 5_000, costCents: 2_400, binId: bin.id });
    await call("POST", `/api/public/auctions/${l.auctionId}/bids`, { token: maris.token, body: { maxCents: 8_000 } });
    await endNow(l.auctionId);
    const order = await wonOrder(l.itemId);
    await admin("POST", "/api/desk/pay", { orderIds: [order.id], method: "cash" });
    await collect(maris.id);
    const opened = await admin<{ case: { id: string } }>("POST", "/api/returns", {
      orderId: order.id,
      itemId: l.itemId,
      reason: "not_as_described",
      note: "Trūkst divu šķīvju — aprakstā nebija minēts",
    });
    created.returnCaseIds.push(opened.case.id);
    await admin("POST", `/api/returns/${opened.case.id}/resolve`, {
      decision: "refund_full",
      destination: "quarantine",
      note: "Atmaksāts pilnā apmērā, prece pārbaudei",
    });
    log("4 · Māris — atgrieza preci, nauda atmaksāta, prece karantīnā");
  }

  // 5 ── back after the window closed: the override is recorded.
  {
    const ilze = await buyer("ilze", "Ilze Lapsa");
    const l = await lot("Dzintara kaklarota, 52 g", { category: "jewellery_watches", startCents: 6_000, costCents: 3_000, binId: bin.id });
    await call("POST", `/api/public/auctions/${l.auctionId}/bids`, { token: ilze.token, body: { maxCents: 9_000 } });
    await endNow(l.auctionId);
    const order = await wonOrder(l.itemId);
    await admin("POST", "/api/desk/pay", { orderIds: [order.id], method: "cash" });
    await collect(ilze.id);
    await backdate(l.itemId, 24); // collected over three weeks ago
    const opened = await admin<{ case: { id: string } }>("POST", "/api/returns", {
      orderId: order.id,
      itemId: l.itemId,
      reason: "changed_mind",
      note: "Nepatika dāvanas saņēmējai",
      overrideReason: "Pastāvīga kliente, pieņemam izņēmuma kārtā",
    });
    created.returnCaseIds.push(opened.case.id);
    log("5 · Ilze — atgriešana pēc 14 dienām, ar pamatojumu · GAIDA LĒMUMU");
  }

  // 6 ── a claim that does not hold up.
  {
    const roberts = await buyer("roberts", "Roberts Vanags");
    const l = await lot("Zenit-E fotoaparāta komplekts", { category: "electronics", startCents: 2_500, costCents: 1_100, binId: bin.id });
    await call("POST", `/api/public/auctions/${l.auctionId}/bids`, { token: roberts.token, body: { maxCents: 4_000 } });
    await endNow(l.auctionId);
    const order = await wonOrder(l.itemId);
    await admin("POST", "/api/desk/pay", { orderIds: [order.id], method: "cash" });
    await collect(roberts.id);
    const opened = await admin<{ case: { id: string } }>("POST", "/api/returns", {
      orderId: order.id,
      itemId: l.itemId,
      reason: "changed_mind",
      note: "Grib atgriezt bez iemesla",
    });
    created.returnCaseIds.push(opened.case.id);
    await admin("POST", `/api/returns/${opened.case.id}/resolve`, {
      decision: "rejected",
      destination: "kept_by_buyer",
      note: "Prece atbilst aprakstam, stāvoklis norādīts",
    });
    log("6 · Roberts — pretenzija atteikta, prece paliek klientam");
  }

  // 7 ── a goodwill discount after the fact.
  {
    const dace = await buyer("dace", "Dace Krūmiņa");
    const l = await lot("Ozola bufete, 1930. gadi", { category: "furniture", startCents: 15_000, costCents: 8_000, binId: bin.id });
    await call("POST", `/api/public/auctions/${l.auctionId}/bids`, { token: dace.token, body: { maxCents: 19_000 } });
    await endNow(l.auctionId);
    const order = await wonOrder(l.itemId);
    await admin("POST", "/api/desk/pay", { orderIds: [order.id], method: "card_terminal" });
    await collect(dace.id);
    await admin("POST", `/api/orders/${order.id}/refund`, {
      amountCents: Math.round(order.totalCents * 0.15),
      reason: "Skrāpējums durvīs, klients patur preci",
      viaProvider: false,
    });
    await backdate(l.itemId, 14);
    log("7 · Dace — daļēja atmaksa, prece paliek klientam");
  }

  // 8 ── several lots, settled together at the counter.
  {
    const andris = await buyer("andris", "Andris Bērzs");
    const a = await lot("Slīpmašīna Makita", { category: "tools", startCents: 2_200, costCents: 900, binId: bin.id });
    const b = await lot("Instrumentu kaste ar saturu", { category: "tools", startCents: 1_800, costCents: 700, binId: bin.id });
    for (const l of [a, b]) {
      await call("POST", `/api/public/auctions/${l.auctionId}/bids`, { token: andris.token, body: { maxCents: 5_000 } });
    }
    await endNow(a.auctionId);
    await endNow(b.auctionId);
    const o1 = await wonOrder(a.itemId);
    const o2 = await wonOrder(b.itemId);
    await admin("POST", "/api/desk/pay", { orderIds: [o1.id, o2.id], method: "cash" });
    await collect(andris.id);
    log("8 · Andris — divas preces vienā maksājumā, abas izņemtas");
  }

  // 9 ── waiting at the counter right now, so the queue screen has a queue.
  {
    const liga = await buyer("liga", "Līga Kalniņa");
    const l = await lot("Kafijas automāts DeLonghi", { category: "home_garden", startCents: 4_000, costCents: 1_500, binId: bin.id });
    await call("POST", `/api/public/auctions/${l.auctionId}/bids`, { token: liga.token, body: { maxCents: 6_500 } });
    await endNow(l.auctionId);
    const order = await wonOrder(l.itemId);
    await admin("POST", "/api/desk/pay", { orderIds: [order.id], method: "cash" });
    await admin("POST", "/api/pickup/checkin", { customerId: liga.id });
    log("9 · Līga — samaksājusi, GAIDA PIE LETES (izsniegšanas rinda)");
  }

  // 10 ── an unsold lot, relisted: gives sell-through something to chew on.
  {
    const l = await lot("Gleznu komplekts, nezināms autors", { category: "art_antiques", startCents: 9_000, costCents: 4_000, binId: bin.id });
    await endNow(l.auctionId);
    await sleep(4_000); // let the scheduler close it with no bids
    await admin(
      "POST",
      `/api/auctions/${l.auctionId}/relist`,
      { startsAt: new Date(Date.now() + 60_000).toISOString(), endsAt: new Date(Date.now() + 3 * DAY).toISOString() },
      [200, 409],
    );
    await backdate(l.itemId, 120);
    log("10 · Gleznas — nepārdevās, izliktas atkārtoti, plauktā 120 dienas");
  }

  // ── warehouse and money ──────────────────────────────────────────────────

  // A delivery with real costs, a supplier, and a bill that is partly paid.
  {
    const { supplier } = await admin<{ supplier: { id: string; name: string } }>("POST", "/api/suppliers", {
      name: "DEMO — Nordic Trade OÜ",
      regNo: "12345678",
      email: "sales@nordictrade.example",
      paymentTermsDays: 30,
      bankAccount: "EE382200221020145685",
    });
    created.supplierIds.push(supplier.id);
    const { consignment } = await admin<{ consignment: { id: string; ref: string } }>("POST", "/api/consignments", {
      supplier: supplier.name,
      supplierId: supplier.id,
      marketCode: "LV",
      expectedCount: 6,
      notes: "Demo piegāde — Tallinas izsole",
    });
    created.consignmentIds.push(consignment.id);
    for (const t of ["Sudraba karotes, 6 gab.", "Kristāla vāze", "Grāmatu komplekts", "Galda lampa", "Ādas soma", "Vinila plates, 20 gab."]) {
      const { item } = await admin<{ item: { id: string } }>("POST", `/api/consignments/${consignment.id}/receive`, { title: t });
      created.itemIds.push(item.id);
    }
    await admin("POST", `/api/consignments/${consignment.id}/spread-cost`, { totalCents: 42_000 });
    await admin("PATCH", `/api/consignments/${consignment.id}/costs`, { extraCostCents: 3_600 });
    const inv = await admin<{ invoice: { id: string } }>("POST", "/api/supplier-invoices", {
      consignmentId: consignment.id,
      number: "NT-2026-118",
      invoiceDate: new Date(Date.now() - 20 * DAY).toISOString(),
      amountCents: 47_000,
      note: "Demo rēķins",
    });
    await admin("POST", `/api/supplier-invoices/${inv.invoice.id}/payments`, { amountCents: 20_000, method: "bank_transfer" });
    // A second bill, overdue, so the payables screen has something red.
    await admin("POST", "/api/supplier-invoices", {
      supplierId: supplier.id,
      number: "NT-2026-092",
      invoiceDate: new Date(Date.now() - 60 * DAY).toISOString(),
      dueDate: new Date(Date.now() - 18 * DAY).toISOString(),
      amountCents: 12_600,
      note: "Demo — kavēts rēķins",
    });
    log("11 · Piegāde ar izmaksām, rēķins daļēji apmaksāts + viens KAVĒTS");
  }

  // A count with real discrepancies, left open for someone to review.
  {
    const { count } = await admin<{ count: { id: string } }>("POST", "/api/stock-counts", {
      name: `Demo inventarizācija ${new Date().toLocaleDateString("lv-LV")}`,
      zones: ["DEMO"],
    });
    created.stockCountIds.push(count.id);
    const detail = await admin<{ bins: Array<{ id: string; label: string }> }>("GET", `/api/stock-counts/${count.id}`);
    const target = detail.bins.find((b) => b.id === bin.id) ?? detail.bins[0];
    if (target) {
      const shelf = await admin<{ items: Array<{ id: string; sku: string }> }>("GET", `/api/items?bin=${target.id}&limit=20`);
      // Scan most of what is there, skip one (missing), add a code nobody knows.
      for (const it of (shelf.items ?? []).slice(0, Math.max(1, (shelf.items ?? []).length - 1))) {
        await admin("POST", `/api/stock-counts/${count.id}/scan`, { code: it.sku, locationId: target.id }, [200, 409]);
      }
      await admin("POST", `/api/stock-counts/${count.id}/scan`, { code: "NEZINAMS-001", locationId: target.id }, [200, 409]);
      await admin("POST", `/api/stock-counts/${count.id}/bin-done`, { locationId: target.id }, [200, 409]);
    }
    log("12 · Inventarizācija ar neatbilstībām · GAIDA APSTIPRINĀJUMU");
  }

  // Something in the grading queue, so the review screen is not empty.
  {
    const { item } = await admin<{ item: { id: string; sku: string } }>("POST", "/api/items", {
      sku: `D-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
      title: "Velosipēds ar bojātu rāmi",
      marketCode: "LV",
      category: "sports_outdoors",
    });
    created.itemIds.push(item.id);
    await admin("PATCH", `/api/items/${item.id}`, {
      condition: "damaged",
      conditionNotes: "Rāmis ieplaisājis pie sēdekļa — jāpārbauda pirms pārdošanas",
    });
    log("13 · Bojāta prece · GAIDA NOVĒRTĒJUMA PĀRBAUDI");
  }

  await db.insert(appSettings).values({ key: RUN_KEY, value: created as unknown as Record<string, unknown> }).onConflictDoUpdate({
    target: appSettings.key,
    set: { value: created as unknown as Record<string, unknown> },
  });

  log("───────────────────────────────────────────────────────────");
  log(`done · ${created.customerIds.length} klienti, ${created.itemIds.length} preces`);
  log(`run key: ${RUN_KEY}`);
  log("");
  log("Gaida tavu rīcību:");
  log("  · Lete → izsniegšanas rinda: Līga gaida savu preci");
  log("  · Lete → meklē demo_ilze: atgriešana pēc termiņa, jāpieņem lēmums");
  log("  · Pieņemšana → Inventarizācija: neatbilstības, jāapstiprina");
  log("  · Pieņemšana → Novērtējumu pārbaude: bojāts velosipēds");
  log("  · Finanses → Piegādātāju rēķini: viens kavēts rēķins");
  log("");
  log("Notīrīt visu šo: node apps/api/dist/demo/cleanup.js");
}

main()
  .then(async () => {
    await pool.end();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error("demo scenarios failed:", err instanceof Error ? err.message : err);
    console.error("partial data may exist — run: node apps/api/dist/demo/cleanup.js");
    await db
      .insert(appSettings)
      .values({ key: RUN_KEY, value: created as unknown as Record<string, unknown> })
      .onConflictDoUpdate({ target: appSettings.key, set: { value: created as unknown as Record<string, unknown> } })
      .catch(() => undefined);
    await pool.end();
    process.exit(1);
  });

