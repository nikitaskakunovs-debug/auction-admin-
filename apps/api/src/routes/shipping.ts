import { items, markets, orders, shipments } from "@auction/db";
import { assertItemTransition, type ItemStatus } from "@auction/domain";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { writeAudit } from "../audit.js";
import type { AppContext } from "../context.js";
import { listLocationsCached, setFulfilment } from "../engine/fulfilment.js";
import { enqueueNotification } from "../engine/notifications.js";
import { OmnivaError, shipmentStatusFromEvents } from "../engine/omniva.js";
import { requirePermission, type PermissionService } from "../auth/rbac.js";

/**
 * Parcel shipping — Omniva parcel machines (DPD next on the same seam).
 *
 * Customer side: choose delivery BEFORE paying (the carrier price joins the
 * order total), pick a machine, leave a phone number for the locker SMS.
 * Admin side: register the shipment at Omniva (→ barcode), print the label
 * PDF, refresh tracking events, watch the parcel move. The item follows its
 * lifecycle: paid → picking → packed at registration, shipped when the
 * carrier first scans it, delivered when it reaches the customer.
 */

export const trackingUrl = (barcode: string): string =>
  `https://www.omniva.lv/track-and-trace/?barcode=${encodeURIComponent(barcode)}`;

const actor = (req: { admin?: { sub: string; name: string } }) => ({
  id: req.admin?.sub ?? null,
  label: req.admin?.name ?? "Unknown",
});

export function registerShippingRoutes(app: FastifyInstance, ctx: AppContext, perms: PermissionService): void {
  const guard = (p: Parameters<typeof requirePermission>[1]) => ({ preHandler: requirePermission(perms, p) });

  const requireBidder = (req: FastifyRequest, reply: FastifyReply): string | null => {
    if (!req.bidder) {
      void reply.code(401).send({ error: "unauthenticated" });
      return null;
    }
    return req.bidder.sub;
  };

  // ── Public: options, machine list, fulfilment selection ──────────────────

  /** Delivery options + prices for a market (pickup is always available). */
  app.get("/api/public/shipping/options", async (req) => {
    const { market } = req.query as { market?: string };
    const code = (market ?? "LV").toUpperCase();
    const [m] = await ctx.db.select().from(markets).where(eq(markets.code, code));
    const options: Array<{ method: string; priceCents: number; handlingCents: number }> = [
      { method: "pickup", priceCents: 0, handlingCents: 0 },
    ];
    if (ctx.omniva) {
      options.push({
        method: "omniva_pm",
        priceCents: m?.omnivaPmPriceCents ?? 399,
        // Packing/handling rides along with carrier delivery; neither is
        // ever part of the 10% buyer premium.
        handlingCents: m?.handlingFeeCents ?? 0,
      });
    }
    return { options };
  });

  /** Parcel machines for a country, filterable: ?country=LV&q=ogre */
  app.get("/api/public/shipping/locations", async (req, reply) => {
    if (!ctx.omniva) return reply.code(503).send({ error: "shipping_unavailable" });
    const { country, q } = req.query as { country?: string; q?: string };
    let locations = await listLocationsCached(ctx, (country ?? "LV").toUpperCase());
    if (q && q.trim().length >= 2) {
      const needle = q.trim().toLowerCase();
      locations = locations.filter(
        (l) => l.name.toLowerCase().includes(needle) || l.city.toLowerCase().includes(needle) || l.county.toLowerCase().includes(needle),
      );
    }
    return { locations: locations.slice(0, 200) };
  });

  const fulfilmentSchema = z.object({
    method: z.enum(["pickup", "omniva_pm"]),
    machineId: z.string().min(1).optional(),
    recipientName: z.string().max(120).optional(),
    recipientPhone: z.string().max(32).optional(),
  });

  /** Choose delivery for the bidder's own unpaid order (repriceable). */
  app.post("/api/public/orders/:ref/fulfilment", async (req, reply) => {
    const bidderId = requireBidder(req, reply);
    if (!bidderId) return;
    const body = fulfilmentSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body", detail: body.error.flatten() });
    const { ref } = req.params as { ref: string };
    const [order] = await ctx.db
      .select({ id: orders.id })
      .from(orders)
      .where(and(eq(orders.ref, ref), eq(orders.customerId, bidderId)));
    if (!order) return reply.code(404).send({ error: "not_found" });
    const result = await setFulfilment(ctx, order.id, {
      ...body.data,
      actor: { id: null, label: "Customer" },
    });
    if (!result.ok) {
      const status = result.code === "MACHINE_NOT_FOUND" ? 404 : result.code === "SHIPPING_OFF" ? 503 : result.code === "PHONE_REQUIRED" ? 400 : 409;
      return reply.code(status).send({ error: result.code.toLowerCase() });
    }
    return result;
  });

  // ── Admin: register, label, tracking ──────────────────────────────────────

  /** Register the parcel at Omniva; item advances paid → picking → packed. */
  app.post("/api/orders/:id/shipment", guard("orders.mark_paid"), async (req, reply) => {
    if (!ctx.omniva) return reply.code(503).send({ error: "shipping_unavailable" });
    const { id } = req.params as { id: string };
    const [row] = await ctx.db
      .select({ order: orders, item: items })
      .from(orders)
      .innerJoin(items, eq(orders.itemId, items.id))
      .where(eq(orders.id, id));
    if (!row) return reply.code(404).send({ error: "not_found" });
    if (row.order.status !== "paid") return reply.code(409).send({ error: "order_not_paid" });
    if (row.order.fulfilment !== "omniva_pm" || !row.order.shippingTo) {
      return reply.code(409).send({ error: "order_not_for_shipping" });
    }
    const [existing] = await ctx.db
      .select()
      .from(shipments)
      .where(and(eq(shipments.orderId, id), inArray(shipments.status, ["registered", "in_transit", "delivered"])))
      .limit(1);
    if (existing) return reply.code(409).send({ error: "shipment_exists", barcode: existing.barcode });

    try {
      const registered = await ctx.omniva.registerShipment({
        reference: row.order.ref,
        receiver: {
          name: row.order.recipientName ?? row.order.customerAlias,
          phone: row.order.recipientPhone ?? "",
          email: row.order.customerEmail,
          machineZip: row.order.shippingTo.zip,
          country: row.order.shippingTo.country,
        },
        sender: ctx.config.shipSender,
        weightGrams: row.item.weightGrams,
        comment: `${row.order.ref} ${row.item.sku}`,
      });
      const [shipment] = await ctx.db.transaction(async (tx) => {
        const inserted = await tx
          .insert(shipments)
          .values({ orderId: id, provider: "omniva", barcode: registered.barcode, status: "registered", raw: registered.raw })
          .returning();
        // paid → picking → packed: the parcel is being prepared for the
        // carrier; "shipped" lands with the first carrier scan.
        assertItemTransition(row.item.status as ItemStatus, "picking");
        assertItemTransition("picking", "packed");
        await tx.update(items).set({ status: "packed", updatedAt: ctx.now() }).where(eq(items.id, row.item.id));
        await enqueueNotification(tx, {
          customerId: row.order.customerId,
          type: "shipped",
          template: {
            alias: "",
            lotTitle: row.item.title,
            orderRef: row.order.ref,
            barcode: registered.barcode,
            machineName: row.order.shippingTo!.name,
            trackingUrl: trackingUrl(registered.barcode),
          },
          dedupeKey: `shipped:${id}`,
        });
        await writeAudit(tx, actor(req), "order", "shipment_registered", row.order.ref, {
          barcode: registered.barcode,
          machine: row.order.shippingTo!.name,
        });
        return inserted;
      });
      return { shipment: shipment! };
    } catch (err) {
      req.log?.error({ err, orderId: id }, "omniva registration failed");
      const status = err instanceof OmnivaError ? 502 : 500;
      return reply.code(status).send({ error: "carrier_error", detail: err instanceof Error ? err.message : "unknown" });
    }
  });

  /** Label PDF for printing — opens in a browser tab (token like invoices). */
  app.get("/api/shipments/:id/label", async (req, reply) => {
    // Same query-token auth pattern as the invoice HTML endpoint: the admin
    // SPA opens this in a new tab where headers can't be set.
    const { token } = req.query as { token?: string };
    const { verifyAccessToken } = await import("../auth/jwt.js");
    const claims = token ? verifyAccessToken(token, ctx.config.jwtSecret, ctx.now().getTime()) : req.admin;
    if (!claims || (claims as { kind?: string }).kind !== "admin") return reply.code(401).send({ error: "unauthenticated" });
    if (!ctx.omniva) return reply.code(503).send({ error: "shipping_unavailable" });
    const { id } = req.params as { id: string };
    const [shipment] = await ctx.db.select().from(shipments).where(eq(shipments.id, id));
    if (!shipment) return reply.code(404).send({ error: "not_found" });
    try {
      const base64 = await ctx.omniva.getLabel(shipment.barcode);
      await ctx.db.update(shipments).set({ labelPrintedAt: ctx.now(), updatedAt: ctx.now() }).where(eq(shipments.id, id));
      return reply
        .header("content-type", "application/pdf")
        .header("content-disposition", `inline; filename="label-${shipment.barcode}.pdf"`)
        .send(Buffer.from(base64, "base64"));
    } catch (err) {
      req.log?.error({ err, shipmentId: id }, "omniva label failed");
      return reply.code(502).send({ error: "carrier_error", detail: err instanceof Error ? err.message : "unknown" });
    }
  });

  /** Pull fresh tracking events from the carrier and update the lifecycle. */
  app.post("/api/shipments/:id/refresh", guard("orders.view"), async (req, reply) => {
    const { id } = req.params as { id: string };
    const [shipment] = await ctx.db.select().from(shipments).where(eq(shipments.id, id));
    if (!shipment) return reply.code(404).send({ error: "not_found" });
    const updated = await refreshShipment(ctx, shipment);
    return { shipment: updated ?? shipment };
  });
}

/**
 * Reconcile one shipment against the carrier: store the event history and
 * advance shipment + item statuses (packed → shipped → delivered). Shared by
 * the admin refresh button and the scheduler's periodic poll.
 */
export async function refreshShipment(
  ctx: AppContext,
  shipment: typeof shipments.$inferSelect,
): Promise<typeof shipments.$inferSelect | null> {
  if (!ctx.omniva) return null;
  const tracked = await ctx.omniva.getEvents(shipment.barcode).catch(() => null);
  if (!tracked) return null;
  const status = shipmentStatusFromEvents(tracked.events);
  const [updated] = await ctx.db
    .update(shipments)
    .set({
      status,
      providerStatus: tracked.events[0]?.code ?? shipment.providerStatus,
      events: tracked.events,
      raw: tracked.raw,
      updatedAt: ctx.now(),
    })
    .where(eq(shipments.id, shipment.id))
    .returning();

  // Item lifecycle follows the parcel — idempotent, single-step transitions.
  if (status === "in_transit" || status === "delivered") {
    const [order] = await ctx.db.select({ itemId: orders.itemId }).from(orders).where(eq(orders.id, shipment.orderId));
    if (order) {
      const [item] = await ctx.db.select({ id: items.id, status: items.status }).from(items).where(eq(items.id, order.itemId));
      if (item) {
        let next: ItemStatus | null = null;
        if (item.status === "packed") next = status === "delivered" ? "shipped" : "shipped";
        if (item.status === "shipped" && status === "delivered") next = "delivered";
        if (next) {
          assertItemTransition(item.status as ItemStatus, next);
          await ctx.db.update(items).set({ status: next, updatedAt: ctx.now() }).where(eq(items.id, item.id));
          // packed jumped straight to a delivered parcel: finish the walk.
          if (next === "shipped" && status === "delivered") {
            assertItemTransition("shipped", "delivered");
            await ctx.db.update(items).set({ status: "delivered", updatedAt: ctx.now() }).where(eq(items.id, item.id));
          }
        }
      }
    }
  }
  return updated ?? null;
}
