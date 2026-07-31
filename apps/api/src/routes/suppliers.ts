import { consignments, items, supplierInvoices, supplierPayments, suppliers } from "@auction/db";
import { and, asc, desc, eq, ilike, inArray, lt, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { writeAudit } from "../audit.js";
import { requirePermission, type PermissionService } from "../auth/rbac.js";
import type { AppContext } from "../context.js";

const actor = (req: { admin?: { sub: string; name: string } }) => ({
  id: req.admin?.sub ?? null,
  label: req.admin?.name ?? "Unknown",
});

const DAY_MS = 86_400_000;

/** Invoice states that still owe money — the payables set. */
const OWING = ["unpaid", "partly_paid"];

/** Stored status derived from the payments ledger (never set by the caller). */
const deriveStatus = (amountCents: number, paidCents: number): string =>
  paidCents >= amountCents ? "paid" : paidCents > 0 ? "partly_paid" : "unpaid";

/**
 * Correlated subqueries are hand-qualified with the real table names: drizzle
 * renders sql`` column refs unqualified, so `${supplierInvoices.id}` inside
 * `select … from supplier_payments sp` would bind to sp.id (customers.ts makes
 * the same note about customer_fees).
 */
const paidSql = sql`coalesce((select sum(sp.amount_cents) from supplier_payments sp where sp.invoice_id = supplier_invoices.id), 0)`;
const owingSql = sql`supplier_invoices.status in ('unpaid', 'partly_paid')`;
const outstandingSql = sql`(supplier_invoices.amount_cents - ${paidSql})`;

/** Query strings arrive as "" from the admin's empty filter inputs; zod's
 * defaults only fire for absent keys, so blanks are dropped before parsing. */
const dropEmpty = (query: unknown): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries((query ?? {}) as Record<string, unknown>).filter(([, v]) => v !== "" && v !== undefined),
  );

/** Columns every caller may read. */
const supplierBaseCols = {
  id: suppliers.id,
  name: suppliers.name,
  active: suppliers.active,
  paymentTermsDays: suppliers.paymentTermsDays,
} as const;

/** Contact + commercial detail: finance.view only. Absent (not null) for the
 * rest — the global cost-strip hook knows only the two cost keys, so the
 * gating has to happen in the projection itself. */
const supplierFinanceCols = {
  ...supplierBaseCols,
  regNo: suppliers.regNo,
  vatNo: suppliers.vatNo,
  email: suppliers.email,
  phone: suppliers.phone,
  address: suppliers.address,
  bankAccount: suppliers.bankAccount,
  notes: suppliers.notes,
} as const;

type SupplierFinanceRow = {
  id: string;
  name: string;
  active: boolean;
  paymentTermsDays: number;
  regNo: string;
  vatNo: string;
  email: string;
  phone: string;
  address: string;
  bankAccount: string;
  notes: string;
};

const shapeSupplier = (row: SupplierFinanceRow, finance: boolean): Record<string, unknown> =>
  finance
    ? row
    : { id: row.id, name: row.name, active: row.active, paymentTermsDays: row.paymentTermsDays };

interface InvoiceQueryRow {
  id: string;
  number: string;
  supplierId: string;
  supplierName: string;
  consignmentId: string | null;
  consignmentRef: string | null;
  invoiceDate: Date;
  dueDate: Date;
  amountCents: number;
  paidCents: string;
  status: string;
  note: string;
}

/** One payables row: paid/outstanding folded in, whole days past due. */
function shapeInvoice(r: InvoiceQueryRow, now: Date) {
  const paidCents = Number(r.paidCents);
  const owing = OWING.includes(r.status);
  const late = owing && now.getTime() > r.dueDate.getTime();
  return {
    id: r.id,
    number: r.number,
    supplierId: r.supplierId,
    supplierName: r.supplierName,
    consignmentId: r.consignmentId,
    consignmentRef: r.consignmentRef,
    invoiceDate: r.invoiceDate,
    dueDate: r.dueDate,
    amountCents: r.amountCents,
    paidCents,
    // A cancelled bill owes nothing; a payment can never exceed the amount.
    outstandingCents: owing ? Math.max(0, r.amountCents - paidCents) : 0,
    status: r.status,
    overdueDays: late ? Math.floor((now.getTime() - r.dueDate.getTime()) / DAY_MS) : 0,
    note: r.note,
  };
}

export function registerSupplierRoutes(app: FastifyInstance, ctx: AppContext, perms: PermissionService): void {
  const guard = (p: Parameters<typeof requirePermission>[1]) => ({ preHandler: requirePermission(perms, p) });
  const isFinance = (req: { admin?: { role: string } }): Promise<boolean> =>
    perms.has(req.admin!.role, "finance.view");

  /** The projection used by every route that returns a single enriched bill. */
  const invoiceCols = {
    id: supplierInvoices.id,
    number: supplierInvoices.number,
    supplierId: supplierInvoices.supplierId,
    supplierName: suppliers.name,
    consignmentId: supplierInvoices.consignmentId,
    consignmentRef: consignments.ref,
    invoiceDate: supplierInvoices.invoiceDate,
    dueDate: supplierInvoices.dueDate,
    amountCents: supplierInvoices.amountCents,
    paidCents: sql<string>`${paidSql}`,
    status: supplierInvoices.status,
    note: supplierInvoices.note,
  } as const;

  const loadInvoice = async (id: string): Promise<InvoiceQueryRow | undefined> => {
    const [row] = await ctx.db
      .select(invoiceCols)
      .from(supplierInvoices)
      .innerJoin(suppliers, eq(supplierInvoices.supplierId, suppliers.id))
      .leftJoin(consignments, eq(supplierInvoices.consignmentId, consignments.id))
      .where(eq(supplierInvoices.id, id));
    return row;
  };

  // ── Suppliers ─────────────────────────────────────────────────────────────

  app.get("/api/suppliers", guard("items.view"), async (req) => {
    const q = req.query as { q?: string; active?: string };
    const conds = [];
    const term = (q.q ?? "").trim();
    if (term) conds.push(ilike(suppliers.name, `%${term}%`));
    if (q.active === "true") conds.push(eq(suppliers.active, true));
    else if (q.active === "false") conds.push(eq(suppliers.active, false));
    const where = conds.length ? and(...conds) : undefined;

    // Correlated counts rather than joins: joining deliveries and invoices in
    // one query would fan each supplier out and multiply the money sums.
    const deliveryCount = sql<string>`(select count(*) from consignments c where c.supplier_id = suppliers.id)`;

    if (await isFinance(req)) {
      const now = ctx.now();
      const owedSql = (extra?: ReturnType<typeof sql>) => sql<string>`(select coalesce(sum(
          si.amount_cents - coalesce((select sum(sp.amount_cents) from supplier_payments sp where sp.invoice_id = si.id), 0)
        ), 0)
        from supplier_invoices si
        where si.supplier_id = suppliers.id and si.status in ('unpaid', 'partly_paid')${extra ?? sql``})`;
      const rows = await ctx.db
        .select({
          ...supplierFinanceCols,
          deliveryCount,
          outstandingCents: owedSql(),
          overdueCents: owedSql(sql` and si.due_date < ${now}`),
        })
        .from(suppliers)
        .where(where)
        .orderBy(asc(suppliers.name))
        .limit(500);
      return {
        suppliers: rows.map((r) => ({
          ...r,
          deliveryCount: Number(r.deliveryCount),
          outstandingCents: Number(r.outstandingCents),
          overdueCents: Number(r.overdueCents),
        })),
      };
    }

    const rows = await ctx.db
      .select({ ...supplierBaseCols, deliveryCount })
      .from(suppliers)
      .where(where)
      .orderBy(asc(suppliers.name))
      .limit(500);
    return { suppliers: rows.map((r) => ({ ...r, deliveryCount: Number(r.deliveryCount) })) };
  });

  const supplierBody = z.object({
    name: z.string().min(2).max(160),
    regNo: z.string().max(64).optional(),
    vatNo: z.string().max(64).optional(),
    email: z.string().max(160).optional(),
    phone: z.string().max(64).optional(),
    address: z.string().max(400).optional(),
    notes: z.string().max(2000).optional(),
    /** Commercial — finance.view only (same rule as costCents in receiving). */
    paymentTermsDays: z.number().int().min(0).max(365).optional(),
    bankAccount: z.string().max(64).optional(),
  });

  /** Terms and bank details are money data: refuse them from callers who are
   * not allowed to see money, exactly as receiving.ts refuses costCents. */
  const commercialAllowed = async (
    req: { admin?: { role: string } },
    body: { paymentTermsDays?: number | undefined; bankAccount?: string | undefined },
  ): Promise<boolean> =>
    (body.paymentTermsDays === undefined && body.bankAccount === undefined) || (await isFinance(req));

  app.post("/api/suppliers", guard("warehouse.manage"), async (req, reply) => {
    const body = supplierBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body", detail: body.error.flatten() });
    if (!(await commercialAllowed(req, body.data)))
      return reply.code(403).send({ error: "forbidden", permission: "finance.view" });
    const name = body.data.name.trim();

    const [row] = await ctx.db
      .insert(suppliers)
      .values({ ...body.data, name, createdById: req.admin!.sub })
      .onConflictDoNothing()
      .returning(supplierFinanceCols);
    if (!row) {
      // The unique index is on lower(name) — tell the caller which record won
      // so the UI can jump to it instead of making them search.
      const [existing] = await ctx.db
        .select({ id: suppliers.id })
        .from(suppliers)
        .where(sql`lower(${suppliers.name}) = lower(${name})`);
      return reply.code(409).send({ error: "supplier_exists", supplierId: existing?.id ?? null });
    }
    await writeAudit(ctx.db, actor(req), "finance", "supplier_created", row.name, { supplier: row.name });
    return { supplier: shapeSupplier(row, await isFinance(req)) };
  });

  app.patch("/api/suppliers/:id", guard("warehouse.manage"), async (req, reply) => {
    const body = supplierBody.partial().extend({ active: z.boolean().optional() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body", detail: body.error.flatten() });
    if (!(await commercialAllowed(req, body.data)))
      return reply.code(403).send({ error: "forbidden", permission: "finance.view" });
    const { id } = req.params as { id: string };
    const d = body.data;

    const set: Partial<typeof suppliers.$inferInsert> = { updatedAt: ctx.now() };
    if (d.name !== undefined) set.name = d.name.trim();
    if (d.regNo !== undefined) set.regNo = d.regNo;
    if (d.vatNo !== undefined) set.vatNo = d.vatNo;
    if (d.email !== undefined) set.email = d.email;
    if (d.phone !== undefined) set.phone = d.phone;
    if (d.address !== undefined) set.address = d.address;
    if (d.notes !== undefined) set.notes = d.notes;
    if (d.paymentTermsDays !== undefined) set.paymentTermsDays = d.paymentTermsDays;
    if (d.bankAccount !== undefined) set.bankAccount = d.bankAccount;
    if (d.active !== undefined) set.active = d.active;

    if (set.name !== undefined) {
      const [clash] = await ctx.db
        .select({ id: suppliers.id })
        .from(suppliers)
        .where(and(sql`lower(${suppliers.name}) = lower(${set.name})`, sql`${suppliers.id} <> ${id}`));
      if (clash) return reply.code(409).send({ error: "supplier_exists", supplierId: clash.id });
    }

    const [row] = await ctx.db.update(suppliers).set(set).where(eq(suppliers.id, id)).returning(supplierFinanceCols);
    if (!row) return reply.code(404).send({ error: "not_found" });
    await writeAudit(ctx.db, actor(req), "finance", "supplier_updated", row.name, {
      supplier: row.name,
      fields: Object.keys(d),
    });
    return { supplier: shapeSupplier(row, await isFinance(req)) };
  });

  // ── Supplier invoices (bills we owe) ──────────────────────────────────────

  const invoiceListQuery = z.object({
    status: z.enum(["unpaid", "overdue", "paid", "all"]).default("all"),
    supplierId: z.string().uuid().optional(),
    limit: z.coerce.number().int().min(1).max(500).default(200),
  });

  app.get("/api/supplier-invoices", guard("finance.view"), async (req, reply) => {
    const q = invoiceListQuery.safeParse(dropEmpty(req.query));
    if (!q.success) return reply.code(400).send({ error: "invalid_query", detail: q.error.flatten() });
    const now = ctx.now();

    const conds = [];
    if (q.data.supplierId) conds.push(eq(supplierInvoices.supplierId, q.data.supplierId));
    if (q.data.status === "unpaid") conds.push(inArray(supplierInvoices.status, OWING));
    else if (q.data.status === "overdue")
      conds.push(inArray(supplierInvoices.status, OWING), lt(supplierInvoices.dueDate, now));
    else if (q.data.status === "paid") conds.push(eq(supplierInvoices.status, "paid"));
    const where = conds.length ? and(...conds) : undefined;

    const rows = await ctx.db
      .select(invoiceCols)
      .from(supplierInvoices)
      .innerJoin(suppliers, eq(supplierInvoices.supplierId, suppliers.id))
      .leftJoin(consignments, eq(supplierInvoices.consignmentId, consignments.id))
      .where(where)
      // Payables order: what has to be paid soonest sits at the top.
      .orderBy(asc(supplierInvoices.dueDate), desc(supplierInvoices.createdAt))
      .limit(q.data.limit);

    // Totals cover the whole filtered set, never just the returned page (the
    // profit report makes the same promise), and they follow the same filters
    // the list does — a total that disagrees with the rows beside it reads as
    // a bug.
    const weekEnd = new Date(now.getTime() + 7 * DAY_MS);
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const [agg] = await ctx.db
      .select({
        count: sql<string>`count(*)`,
        outstandingCents: sql<string>`coalesce(sum(case when ${owingSql} then ${outstandingSql} else 0 end), 0)`,
        overdueCents: sql<string>`coalesce(sum(case when ${owingSql} and supplier_invoices.due_date < ${now} then ${outstandingSql} else 0 end), 0)`,
        dueThisWeekCents: sql<string>`coalesce(sum(case when ${owingSql} and supplier_invoices.due_date >= ${now} and supplier_invoices.due_date < ${weekEnd} then ${outstandingSql} else 0 end), 0)`,
        paidThisMonthCents: sql<string>`coalesce(sum((select coalesce(sum(sp.amount_cents), 0) from supplier_payments sp where sp.invoice_id = supplier_invoices.id and sp.paid_at >= ${monthStart})), 0)`,
      })
      .from(supplierInvoices)
      .where(where);

    return {
      invoices: rows.map((r) => shapeInvoice(r, now)),
      totals: {
        outstandingCents: Number(agg!.outstandingCents),
        overdueCents: Number(agg!.overdueCents),
        dueThisWeekCents: Number(agg!.dueThisWeekCents),
        paidThisMonthCents: Number(agg!.paidThisMonthCents),
        count: Number(agg!.count),
      },
    };
  });

  app.get("/api/supplier-invoices/:id", guard("finance.view"), async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = await loadInvoice(id);
    if (!row) return reply.code(404).send({ error: "not_found" });
    const payments = await ctx.db
      .select({
        id: supplierPayments.id,
        amountCents: supplierPayments.amountCents,
        paidAt: supplierPayments.paidAt,
        method: supplierPayments.method,
        note: supplierPayments.note,
        actorLabel: supplierPayments.actorLabel,
      })
      .from(supplierPayments)
      .where(eq(supplierPayments.invoiceId, id))
      .orderBy(desc(supplierPayments.paidAt));

    /**
     * Does the bill match what the warehouse recorded? Only answerable when
     * the invoice is tied to a delivery: the delivery's per-unit costs plus
     * its delivery-level extras. `noCostDataCount` travels with the variance
     * because a variance means nothing if half the units were never priced.
     */
    let reconciliation: { recordedCostCents: number; varianceCents: number; noCostDataCount: number } | null = null;
    if (row.consignmentId) {
      const [con] = await ctx.db
        .select({ extraCostCents: consignments.extraCostCents })
        .from(consignments)
        .where(eq(consignments.id, row.consignmentId));
      const [costs] = await ctx.db
        .select({
          recorded: sql<string>`coalesce(sum(${items.costCents}), 0)`,
          noCostData: sql<string>`count(*) filter (where ${items.costCents} is null)`,
        })
        .from(items)
        .where(eq(items.consignmentId, row.consignmentId));
      const recordedCostCents = Number(costs!.recorded) + (con?.extraCostCents ?? 0);
      reconciliation = {
        recordedCostCents,
        varianceCents: row.amountCents - recordedCostCents,
        noCostDataCount: Number(costs!.noCostData),
      };
    }

    return {
      invoice: shapeInvoice(row, ctx.now()),
      supplier: { id: row.supplierId, name: row.supplierName },
      payments,
      reconciliation,
    };
  });

  const invoiceBody = z.object({
    supplierId: z.string().uuid().optional(),
    consignmentId: z.string().uuid().optional(),
    number: z.string().min(1).max(64),
    invoiceDate: z.coerce.date(),
    dueDate: z.coerce.date().optional(),
    amountCents: z.number().int().min(0).max(1_000_000_000),
    note: z.string().max(2000).optional(),
  });

  app.post("/api/supplier-invoices", guard("finance.view"), async (req, reply) => {
    const body = invoiceBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body", detail: body.error.flatten() });
    const d = body.data;

    // The delivery carries the supplier once it has been linked, so a bill
    // filed against a delivery needs no supplier picker.
    let consignment: { id: string; ref: string; supplierId: string | null } | undefined;
    if (d.consignmentId) {
      [consignment] = await ctx.db
        .select({ id: consignments.id, ref: consignments.ref, supplierId: consignments.supplierId })
        .from(consignments)
        .where(eq(consignments.id, d.consignmentId));
      if (!consignment) return reply.code(404).send({ error: "not_found" });
      if (!d.supplierId && !consignment.supplierId)
        return reply.code(404).send({ error: "consignment_supplier_missing", consignmentId: consignment.id });
    }
    const supplierId = d.supplierId ?? consignment?.supplierId ?? null;
    if (!supplierId) return reply.code(422).send({ error: "supplier_required" });

    const [supplier] = await ctx.db
      .select({ id: suppliers.id, name: suppliers.name, paymentTermsDays: suppliers.paymentTermsDays })
      .from(suppliers)
      .where(eq(suppliers.id, supplierId));
    if (!supplier) return reply.code(404).send({ error: "not_found" });

    // No due date on the paperwork → this supplier's agreed terms.
    const dueDate = d.dueDate ?? new Date(d.invoiceDate.getTime() + supplier.paymentTermsDays * DAY_MS);
    const [created] = await ctx.db
      .insert(supplierInvoices)
      .values({
        supplierId: supplier.id,
        consignmentId: consignment?.id ?? null,
        number: d.number.trim(),
        invoiceDate: d.invoiceDate,
        dueDate,
        amountCents: d.amountCents,
        status: deriveStatus(d.amountCents, 0),
        note: d.note ?? "",
        createdById: req.admin!.sub,
      })
      .returning();
    await writeAudit(ctx.db, actor(req), "finance", "supplier_invoice_created", created!.number, {
      supplier: supplier.name,
      invoice: created!.number,
      consignment: consignment?.ref ?? null,
    });
    return { invoice: shapeInvoice(await loadInvoice(created!.id) as InvoiceQueryRow, ctx.now()) };
  });

  const invoicePatchBody = z.object({
    number: z.string().min(1).max(64).optional(),
    invoiceDate: z.coerce.date().optional(),
    dueDate: z.coerce.date().optional(),
    amountCents: z.number().int().min(0).max(1_000_000_000).optional(),
    note: z.string().max(2000).optional(),
    /** Cancelling is the only status a human sets — the rest is derived. */
    status: z.literal("cancelled").optional(),
  });

  app.patch("/api/supplier-invoices/:id", guard("finance.view"), async (req, reply) => {
    const body = invoicePatchBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body", detail: body.error.flatten() });
    const { id } = req.params as { id: string };
    const d = body.data;

    const result = await ctx.db.transaction(async (tx) => {
      const [inv] = await tx.select().from(supplierInvoices).where(eq(supplierInvoices.id, id)).for("update");
      if (!inv) return "not_found" as const;
      if (d.status === "cancelled" && inv.status !== "unpaid") return "not_unpaid" as const;

      const [sum] = await tx
        .select({ paid: sql<string>`coalesce(sum(${supplierPayments.amountCents}), 0)` })
        .from(supplierPayments)
        .where(eq(supplierPayments.invoiceId, id));
      const paid = Number(sum!.paid);
      const amountCents = d.amountCents ?? inv.amountCents;
      // Correcting a bill downwards below what has already left the bank would
      // make the ledger owe the supplier money — refuse it.
      if (amountCents < paid) return "amount_below_paid" as const;

      const set: Partial<typeof supplierInvoices.$inferInsert> = { updatedAt: ctx.now() };
      if (d.number !== undefined) set.number = d.number.trim();
      if (d.invoiceDate !== undefined) set.invoiceDate = d.invoiceDate;
      if (d.dueDate !== undefined) set.dueDate = d.dueDate;
      if (d.note !== undefined) set.note = d.note;
      if (d.amountCents !== undefined) set.amountCents = d.amountCents;
      // A cancelled bill stays cancelled; anything else follows the ledger.
      if (d.status === "cancelled") set.status = "cancelled";
      else if (inv.status !== "cancelled") set.status = deriveStatus(amountCents, paid);

      const [updated] = await tx
        .update(supplierInvoices)
        .set(set)
        .where(eq(supplierInvoices.id, id))
        .returning({ id: supplierInvoices.id, number: supplierInvoices.number });
      const [supplier] = await tx
        .select({ name: suppliers.name })
        .from(suppliers)
        .where(eq(suppliers.id, inv.supplierId));
      // Audit detail carries identifiers only — the feed is readable with
      // audit.view, which is not permission to read money.
      await writeAudit(
        tx,
        actor(req),
        "finance",
        d.status === "cancelled" ? "supplier_invoice_cancelled" : "supplier_invoice_updated",
        updated!.number,
        { supplier: supplier?.name ?? "", invoice: updated!.number },
      );
      return "ok" as const;
    });
    if (result === "not_found") return reply.code(404).send({ error: "not_found" });
    if (result === "not_unpaid") return reply.code(409).send({ error: "not_unpaid" });
    if (result === "amount_below_paid") return reply.code(422).send({ error: "amount_below_paid" });
    return { invoice: shapeInvoice((await loadInvoice(id)) as InvoiceQueryRow, ctx.now()) };
  });

  // ── Payments against a supplier invoice ──────────────────────────────────

  const paymentBody = z.object({
    amountCents: z.number().int().positive().max(1_000_000_000),
    paidAt: z.coerce.date().optional(),
    method: z.enum(["bank_transfer", "cash", "card", "other"]).default("bank_transfer"),
    note: z.string().max(500).optional(),
  });

  app.post("/api/supplier-invoices/:id/payments", guard("finance.view"), async (req, reply) => {
    const body = paymentBody.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "invalid_body", detail: body.error.flatten() });
    const { id } = req.params as { id: string };
    const d = body.data;

    const result = await ctx.db.transaction(async (tx) => {
      // Row lock: two people settling the same bill at once must not both read
      // the pre-payment balance and both find room for a full payment.
      const [inv] = await tx.select().from(supplierInvoices).where(eq(supplierInvoices.id, id)).for("update");
      if (!inv) return { kind: "not_found" as const };
      if (inv.status === "cancelled") return { kind: "cancelled" as const };
      const [sum] = await tx
        .select({ paid: sql<string>`coalesce(sum(${supplierPayments.amountCents}), 0)` })
        .from(supplierPayments)
        .where(eq(supplierPayments.invoiceId, id));
      const paid = Number(sum!.paid);
      if (paid + d.amountCents > inv.amountCents)
        return { kind: "exceeds" as const, outstandingCents: inv.amountCents - paid };

      const [payment] = await tx
        .insert(supplierPayments)
        .values({
          invoiceId: id,
          amountCents: d.amountCents,
          paidAt: d.paidAt ?? ctx.now(),
          method: d.method,
          note: d.note ?? "",
          actorId: req.admin!.sub,
          actorLabel: req.admin!.name,
        })
        .returning();
      await tx
        .update(supplierInvoices)
        .set({ status: deriveStatus(inv.amountCents, paid + d.amountCents), updatedAt: ctx.now() })
        .where(eq(supplierInvoices.id, id));
      const [supplier] = await tx
        .select({ name: suppliers.name })
        .from(suppliers)
        .where(eq(suppliers.id, inv.supplierId));
      await writeAudit(tx, actor(req), "finance", "supplier_payment_recorded", inv.number, {
        supplier: supplier?.name ?? "",
        invoice: inv.number,
        method: d.method,
      });
      return { kind: "ok" as const, payment: payment! };
    });
    if (result.kind === "not_found") return reply.code(404).send({ error: "not_found" });
    if (result.kind === "cancelled") return reply.code(409).send({ error: "invoice_cancelled" });
    if (result.kind === "exceeds")
      return reply.code(422).send({ error: "exceeds_outstanding", outstandingCents: result.outstandingCents });
    return {
      invoice: shapeInvoice((await loadInvoice(id)) as InvoiceQueryRow, ctx.now()),
      payment: result.payment,
    };
  });

  /** Mistyped a payment? Remove it and let the status fall back. */
  app.delete("/api/supplier-invoices/:id/payments/:paymentId", guard("finance.view"), async (req, reply) => {
    const { id, paymentId } = req.params as { id: string; paymentId: string };
    const result = await ctx.db.transaction(async (tx) => {
      const [inv] = await tx.select().from(supplierInvoices).where(eq(supplierInvoices.id, id)).for("update");
      if (!inv) return "not_found" as const;
      const [gone] = await tx
        .delete(supplierPayments)
        .where(and(eq(supplierPayments.id, paymentId), eq(supplierPayments.invoiceId, id)))
        .returning({ id: supplierPayments.id });
      if (!gone) return "not_found" as const;
      const [sum] = await tx
        .select({ paid: sql<string>`coalesce(sum(${supplierPayments.amountCents}), 0)` })
        .from(supplierPayments)
        .where(eq(supplierPayments.invoiceId, id));
      // A cancelled bill keeps its status — deleting a payment never revives it.
      if (inv.status !== "cancelled")
        await tx
          .update(supplierInvoices)
          .set({ status: deriveStatus(inv.amountCents, Number(sum!.paid)), updatedAt: ctx.now() })
          .where(eq(supplierInvoices.id, id));
      const [supplier] = await tx
        .select({ name: suppliers.name })
        .from(suppliers)
        .where(eq(suppliers.id, inv.supplierId));
      await writeAudit(tx, actor(req), "finance", "supplier_payment_deleted", inv.number, {
        supplier: supplier?.name ?? "",
        invoice: inv.number,
      });
      return "ok" as const;
    });
    if (result === "not_found") return reply.code(404).send({ error: "not_found" });
    return { ok: true, invoice: shapeInvoice((await loadInvoice(id)) as InvoiceQueryRow, ctx.now()) };
  });
}
