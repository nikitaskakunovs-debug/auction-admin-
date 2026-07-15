import { randomBytes } from "node:crypto";
import { customers, invoices, orders } from "@auction/db";
import { viesFormatValid, viesParse, type ViesCheck } from "@auction/domain";
import { and, desc, eq, gte, lt, sql } from "drizzle-orm";
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

  app.get("/api/invoices", guard("invoices.view"), async () => {
    const rows = await ctx.db
      .select({ invoice: invoices, orderRef: orders.ref, orderStatus: orders.status, totalCents: orders.totalCents })
      .from(invoices)
      .innerJoin(orders, eq(invoices.orderId, orders.id))
      .orderBy(desc(invoices.issuedAt))
      .limit(500);
    return {
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
