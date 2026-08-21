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

export type FulfilmentMethod = "pickup" | "omniva_pm" | "dpd_pm" | "courier" | "freight";

/** Адрес для курьера и негабарита (макеты № 74 и 75). */
export interface StreetAddress {
  name: string;
  address: string;
  city: string;
  zip: string;
  country: string;
  /** Этаж, лифт, ширина проёма — водителю крупногабарита это нужно. */
  accessNote?: string | undefined;
}

export type CarrierId = "omniva" | "dpd";

/** Carrier facts per fulfilment method — one row to add per new carrier. */
export const CARRIERS: Record<"omniva_pm" | "dpd_pm", { id: CarrierId; label: string }> = {
  omniva_pm: { id: "omniva", label: "Omniva" },
  dpd_pm: { id: "dpd", label: "DPD" },
};

export const carrierClient = (ctx: AppContext, id: CarrierId) => (id === "dpd" ? ctx.dpd : ctx.omniva);

/** Курьером везёт DPD; негабарит — отдельный перевозчик по письменной смете,
 *  поэтому цены за него в заказе нет: её выставляет менеджер вручную. */
const isLocker = (m: FulfilmentMethod): m is "omniva_pm" | "dpd_pm" => m === "omniva_pm" || m === "dpd_pm";
const needsAddress = (m: FulfilmentMethod): boolean => m === "courier" || m === "freight";

const carrierPrice = (market: { omnivaPmPriceCents: number; dpdPmPriceCents: number } | undefined, id: CarrierId) =>
  id === "dpd" ? (market?.dpdPmPriceCents ?? 399) : (market?.omnivaPmPriceCents ?? 399);

export type SetFulfilmentResult =
  | { ok: true; shippingCents: number; handlingCents: number; insuranceCents: number; totalCents: number }
  | {
      ok: false;
      code:
        | "NOT_AWAITING"
        | "ALREADY_PAID"
        | "MACHINE_NOT_FOUND"
        | "SHIPPING_OFF"
        | "PHONE_REQUIRED"
        | "ADDRESS_REQUIRED";
    };

export async function setFulfilment(
  ctx: AppContext,
  orderId: string,
  input: {
    method: FulfilmentMethod;
    machineId?: string | undefined;
    recipientName?: string | undefined;
    recipientPhone?: string | undefined;
    /** Улица и город для courier/freight — вместо номера пакомата. */
    address?: StreetAddress | undefined;
    /** Покупатель захотел страховку объявленной ценности (макет № 78). */
    insurance?: boolean | undefined;
    actor: { id: string | null; label: string };
  },
): Promise<SetFulfilmentResult> {
  // Resolve the destination machine outside the transaction (may hit the
  // carrier's location list / Redis cache — no network inside the tx).
  let machine: OmnivaLocation | null = null;
  const carrierId: CarrierId | null = isLocker(input.method)
    ? CARRIERS[input.method].id
    : input.method === "courier"
      ? "dpd"
      : null;
  if (input.method !== "pickup") {
    // Телефон нужен любой доставке: и код пакомата, и звонок курьера.
    if (!input.recipientPhone || input.recipientPhone.replace(/\D/g, "").length < 7) {
      return { ok: false, code: "PHONE_REQUIRED" };
    }
  }
  if (isLocker(input.method)) {
    if (!carrierId || !carrierClient(ctx, carrierId)) return { ok: false, code: "SHIPPING_OFF" };
    const [order] = await ctx.db.select({ marketCode: orders.marketCode }).from(orders).where(eq(orders.id, orderId));
    if (!order) return { ok: false, code: "NOT_AWAITING" };
    const locations = await listLocationsCached(ctx, order.marketCode, carrierId);
    machine = locations.find((l) => l.id === input.machineId) ?? null;
    if (!machine) return { ok: false, code: "MACHINE_NOT_FOUND" };
  }
  if (needsAddress(input.method)) {
    const a = input.address;
    if (!a || !a.address.trim() || !a.city.trim() || !a.zip.trim()) {
      return { ok: false, code: "ADDRESS_REQUIRED" };
    }
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
    // Негабарит считает менеджер письменной сметой — в заказе доставки 0,
    // пока смета не выставлена, поэтому цены здесь нет намеренно.
    const shippingCents = isLocker(input.method)
      ? carrierPrice(market, carrierId!)
      : input.method === "courier"
        ? (market?.courierPriceCents ?? 690)
        : 0;
    // Packing/handling fee rides along with carrier delivery only.
    const handlingCents = input.method === "pickup" ? 0 : (market?.handlingFeeCents ?? 0);
    // Shipping + handling are VAT-inclusive flat prices on top of the goods
    // total. The 10% buyer premium NEVER applies to either — it was computed
    // on the hammer price at close and is untouched here.
    const goodsTotal =
      order.totalCents - order.shippingCents - order.handlingCents - order.insuranceCents;
    // Страховка — процент от товарной части, но не ниже порога рынка.
    const insuranceCents =
      input.insurance && input.method !== "pickup"
        ? Math.max(
            market?.insuranceMinCents ?? 100,
            Math.round((goodsTotal * (market?.insuranceBp ?? 100)) / 10_000),
          )
        : 0;
    const totalCents = goodsTotal + shippingCents + handlingCents + insuranceCents;

    await tx
      .update(orders)
      .set({
        fulfilment: input.method,
        shippingCents,
        handlingCents,
        insuranceCents,
        totalCents,
        shippingTo:
          machine && carrierId
            ? { provider: carrierId, machineId: machine.id, name: machine.name, zip: machine.zip, country: machine.country, address: machine.address }
            : needsAddress(input.method) && input.address
              ? {
                  provider: input.method === "courier" ? "dpd" : "freight",
                  machineId: "",
                  name: input.address.name.trim() || order.customerAlias,
                  zip: input.address.zip.trim(),
                  country: input.address.country.trim() || order.marketCode,
                  address: input.address.address.trim(),
                  city: input.address.city.trim(),
                  ...(input.address.accessNote?.trim() ? { accessNote: input.address.accessNote.trim() } : {}),
                }
              : null,
        recipientName: input.method === "pickup" ? null : (input.recipientName?.trim() || order.customerAlias),
        recipientPhone: input.method === "pickup" ? null : input.recipientPhone!.trim(),
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
      insuranceCents,
      totalCents,
      machine: machine ? `${machine.name} (${machine.zip})` : null,
      address: needsAddress(input.method) && input.address ? `${input.address.address}, ${input.address.city}` : null,
    });
    return { ok: true as const, shippingCents, handlingCents, insuranceCents, totalCents };
  });
  return result;
}

const LOCATIONS_CACHE_TTL_SEC = 24 * 3600;

/** A carrier's machines/lockers for a country with a daily Redis cache (the
 * public lists are large and carriers ask integrators not to hammer them). */
export async function listLocationsCached(ctx: AppContext, country: string, carrier: CarrierId = "omniva"): Promise<OmnivaLocation[]> {
  const client = carrierClient(ctx, carrier);
  if (!client) return [];
  const key = `${carrier}:locations:${country.toUpperCase()}`;
  try {
    const cached = await ctx.redis.get(key);
    if (cached) return JSON.parse(cached) as OmnivaLocation[];
  } catch {
    // cache miss path below
  }
  const locations = await client.listLocations(country);
  try {
    await ctx.redis.set(key, JSON.stringify(locations), "EX", LOCATIONS_CACHE_TTL_SEC);
  } catch {
    // caching is best-effort
  }
  return locations;
}
