import { bids, customerFees, customers, orders } from "@auction/db";
import { and, desc, eq, ilike, or, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { writeAudit } from "../audit.js";
import type { AppContext } from "../context.js";
import { requirePermission, type PermissionService } from "../auth/rbac.js";

const actor = (req: { admin?: { sub: string; name: string } }) => ({
  id: req.admin?.sub ?? null,
  label: req.admin?.name ?? "Unknown",
});

/** Explicit column projection — never serialize passwordHash to the admin API. */
const customerCols = {
  id: customers.id,
  email: customers.email,
  alias: customers.alias,
  name: customers.name,
  country: customers.country,
  marketCode: customers.marketCode,
  company: customers.company,
  vatNo: customers.vatNo,
  vies: customers.vies,
  strikes: customers.strikes,
  blocked: customers.blocked,
  notes: customers.notes,
  erasedAt: customers.erasedAt,
  createdAt: customers.createdAt,
} as const;

const customerBody = z.object({
  email: z.string().email(),
  alias: z.string().min(2),
  name: z.string().nullable().optional(),
  country: z.string().nullable().optional(),
  marketCode: z.string().length(2).nullable().optional(),
  company: z.string().nullable().optional(),
  vatNo: z.string().nullable().optional(),
  notes: z.string().optional(),
  blocked: z.boolean().optional(),
});

export function registerCustomerRoutes(app: FastifyInstance, ctx: AppContext, perms: PermissionService): void {
  const guard = (p: Parameters<typeof requirePermission>[1]) => ({ preHandler: requirePermission(perms, p) });

  app.get("/api/customers", guard("customers.view"), async (req) => {
    const q = req.query as { q?: string };
    const rows = await ctx.db
      .select(customerCols)
      .from(customers)
      .where(q.q ? or(ilike(customers.alias, `%${q.q}%`), ilike(customers.email, `%${q.q}%`), ilike(customers.name, `%${q.q}%`)) : undefined)
      .orderBy(desc(customers.createdAt))
      .limit(500);
    return { customers: rows };
  });

  app.get("/api/customers/:id", guard("customers.view"), async (req, reply) => {
    const { id } = req.params as { id: string };
    const [row] = await ctx.db.select(customerCols).from(customers).where(eq(customers.id, id));
    if (!row) return reply.code(404).send({ error: "not_found" });
    const orderRows = await ctx.db.select().from(orders).where(eq(orders.customerId, id)).orderBy(desc(orders.createdAt)).limit(100);
    const [bidStats] = await ctx.db
      .select({ total: sql<string>`count(*)`, auctions: sql<string>`count(distinct ${bids.auctionId})` })
      .from(bids)
      .where(eq(bids.customerId, id));
    const feeRows = await ctx.db
      .select()
      .from(customerFees)
      .where(eq(customerFees.customerId, id))
      .orderBy(desc(customerFees.createdAt))
      .limit(100);
    return {
      customer: row,
      orders: orderRows,
      bidStats: { totalBids: Number(bidStats!.total), auctionsBidOn: Number(bidStats!.auctions) },
      fees: feeRows,
      outstandingFeeCents: feeRows.filter((f) => f.status === "outstanding").reduce((s, f) => s + f.amountCents, 0),
    };
  });

  // ── Restock-fee settlement (outstanding fees pause bidding/buying) ────────

  const feeAction = z.object({ note: z.string().max(300).default("") });
  for (const action of ["settle", "waive"] as const) {
    app.post(`/api/customers/:id/fees/:feeId/${action}`, guard("customers.strike"), async (req, reply) => {
      const body = feeAction.safeParse(req.body ?? {});
      if (!body.success) return reply.code(400).send({ error: "invalid_body" });
      if (action === "waive" && body.data.note.trim().length < 3) {
        return reply.code(400).send({ error: "invalid_body", detail: "waiving requires a reason note" });
      }
      const { id, feeId } = req.params as { id: string; feeId: string };
      const [fee] = await ctx.db
        .update(customerFees)
        .set({
          status: action === "settle" ? "settled" : "waived",
          note: body.data.note || undefined,
          settledById: req.admin!.sub,
          settledAt: ctx.now(),
        })
        .where(and(eq(customerFees.id, feeId), eq(customerFees.customerId, id), eq(customerFees.status, "outstanding")))
        .returning();
      if (!fee) return reply.code(409).send({ error: "fee_not_outstanding" });
      await writeAudit(ctx.db, actor(req), "customer", `fee_${action}d`, fee.orderRef, {
        feeId: fee.id,
        amountCents: fee.amountCents,
        note: body.data.note,
      });
      return { fee };
    });
  }

  app.post("/api/customers", guard("customers.edit"), async (req, reply) => {
    const body = customerBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body", detail: body.error.flatten() });
    const [row] = await ctx.db
      .insert(customers)
      .values({ ...body.data, email: body.data.email.toLowerCase() })
      .onConflictDoNothing()
      .returning(customerCols);
    if (!row) return reply.code(409).send({ error: "email_exists" });
    await writeAudit(ctx.db, actor(req), "customer", "created", row.alias);
    return { customer: row };
  });

  app.patch("/api/customers/:id", guard("customers.edit"), async (req, reply) => {
    const body = customerBody.partial().safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body", detail: body.error.flatten() });
    const { id } = req.params as { id: string };
    const [row] = await ctx.db.update(customers).set(body.data).where(eq(customers.id, id)).returning(customerCols);
    if (!row) return reply.code(404).send({ error: "not_found" });
    await writeAudit(ctx.db, actor(req), "customer", "updated", row.alias, { fields: Object.keys(body.data) });
    return { customer: row };
  });

  const strikeSchema = z.object({ reason: z.string().min(3) });
  app.post("/api/customers/:id/strike", guard("customers.strike"), async (req, reply) => {
    const body = strikeSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body", detail: "reason required" });
    const { id } = req.params as { id: string };
    const [row] = await ctx.db
      .update(customers)
      .set({ strikes: sql`${customers.strikes} + 1` })
      .where(eq(customers.id, id))
      .returning(customerCols);
    if (!row) return reply.code(404).send({ error: "not_found" });
    await writeAudit(ctx.db, actor(req), "customer", "strike_added", row.alias, { reason: body.data.reason, strikes: row.strikes });
    return { customer: row };
  });

  /** GDPR erasure — order snapshots survive; the person does not. */
  app.post("/api/customers/:id/erase", guard("customers.erase"), async (req, reply) => {
    const { id } = req.params as { id: string };
    const [row] = await ctx.db
      .update(customers)
      .set({
        name: null,
        company: null,
        vatNo: null,
        vies: null,
        // Revoke storefront access on erasure — the password hash is
        // personal credential material and must not survive a GDPR erase.
        passwordHash: null,
        notes: "",
        email: `erased-${id}@erased.invalid`,
        alias: "erased_user",
        blocked: true,
        erasedAt: ctx.now(),
      })
      .where(eq(customers.id, id))
      .returning({ id: customers.id });
    if (!row) return reply.code(404).send({ error: "not_found" });
    await writeAudit(ctx.db, actor(req), "customer", "gdpr_erased", id);
    return { ok: true };
  });
}
