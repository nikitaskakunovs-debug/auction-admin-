import { customerFees, customers, invoices, items, orders } from "@auction/db";
import { and, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { writeAudit } from "../audit.js";
import type { AppContext } from "../context.js";
import { requirePermission, type PermissionService } from "../auth/rbac.js";
import { settleOrderPaid } from "../engine/settlement.js";

/**
 * W4 — the counter workstation ("Lete").
 *
 * The desk's question is never "what is order A-1021?" but "what do I do with
 * this person?", so `GET /api/desk/search` answers with one payload: who they
 * are, what is collectable now, what they still owe, and what blocks them.
 *
 * Permissions follow the approved design: desk work needs `pickup.operate`,
 * anything that touches money additionally needs `orders.mark_paid`.
 */
export function registerFrontDeskRoutes(app: FastifyInstance, ctx: AppContext, perms: PermissionService): void {
  const desk = (p: Parameters<typeof requirePermission>[1]) => ({ preHandler: requirePermission(perms, p) });
  const actor = (req: { admin?: { sub: string; name: string } }) => ({
    id: req.admin?.sub ?? null,
    label: req.admin?.name ?? "Unknown",
  });

  // ── Search ─────────────────────────────────────────────────────────────────

  app.get("/api/desk/search", desk("pickup.operate"), async (req, reply) => {
    const q = String((req.query as { q?: string }).q ?? "").trim();
    if (q.length < 2) return reply.code(400).send({ error: "query_too_short" });
    const like = `%${q}%`;

    // An order ref, a pickup code or the phone given for a parcel identifies
    // the person just as well as a name — the counter types whatever the
    // client happens to have. (Phone lives on the order, not the account.)
    const digits = q.replace(/[\s()-]/g, "");
    const [byOrder] = await ctx.db
      .select({ customerId: orders.customerId })
      .from(orders)
      .where(
        or(
          ilike(orders.ref, q),
          eq(orders.pickupCode, q),
          ...(digits.length >= 5 ? [ilike(orders.recipientPhone, `%${digits}%`)] : []),
        ),
      )
      .limit(1);

    const matches = byOrder
      ? await ctx.db.select().from(customers).where(eq(customers.id, byOrder.customerId)).limit(1)
      : await ctx.db
          .select()
          .from(customers)
          .where(
            and(
              sql`${customers.erasedAt} is null`,
              or(ilike(customers.alias, like), ilike(customers.email, like), ilike(customers.name, like)),
            ),
          )
          .orderBy(customers.alias)
          .limit(8);

    if (matches.length === 0) return { matches: [] as unknown[] };
    // Several people can share a surname — the desk picks from a short list.
    if (matches.length > 1) {
      return {
        matches: matches.map((c) => ({ id: c.id, alias: c.alias, name: c.name, email: c.email, blocked: c.blocked })),
      };
    }

    const customer = matches[0]!;
    const rows = await ctx.db
      .select({ order: orders, itemTitle: items.title, itemSku: items.sku, itemStatus: items.status, location: items.location })
      .from(orders)
      .innerJoin(items, eq(orders.itemId, items.id))
      .where(and(eq(orders.customerId, customer.id), inArray(orders.status, ["paid", "awaiting_payment"])))
      .orderBy(desc(orders.createdAt))
      .limit(50);

    const fees = await ctx.db
      .select()
      .from(customerFees)
      .where(and(eq(customerFees.customerId, customer.id), eq(customerFees.status, "outstanding")));

    const line = (r: (typeof rows)[number]) => ({
      id: r.order.id,
      ref: r.order.ref,
      totalCents: r.order.totalCents,
      status: r.order.status,
      fulfilment: r.order.fulfilment,
      paymentDeadlineAt: r.order.paymentDeadlineAt,
      pickupDeadlineAt: r.order.pickupDeadlineAt,
      itemTitle: r.itemTitle,
      itemSku: r.itemSku,
      location: r.location,
    });

    return {
      matches: [{ id: customer.id, alias: customer.alias, name: customer.name, email: customer.email, blocked: customer.blocked }],
      customer: {
        id: customer.id,
        alias: customer.alias,
        name: customer.name,
        email: customer.email,
        country: customer.country,
        strikes: customer.strikes,
        blocked: customer.blocked,
        blockedReason: customer.blockedReason,
        tags: customer.tags ?? [],
      },
      // Collectable = paid and the item is still on our shelves.
      collectable: rows.filter((r) => r.order.status === "paid" && r.itemStatus === "paid").map(line),
      awaitingPayment: rows.filter((r) => r.order.status === "awaiting_payment").map(line),
      fees: fees.map((f) => ({ id: f.id, amountCents: f.amountCents, type: f.type, orderRef: f.orderRef, note: f.note })),
      dueCents:
        rows.filter((r) => r.order.status === "awaiting_payment").reduce((n, r) => n + r.order.totalCents, 0) +
        fees.reduce((n, f) => n + f.amountCents, 0),
    };
  });

  // ── Take money at the counter ──────────────────────────────────────────────

  const METHODS = ["cash", "card_terminal"] as const;
  const payBody = z.object({
    orderIds: z.array(z.string().uuid()).max(20).default([]),
    feeIds: z.array(z.string().uuid()).max(20).default([]),
    method: z.enum(METHODS),
    note: z.string().max(300).default(""),
  });

  /**
   * Settle any mix of unpaid orders and outstanding fees in one counter
   * action. Cash and card-terminal money moves outside the system, so what
   * matters here is recording *who* took it, how, and how much.
   */
  app.post("/api/desk/pay", desk("orders.mark_paid"), async (req, reply) => {
    const body = payBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body", detail: body.error.flatten() });
    if (body.data.orderIds.length === 0 && body.data.feeIds.length === 0) {
      return reply.code(400).send({ error: "nothing_selected" });
    }

    const paid: string[] = [];
    const failed: Array<{ id: string; reason: string }> = [];
    let takenCents = 0;

    for (const orderId of body.data.orderIds) {
      const result = await settleOrderPaid(ctx, orderId, actor(req), {
        provider: body.data.method === "cash" ? "skaidra nauda" : "kartes terminālis",
        channel: "desk",
        note: body.data.note,
      });
      if (result.outcome === "settled") {
        paid.push(result.order.ref);
        takenCents += result.order.totalCents;
      } else {
        failed.push({ id: orderId, reason: result.outcome });
      }
    }

    const settledFees: string[] = [];
    for (const feeId of body.data.feeIds) {
      const [fee] = await ctx.db
        .update(customerFees)
        .set({
          status: "settled",
          settledById: req.admin!.sub,
          settledAt: ctx.now(),
          note: body.data.note || undefined,
        })
        .where(and(eq(customerFees.id, feeId), eq(customerFees.status, "outstanding")))
        .returning();
      if (!fee) {
        failed.push({ id: feeId, reason: "fee_not_outstanding" });
        continue;
      }
      settledFees.push(fee.id);
      takenCents += fee.amountCents;
      await writeAudit(ctx.db, actor(req), "customer", "fee_settled", fee.orderRef, {
        feeId: fee.id,
        amountCents: fee.amountCents,
        method: body.data.method,
        channel: "desk",
      });
    }

    if (paid.length > 0 || settledFees.length > 0) {
      await writeAudit(ctx.db, actor(req), "order", "desk_payment", paid.join(", ") || "—", {
        method: body.data.method,
        amountCents: takenCents,
        orders: paid.length,
        fees: settledFees.length,
        note: body.data.note,
      });
    }
    return { ok: failed.length === 0, paidRefs: paid, settledFees, takenCents, failed };
  });

  // ── Collection receipt (printable, A6-ish) ─────────────────────────────────

  app.get("/api/desk/orders/:id/receipt", desk("pickup.operate"), async (req, reply) => {
    const { id } = req.params as { id: string };
    const [row] = await ctx.db
      .select({ order: orders, itemTitle: items.title, itemSku: items.sku })
      .from(orders)
      .innerJoin(items, eq(orders.itemId, items.id))
      .where(eq(orders.id, id));
    if (!row) return reply.code(404).send({ error: "not_found" });
    const [invoice] = await ctx.db.select().from(invoices).where(eq(invoices.orderId, id));

    const eur = (c: number) => `€${(c / 100).toFixed(2)}`;
    const esc = (s: string) => s.replace(/[<>&]/g, (ch) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[ch]!);
    const when = ctx.now().toLocaleString("lv-LV");
    return reply.type("text/html; charset=utf-8").send(`<!doctype html>
<html lang="lv"><head><meta charset="utf-8"><title>Kvīts ${esc(row.order.ref)}</title>
<style>
  body { font: 13px/1.5 system-ui, sans-serif; margin: 0; padding: 18px; color: #0a0a0a; }
  .box { max-width: 320px; }
  h1 { font-size: 15px; margin: 0 0 2px; }
  .muted { color: #6b6b68; font-size: 11.5px; }
  table { width: 100%; border-collapse: collapse; margin: 12px 0; }
  td { padding: 3px 0; vertical-align: top; }
  td.r { text-align: right; font-variant-numeric: tabular-nums; }
  .rule { border-top: 1px dashed #bbb; margin: 10px 0; }
  .tot { font-weight: 700; font-size: 14px; }
  .sign { margin-top: 26px; }
  @media print { body { padding: 0; } }
</style></head>
<body onload="window.print()"><div class="box">
  <h1>Izsoli.lv — saņemšanas kvīts</h1>
  <div class="muted">${esc(when)}</div>
  <div class="rule"></div>
  <table>
    <tr><td>Pasūtījums</td><td class="r">${esc(row.order.ref)}</td></tr>
    <tr><td>Klients</td><td class="r">${esc(row.order.customerAlias)}</td></tr>
    <tr><td>Prece</td><td class="r">${esc(row.itemSku)}</td></tr>
    <tr><td colspan="2" class="muted">${esc(row.itemTitle)}</td></tr>
    ${invoice ? `<tr><td>Rēķins</td><td class="r">${esc(invoice.number)}</td></tr>` : ""}
  </table>
  <div class="rule"></div>
  <table>
    <tr class="tot"><td>Kopā apmaksāts</td><td class="r">${eur(row.order.totalCents)}</td></tr>
  </table>
  <div class="rule"></div>
  <div class="muted">Prece izsniegta klientam. Pretenzijas par stāvokli — 14 dienu laikā.</div>
  <div class="sign muted">Izsniedza: _______________</div>
</div></body></html>`);
  });
}
