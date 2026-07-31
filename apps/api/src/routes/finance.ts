import { randomBytes } from "node:crypto";
import { consignments, customers, invoices, items, orders, warehouseLocations } from "@auction/db";
import { isDamagedFamilyCondition, viesFormatValid, viesParse, type ViesCheck } from "@auction/domain";
import { and, desc, eq, gte, ilike, inArray, isNotNull, lt, or, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { writeAudit } from "../audit.js";
import { verifyAccessToken } from "../auth/jwt.js";
import { requirePermission, type PermissionService } from "../auth/rbac.js";
import type { AppContext } from "../context.js";
import { renderInvoiceHtml, issueInvoice, type InvoiceData } from "../engine/invoices.js";

const actor = (req: { admin?: { sub: string; name: string } }) => ({
  id: req.admin?.sub ?? null,
  label: req.admin?.name ?? "Unknown",
});

/** Server-side VIES consultation (design doc: never from the browser). */
async function viesLookup(ctx: AppContext, vatNo: string): Promise<ViesCheck> {
  const parsed = viesParse(vatNo);
  const now = ctx.now();
  if (ctx.config.viesMode === "simulate" || !parsed?.cc) {
    return {
      valid: viesFormatValid(vatNo),
      checkedAt: now.toISOString(),
      consult: `SIM${parsed?.cc ?? "XX"}${randomBytes(4).toString("hex").toUpperCase()}`,
    };
  }
  const res = await fetch(
    `https://ec.europa.eu/taxation_customs/vies/rest-api/check-vat-number`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ countryCode: parsed.cc, vatNumber: parsed.rest }),
      signal: AbortSignal.timeout(8_000),
    },
  );
  if (!res.ok) throw new Error(`VIES service returned ${res.status}`);
  const body = (await res.json()) as { valid?: boolean; requestIdentifier?: string };
  return {
    valid: body.valid === true,
    checkedAt: now.toISOString(),
    consult: body.requestIdentifier || `W${parsed.cc}${randomBytes(4).toString("hex").toUpperCase()}`,
  };
}

export function registerFinanceRoutes(app: FastifyInstance, ctx: AppContext, perms: PermissionService): void {
  const guard = (p: Parameters<typeof requirePermission>[1]) => ({ preHandler: requirePermission(perms, p) });

  // ── Invoices ──────────────────────────────────────────────────────────────

  app.get("/api/invoices", guard("invoices.view"), async (req) => {
    const q = req.query as { q?: string; from?: string; to?: string; limit?: string; offset?: string };
    const conds = [];
    if (q.q) conds.push(or(ilike(invoices.number, `%${q.q}%`), ilike(orders.ref, `%${q.q}%`), ilike(orders.customerAlias, `%${q.q}%`)));
    const dayStart = (d: string) => new Date(`${d}T00:00:00.000Z`);
    if (q.from) conds.push(gte(invoices.issuedAt, dayStart(q.from)));
    if (q.to) conds.push(lt(invoices.issuedAt, new Date(dayStart(q.to).getTime() + 86_400_000)));
    const where = conds.length ? and(...conds) : undefined;
    const limit = Math.min(Math.max(Number(q.limit) || 500, 1), 500);
    const offset = Math.max(Number(q.offset) || 0, 0);
    const rows = await ctx.db
      .select({ invoice: invoices, orderRef: orders.ref, orderStatus: orders.status, totalCents: orders.totalCents })
      .from(invoices)
      .innerJoin(orders, eq(invoices.orderId, orders.id))
      .where(where)
      .orderBy(desc(invoices.issuedAt))
      .limit(limit)
      .offset(offset);
    const [totalRow] = await ctx.db
      .select({ n: sql<string>`count(*)` })
      .from(invoices)
      .innerJoin(orders, eq(invoices.orderId, orders.id))
      .where(where);
    return {
      total: Number(totalRow!.n),
      invoices: rows.map((r) => ({
        id: r.invoice.id,
        number: r.invoice.number,
        series: r.invoice.series,
        orderId: r.invoice.orderId,
        orderRef: r.orderRef,
        orderStatus: r.orderStatus,
        issuedAt: r.invoice.issuedAt,
        data: r.invoice.data,
      })),
    };
  });

  /**
   * Printable document. Browsers can't attach Authorization headers to a
   * new tab, so this endpoint (only) also accepts the access token as a
   * query parameter — same verification, same permission check.
   */
  app.get("/api/invoices/:id/html", async (req, reply) => {
    let admin = req.admin;
    if (!admin) {
      const token = (req.query as { token?: string }).token;
      const claims = token ? verifyAccessToken(token, ctx.config.jwtSecret, ctx.now().getTime()) : null;
      // Only admin-kind tokens qualify — a bidder token must never reach an
      // admin endpoint, matching the onRequest hook's kind separation.
      if (claims?.kind === "admin") admin = claims;
    }
    if (!admin) return reply.code(401).send({ error: "unauthenticated" });
    if (!(await perms.has(admin.role, "invoices.view"))) return reply.code(403).send({ error: "forbidden" });

    const { id } = req.params as { id: string };
    const [row] = await ctx.db.select().from(invoices).where(eq(invoices.id, id));
    if (!row) return reply.code(404).send({ error: "not_found" });
    return reply.type("text/html").send(renderInvoiceHtml(row.number, row.issuedAt, row.data as unknown as InvoiceData));
  });

  /** Backfill an invoice for an order that predates invoicing (idempotent). */
  app.post("/api/orders/:id/issue-invoice", guard("invoices.issue"), async (req, reply) => {
    const { id } = req.params as { id: string };
    const [order] = await ctx.db.select({ id: orders.id, ref: orders.ref }).from(orders).where(eq(orders.id, id));
    if (!order) return reply.code(404).send({ error: "not_found" });
    const result = await ctx.db.transaction(async (tx) => issueInvoice(tx, id, ctx.now()));
    if (!result) return reply.code(409).send({ error: "invoice_already_issued" });
    await writeAudit(ctx.db, actor(req), "finance", "invoice_issued", result.number, { orderRef: order.ref });
    return { invoice: result };
  });

  // ── VAT report ────────────────────────────────────────────────────────────

  app.get("/api/reports/vat", guard("finance.view"), async (req, reply) => {
    const q = z
      .object({ from: z.coerce.date(), to: z.coerce.date() })
      .safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: "invalid_range", detail: "from and to (ISO dates) required" });
    const { from, to } = q.data;

    // Accrual basis: invoices issued in [from, to). Confirm treatment with
    // the accountant before filing (design-doc note).
    const rows = await ctx.db
      .select({
        marketCode: orders.marketCode,
        count: sql<string>`count(*)`,
        netCents: sql<string>`coalesce(sum(${orders.hammerCents} + ${orders.premiumCents}), 0)`,
        vatCents: sql<string>`coalesce(sum(${orders.vatCents}), 0)`,
        grossCents: sql<string>`coalesce(sum(${orders.totalCents}), 0)`,
        reverseChargeNetCents: sql<string>`coalesce(sum(case when ${orders.reverseCharge} then ${orders.hammerCents} + ${orders.premiumCents} else 0 end), 0)`,
        reverseChargeCount: sql<string>`coalesce(sum(case when ${orders.reverseCharge} then 1 else 0 end), 0)`,
      })
      .from(invoices)
      .innerJoin(orders, eq(invoices.orderId, orders.id))
      .where(and(gte(invoices.issuedAt, from), lt(invoices.issuedAt, to)))
      .groupBy(orders.marketCode);

    return {
      from: from.toISOString(),
      to: to.toISOString(),
      basis: "invoices_issued",
      markets: rows.map((r) => ({
        marketCode: r.marketCode,
        invoiceCount: Number(r.count),
        netCents: Number(r.netCents),
        vatCents: Number(r.vatCents),
        grossCents: Number(r.grossCents),
        reverseChargeNetCents: Number(r.reverseChargeNetCents),
        reverseChargeCount: Number(r.reverseChargeCount),
      })),
    };
  });

  // ── W6: profit & stock valuation ──────────────────────────────────────────

  /**
   * An order stops being a sale the moment the money goes back, and `paidAt`
   * does not say so: a full refund leaves `paidAt` in place and flips the
   * status to `refunded` (routes/orders.ts), and a no-show cancellation keeps
   * `paidAt` too while setting `cancelled` and putting the unit back on the
   * shelf as `no_pickup_cancelled` (engine/noShow.ts). Order statuses are
   * awaiting_payment | paid | cancelled | refunded (db schema) — only `paid`
   * is still a completed sale, so every money figure below filters on the
   * status, never on `paidAt` alone.
   */
  const SOLD_ORDER_STATUSES = ["paid"];

  /** Rows handed to the browser's table; the totals always cover the whole window. */
  const LINE_LIMIT = 2000;

  /**
   * Effective unit cost = the item's own purchase cost plus its share of the
   * delivery's extra costs (transport/cleaning), spread pro-rata over every
   * unit received with that consignment. An item with no recorded cost stays
   * `null` — "no data", never assumed zero (approved design decision).
   *
   * The share is rounded per unit (not floor-plus-remainder as in receiving's
   * spread-cost) so the same expression can be written in SQL for the summary
   * aggregate; a remainder split would depend on row order and make the two
   * disagree. Worst case the report drifts by under a cent per unit.
   */
  const extraShareMap = async (): Promise<Map<string, number>> => {
    const rows = await ctx.db
      .select({
        id: consignments.id,
        extraCostCents: consignments.extraCostCents,
        received: sql<string>`count(${items.id})`,
      })
      .from(consignments)
      .leftJoin(items, eq(items.consignmentId, consignments.id))
      .where(isNotNull(consignments.extraCostCents))
      .groupBy(consignments.id);
    return new Map(
      rows
        .filter((r) => Number(r.received) > 0)
        .map((r) => [r.id, Math.round((r.extraCostCents ?? 0) / Number(r.received))]),
    );
  };

  const effectiveCost = (
    costCents: number | null,
    consignmentId: string | null,
    shares: Map<string, number>,
  ): number | null =>
    costCents === null ? null : costCents + (consignmentId ? (shares.get(consignmentId) ?? 0) : 0);

  /**
   * Profit = hammer price − effective cost, before buyer premium and VAT
   * (those are the buyer's side of the invoice). Basis: orders paid in the
   * window that are still sales (see SOLD_ORDER_STATUSES). Every total carries
   * a no-cost-data count so a profit figure is never quietly based on half the
   * sales, and the summary is aggregated in the database so it covers the
   * whole window even when the line table below is truncated.
   */
  app.get("/api/reports/profit", guard("finance.view"), async (req, reply) => {
    const q = z.object({ from: z.coerce.date(), to: z.coerce.date() }).safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: "invalid_range", detail: "from and to (ISO dates) required" });
    const { from, to } = q.data;

    // Sales that are still sales, paid inside the window. Refunded and
    // no-show-cancelled orders keep their `paidAt` and must not be booked.
    const soldInWindow = and(
      inArray(orders.status, SOLD_ORDER_STATUSES),
      isNotNull(orders.paidAt),
      gte(orders.paidAt, from),
      lt(orders.paidAt, to),
    );

    const shares = await extraShareMap();
    const rows = await ctx.db
      .select({
        orderRef: orders.ref,
        paidAt: orders.paidAt,
        hammerCents: orders.hammerCents,
        sku: items.sku,
        title: items.title,
        costCents: items.costCents,
        consignmentId: items.consignmentId,
      })
      .from(orders)
      .innerJoin(items, eq(orders.itemId, items.id))
      .where(soldInWindow)
      .orderBy(desc(orders.paidAt))
      .limit(LINE_LIMIT);

    const lines = rows.map((r) => {
      const cost = effectiveCost(r.costCents, r.consignmentId, shares);
      return {
        sku: r.sku,
        title: r.title,
        orderRef: r.orderRef,
        paidAt: r.paidAt,
        soldCents: r.hammerCents,
        costCents: cost,
        profitCents: cost === null ? null : r.hammerCents - cost,
        marginPct: cost === null || cost === 0 ? null : Math.round(((r.hammerCents - cost) / cost) * 100),
      };
    });
    // Totals come from the database, never from `lines`: the table is capped
    // at LINE_LIMIT rows, so reducing over it would report the total of the
    // first page as the total of the period. Same pro-rata extras as
    // effectiveCost(), written in SQL — the delivery's extra cost over the
    // number of units that delivery received.
    const extraShareSql = sql`coalesce(round(${consignments.extraCostCents}::numeric / nullif((select count(*) from ${items} u where u.consignment_id = ${consignments.id}), 0)), 0)`;
    const [agg] = await ctx.db
      .select({
        soldCount: sql<string>`count(*)`,
        revenueCents: sql<string>`coalesce(sum(${orders.hammerCents}), 0)`,
        // Cost and profit are summed only over rows that have a cost: a blank
        // cost is unknown, never zero, and is reported as noCostData instead.
        costCents: sql<string>`coalesce(sum(${items.costCents} + ${extraShareSql}) filter (where ${items.costCents} is not null), 0)`,
        profitCents: sql<string>`coalesce(sum(${orders.hammerCents} - ${items.costCents} - ${extraShareSql}) filter (where ${items.costCents} is not null), 0)`,
        noCostData: sql<string>`count(*) filter (where ${items.costCents} is null)`,
      })
      .from(orders)
      .innerJoin(items, eq(orders.itemId, items.id))
      .leftJoin(consignments, eq(items.consignmentId, consignments.id))
      .where(soldInWindow);

    const soldCount = Number(agg!.soldCount);
    const totalCost = Number(agg!.costCents);
    const totalProfit = Number(agg!.profitCents);

    // Delivery scoreboard: sold/received per consignment (all-time — a pallet
    // pays off over months, not inside the report window).
    const conRows = await ctx.db
      .select({
        id: consignments.id,
        ref: consignments.ref,
        supplier: consignments.supplier,
        // The orders join fans a unit out into one row per sale, so a plain
        // count(items.id) would count a twice-sold unit as two units received.
        received: sql<string>`count(distinct ${items.id})`,
        sold: sql<string>`count(distinct ${orders.id})`,
        profitKnown: sql<string>`coalesce(sum(${orders.hammerCents} - ${items.costCents}) filter (where ${orders.id} is not null and ${items.costCents} is not null), 0)`,
        soldKnown: sql<string>`count(*) filter (where ${orders.id} is not null and ${items.costCents} is not null)`,
      })
      .from(consignments)
      .leftJoin(items, eq(items.consignmentId, consignments.id))
      .leftJoin(
        orders,
        and(eq(orders.itemId, items.id), inArray(orders.status, SOLD_ORDER_STATUSES), isNotNull(orders.paidAt)),
      )
      .groupBy(consignments.id)
      .orderBy(desc(consignments.createdAt))
      .limit(30);

    return {
      from: from.toISOString(),
      to: to.toISOString(),
      summary: {
        soldCount,
        revenueCents: Number(agg!.revenueCents),
        profitCents: totalProfit,
        marginPct: totalCost > 0 ? Math.round((totalProfit / totalCost) * 100) : null,
        noCostData: Number(agg!.noCostData),
        // True when `lines` is only the first page: the table is a partial
        // view of the period, these totals never are.
        truncated: soldCount > lines.length,
        lineLimit: LINE_LIMIT,
      },
      lines,
      consignments: conRows.map((r) => {
        const share = shares.get(r.id) ?? 0;
        const soldKnown = Number(r.soldKnown);
        return {
          ref: r.ref,
          supplier: r.supplier,
          receivedCount: Number(r.received),
          soldCount: Number(r.sold),
          // The pro-rata delivery extras land on each sold unit's cost here.
          profitCents: soldKnown > 0 ? Number(r.profitKnown) - share * soldKnown : null,
          noCostData: Number(r.sold) - soldKnown,
        };
      }),
    };
  });

  /** What the shelves are worth today, at purchase cost, in three buckets. */
  app.get("/api/reports/stock-value", guard("finance.view"), async (_req, reply) => {
    // Everything physically in the warehouse and still ours to sell. The two
    // *_cancelled statuses are units whose sale fell through (unpaid winner,
    // no-show pickup): the goods came back and are relistable, so they are
    // stock. `won`/`awaiting_payment`/`paid` are sold and merely awaiting
    // collection — valuing those as stock would count them twice.
    const IN_STOCK = ["draft", "listed", "live", "unsold", "unpaid_cancelled", "no_pickup_cancelled"];
    const shares = await extraShareMap();
    const rows = await ctx.db
      .select({
        status: items.status,
        condition: items.condition,
        costCents: items.costCents,
        consignmentId: items.consignmentId,
        zone: warehouseLocations.zone,
      })
      .from(items)
      .leftJoin(warehouseLocations, eq(items.locationId, warehouseLocations.id))
      .where(inArray(items.status, IN_STOCK));

    const empty = () => ({ units: 0, valueCents: 0, noCostData: 0 });
    const buckets = { ready: empty(), drafts: empty(), quarantine: empty() };
    for (const r of rows) {
      const bucket =
        r.zone === "QUARANTINE" || isDamagedFamilyCondition(r.condition)
          ? buckets.quarantine
          : r.status === "draft"
            ? buckets.drafts
            : buckets.ready;
      const cost = effectiveCost(r.costCents, r.consignmentId, shares);
      bucket.units += 1;
      if (cost === null) bucket.noCostData += 1;
      else bucket.valueCents += cost;
    }
    void reply;
    return {
      ...buckets,
      total: {
        units: rows.length,
        valueCents: buckets.ready.valueCents + buckets.drafts.valueCents + buckets.quarantine.valueCents,
        noCostData: buckets.ready.noCostData + buckets.drafts.noCostData + buckets.quarantine.noCostData,
      },
    };
  });

  // ── VIES check ────────────────────────────────────────────────────────────

  app.post("/api/customers/:id/vies-check", guard("customers.vies_check"), async (req, reply) => {
    const { id } = req.params as { id: string };
    const [customer] = await ctx.db.select().from(customers).where(eq(customers.id, id));
    if (!customer) return reply.code(404).send({ error: "not_found" });
    if (!customer.vatNo) return reply.code(422).send({ error: "no_vat_number" });

    let check: ViesCheck;
    try {
      check = await viesLookup(ctx, customer.vatNo);
    } catch (err) {
      return reply.code(502).send({ error: "vies_unreachable", detail: (err as Error).message });
    }
    await ctx.db.update(customers).set({ vies: check }).where(eq(customers.id, id));
    await writeAudit(ctx.db, actor(req), "finance", "vies_checked", customer.vatNo, {
      customerId: id,
      valid: check.valid,
      consult: check.consult,
    });
    return { vies: check };
  });
}
