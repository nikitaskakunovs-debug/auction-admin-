import { invoices, markets, orders, payments } from "@auction/db";
import { and, desc, eq } from "drizzle-orm";
import { writeAudit } from "../audit.js";
import type { AppContext } from "../context.js";
import { issueInvoice } from "./invoices.js";
import type { OmnivaLocation } from "./omniva.js";

/**
 * Fulfilment selection: how the buyer receives the goods. Chosen on the
 * account page BEFORE paying, because the carrier price joins the order
 * total. Switching is allowed any number of times while the order is still
 * awaiting payment and no money has moved; each switch reprices the order,
 * kills any open checkout (its amount is stale), and reissues the invoice
 * as a correction (old number voided, next number issued).
 */

export type FulfilmentMethod = "pickup" | "omniva_pm";

export type SetFulfilmentResult =
  | { ok: true; shippingCents: number; handlingCents: number; totalCents: number }
  | { ok: false; code: "NOT_AWAITING" | "ALREADY_PAID" | "MACHINE_NOT_FOUND" | "SHIPPING_OFF" | "PHONE_REQUIRED" };

export async function setFulfilment(
  ctx: AppContext,
  orderId: string,
  input: {
    method: FulfilmentMethod;
    machineId?: string | undefined;
    recipientName?: string | undefined;
    recipientPhone?: string | undefined;
    actor: { id: string | null; label: string };
  },
): Promise<SetFulfilmentResult> {
  // Resolve the destination machine outside the transaction (may hit the
  // carrier's location list / Redis cache — no network inside the tx).
  let machine: OmnivaLocation | null = null;
  if (input.method === "omniva_pm") {
    if (!ctx.omniva) return { ok: false, code: "SHIPPING_OFF" };
    if (!input.recipientPhone || input.recipientPhone.replace(/\D/g, "").length < 7) {
      return { ok: false, code: "PHONE_REQUIRED" };
    }
    const [order] = await ctx.db.select({ marketCode: orders.marketCode }).from(orders).where(eq(orders.id, orderId));
    if (!order) return { ok: false, code: "NOT_AWAITING" };
    const locations = await listLocationsCached(ctx, order.marketCode);
    machine = locations.find((l) => l.id === input.machineId) ?? null;
    if (!machine) return { ok: false, code: "MACHINE_NOT_FOUND" };
  }

  const result = await ctx.db.transaction(async (tx) => {
    const [order] = await tx.select().from(orders).where(eq(orders.id, orderId)).for("update");
    if (!order || order.status !== "awaiting_payment") return { ok: false as const, code: "NOT_AWAITING" as const };
    // Money must never have moved: a paid attempt (even unsettled) blocks
    // repricing — the poll/callback will settle it at the old total.
    const [paidAttempt] = await tx
      .select({ id: payments.id })
      .from(payments)
      .where(and(eq(payments.orderId, orderId), eq(payments.status, "paid")))
      .limit(1);
    if (paidAttempt) return { ok: false as const, code: "ALREADY_PAID" as const };

    const [market] = await tx.select().from(markets).where(eq(markets.code, order.marketCode));
    const carrier = input.method === "omniva_pm";
    const shippingCents = carrier ? (market?.omnivaPmPriceCents ?? 399) : 0;
    // Packing/handling fee rides along with carrier delivery only.
    const handlingCents = carrier ? (market?.handlingFeeCents ?? 0) : 0;
    // Shipping + handling are VAT-inclusive flat prices on top of the goods
    // total. The 10% buyer premium NEVER applies to either — it was computed
    // on the hammer price at close and is untouched here.
    const goodsTotal = order.totalCents - order.shippingCents - order.handlingCents;
    const totalCents = goodsTotal + shippingCents + handlingCents;

    await tx
      .update(orders)
      .set({
        fulfilment: input.method,
        shippingCents,
        handlingCents,
        totalCents,
        shippingTo:
          input.method === "omniva_pm" && machine
            ? { provider: "omniva", machineId: machine.id, name: machine.name, zip: machine.zip, country: machine.country, address: machine.address }
            : null,
        recipientName: input.method === "omniva_pm" ? (input.recipientName?.trim() || order.customerAlias) : null,
        recipientPhone: input.method === "omniva_pm" ? input.recipientPhone!.trim() : null,
      })
      .where(eq(orders.id, orderId));

    // Any open checkout now carries a stale amount — expire it locally; the
    // pay endpoints refuse to reuse a checkout whose amount mismatches, and
    // the next pay click mints a fresh one at the new total.
    await tx
      .update(payments)
      .set({ status: "expired", updatedAt: ctx.now() })
      .where(and(eq(payments.orderId, orderId), eq(payments.status, "created")));

    // Correction invoice: totals changed after issue (order still unpaid).
    const [activeInvoice] = await tx
      .select({ id: invoices.id })
      .from(invoices)
      .where(and(eq(invoices.orderId, orderId)));
    if (activeInvoice) await issueInvoice(tx, orderId, ctx.now(), { reissue: true });

    await writeAudit(tx, input.actor, "order", "fulfilment_set", order.ref, {
      method: input.method,
      shippingCents,
      handlingCents,
      totalCents,
      machine: machine ? `${machine.name} (${machine.zip})` : null,
    });
    return { ok: true as const, shippingCents, handlingCents, totalCents };
  });
  return result;
}

const LOCATIONS_CACHE_TTL_SEC = 24 * 3600;

/** Country's parcel machines with a daily Redis cache (the public list is
 * ~2MB and Omniva asks integrators not to hammer it). */
export async function listLocationsCached(ctx: AppContext, country: string): Promise<OmnivaLocation[]> {
  if (!ctx.omniva) return [];
  const key = `omniva:locations:${country.toUpperCase()}`;
  try {
    const cached = await ctx.redis.get(key);
    if (cached) return JSON.parse(cached) as OmnivaLocation[];
  } catch {
    // cache miss path below
  }
  const locations = await ctx.omniva.listLocations(country);
  try {
    await ctx.redis.set(key, JSON.stringify(locations), "EX", LOCATIONS_CACHE_TTL_SEC);
  } catch {
    // caching is best-effort
  }
  return locations;
}
