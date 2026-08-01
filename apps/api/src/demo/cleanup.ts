/**
 * Remove what the demo scenarios created — and only that.
 *
 *   docker compose -f docker-compose.prod.yml exec api node apps/api/dist/demo/cleanup.js
 *   docker compose -f docker-compose.prod.yml exec api node apps/api/dist/demo/cleanup.js --dry-run
 *
 * Each run of `scenarios.js` records the ids it created under an
 * `app_settings` key. This reads those keys and deletes in foreign-key order.
 * It never guesses: a row nobody recorded is a row it leaves alone.
 *
 * Invoice numbers already spent are not reclaimed — a sequence with gaps is
 * correct behaviour, and pretending otherwise would be worse than a gap.
 */
import {
  appSettings,
  auctions,
  bids,
  consignments,
  customerFees,
  customers,
  invoices,
  items,
  listings,
  notifications,
  orders,
  payments,
  pickupTicketItems,
  pickupTickets,
  refunds,
  returnCases,
  stockCountScans,
  stockCounts,
  stockMovements,
  supplierInvoices,
  supplierPayments,
  suppliers,
  warehouseLocations,
  createDb,
} from "@auction/db";
import { and, eq, inArray, like, sql } from "drizzle-orm";
import { loadConfig } from "../config.js";

const cfg = loadConfig();
const { db: globalDb, pool } = createDb(cfg.databaseUrl);
const db = globalDb;
const DRY = process.argv.includes("--dry-run");

interface RunRecord {
  customerIds?: string[];
  itemIds?: string[];
  consignmentIds?: string[];
  stockCountIds?: string[];
  supplierIds?: string[];
  returnCaseIds?: string[];
  locationIds?: string[];
}

const say = (label: string, n: number) => console.log(`  ${DRY ? "would delete" : "deleted"} ${String(n).padStart(4)} ${label}`);

/** Thrown to roll a dry run back once the real deletes have reported their
 * true counts — a dry run that guesses is worse than none. */
class DryRunRollback extends Error {}

async function main(): Promise<void> {
  const runs = await db.select().from(appSettings).where(like(appSettings.key, "demo_run:%"));
  if (runs.length === 0) {
    console.log("no demo runs recorded — nothing to clean up");
    return;
  }
  console.log(`${runs.length} demo run(s) recorded${DRY ? " · dry run, nothing will be deleted" : ""}`);

  const all: Required<RunRecord> = {
    customerIds: [], itemIds: [], consignmentIds: [], stockCountIds: [], supplierIds: [], returnCaseIds: [],
    locationIds: [],
  };
  for (const row of runs) {
    const rec = (row.value ?? {}) as RunRecord;
    for (const key of Object.keys(all) as Array<keyof typeof all>) {
      all[key].push(...(rec[key] ?? []));
    }
  }
  const uniq = <T>(xs: T[]) => [...new Set(xs)];
  const customerIds = uniq(all.customerIds);
  const itemIds = uniq(all.itemIds);
  const consignmentIds = uniq(all.consignmentIds);
  const stockCountIds = uniq(all.stockCountIds);
  const supplierIds = uniq(all.supplierIds);
  const locationIds = uniq(all.locationIds);

  // Orders and listings reached through the items they belong to — a demo
  // order is one whose item this script created.
  const orderRows = itemIds.length
    ? await db.select({ id: orders.id }).from(orders).where(inArray(orders.itemId, itemIds))
    : [];
  const orderIds = orderRows.map((o) => o.id);
  const listingRows = itemIds.length
    ? await db.select({ id: listings.id }).from(listings).where(inArray(listings.itemId, itemIds))
    : [];
  const listingIds = listingRows.map((l) => l.id);
  const auctionRows = listingIds.length
    ? await db.select({ id: auctions.id }).from(auctions).where(inArray(auctions.listingId, listingIds))
    : [];
  const auctionIds = auctionRows.map((a) => a.id);
  const ticketRows = customerIds.length
    ? await db.select({ id: pickupTickets.id }).from(pickupTickets).where(inArray(pickupTickets.customerId, customerIds))
    : [];
  const ticketIds = ticketRows.map((t) => t.id);
  const invoiceRows = supplierIds.length
    ? await db.select({ id: supplierInvoices.id }).from(supplierInvoices).where(inArray(supplierInvoices.supplierId, supplierIds))
    : [];
  const supplierInvoiceIds = invoiceRows.map((i) => i.id);

  // Everything runs as one transaction: a dry run performs the same deletes,
  // reports exactly what went, then rolls the whole thing back.
  const del = async <T>(label: string, ids: string[], run: (ids: string[]) => Promise<T[]>) => {
    if (ids.length === 0) return say(label, 0);
    const gone = await run(ids);
    say(label, gone.length);
  };

  try {
    await db.transaction(async (tx) => {
      await runDeletes(tx);
      if (DRY) throw new DryRunRollback();
    });
  } catch (err) {
    if (!(err instanceof DryRunRollback)) throw err;
    console.log("  (rolled back — nothing was deleted)");
  }

  async function runDeletes(db: typeof globalDb): Promise<void> {
  // Children first, parents last.
  await del("supplier payments", supplierInvoiceIds, (ids) =>
    db.delete(supplierPayments).where(inArray(supplierPayments.invoiceId, ids)).returning({ id: supplierPayments.id }));
  await del("supplier invoices", supplierInvoiceIds, (ids) =>
    db.delete(supplierInvoices).where(inArray(supplierInvoices.id, ids)).returning({ id: supplierInvoices.id }));
  await del("return cases", orderIds, (ids) =>
    db.delete(returnCases).where(inArray(returnCases.orderId, ids)).returning({ id: returnCases.id }));
  await del("stock count scans", stockCountIds, (ids) =>
    db.delete(stockCountScans).where(inArray(stockCountScans.countId, ids)).returning({ id: stockCountScans.id }));
  await del("stock counts", stockCountIds, (ids) =>
    db.delete(stockCounts).where(inArray(stockCounts.id, ids)).returning({ id: stockCounts.id }));
  await del("pickup ticket lines", ticketIds, (ids) =>
    db.delete(pickupTicketItems).where(inArray(pickupTicketItems.ticketId, ids)).returning({ id: pickupTicketItems.id }));
  await del("pickup tickets", ticketIds, (ids) =>
    db.delete(pickupTickets).where(inArray(pickupTickets.id, ids)).returning({ id: pickupTickets.id }));
  await del("refunds", orderIds, (ids) =>
    db.delete(refunds).where(inArray(refunds.orderId, ids)).returning({ id: refunds.id }));
  await del("payments", orderIds, (ids) =>
    db.delete(payments).where(inArray(payments.orderId, ids)).returning({ id: payments.id }));
  await del("invoices", orderIds, (ids) =>
    db.delete(invoices).where(inArray(invoices.orderId, ids)).returning({ id: invoices.id }));
  await del("customer fees", customerIds, (ids) =>
    db.delete(customerFees).where(inArray(customerFees.customerId, ids)).returning({ id: customerFees.id }));
  await del("orders", orderIds, (ids) =>
    db.delete(orders).where(inArray(orders.id, ids)).returning({ id: orders.id }));
  await del("bids", auctionIds, (ids) =>
    db.delete(bids).where(inArray(bids.auctionId, ids)).returning({ id: bids.id }));
  await del("auctions", auctionIds, (ids) =>
    db.delete(auctions).where(inArray(auctions.id, ids)).returning({ id: auctions.id }));
  await del("listings", listingIds, (ids) =>
    db.delete(listings).where(inArray(listings.id, ids)).returning({ id: listings.id }));
  await del("stock movements", itemIds, (ids) =>
    db.delete(stockMovements).where(inArray(stockMovements.itemId, ids)).returning({ id: stockMovements.id }));
  await del("notifications", customerIds, (ids) =>
    db.delete(notifications).where(inArray(notifications.customerId, ids)).returning({ id: notifications.id }));
  await del("items", itemIds, (ids) =>
    db.delete(items).where(inArray(items.id, ids)).returning({ id: items.id }));
  await del("consignments", consignmentIds, (ids) =>
    db.delete(consignments).where(inArray(consignments.id, ids)).returning({ id: consignments.id }));
  await del("suppliers", supplierIds, (ids) =>
    db.delete(suppliers).where(inArray(suppliers.id, ids)).returning({ id: suppliers.id }));
  await del("customers", customerIds, (ids) =>
    db.delete(customers).where(inArray(customers.id, ids)).returning({ id: customers.id }));
  // The demo bin goes last: items had to leave it first. Any empty DEMO-zone
  // bin is swept too, not just recorded ones — a run that died before it could
  // record the bin it had just made would otherwise leave it behind forever.
  await del("warehouse bins", locationIds, (ids) =>
    db.delete(warehouseLocations).where(inArray(warehouseLocations.id, ids)).returning({ id: warehouseLocations.id }));
  const strays = await db
    .delete(warehouseLocations)
    .where(
      and(
        eq(warehouseLocations.zone, "DEMO"),
        sql`not exists (select 1 from items i where i.location_id = ${warehouseLocations.id})`,
      ),
    )
    .returning({ id: warehouseLocations.id });
  if (strays.length > 0) say("stray demo bins", strays.length);

  }

  if (!DRY) {
    for (const row of runs) await db.delete(appSettings).where(eq(appSettings.key, row.key));
    console.log("demo run records cleared");
    console.log("");
    console.log("Note: invoice and order numbers used by the demo are not reused —");
    console.log("a numbered sequence with gaps is correct; renumbering would not be.");
  }
}

main()
  .then(async () => {
    await pool.end();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error("cleanup failed:", err instanceof Error ? err.message : err);
    await pool.end();
    process.exit(1);
  });

