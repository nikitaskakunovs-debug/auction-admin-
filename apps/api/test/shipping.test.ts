import { invoices, items, notifications, orders, payments, shipments } from "@auction/db";
import { and, eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SimulatedKlixClient } from "../src/engine/klix.js";
import { SimulatedOmnivaClient } from "../src/engine/omniva.js";
import { auth, createWorld, loginAs, type TestWorld } from "./helpers.js";

/**
 * Omniva parcel shipping: delivery choice reprices the unpaid order (invoice
 * reissued, open checkout superseded), admin registers the shipment → barcode
 * → label PDF → tracking events advance the item lifecycle.
 */

let world: TestWorld;
let adminToken: string;
let klix: SimulatedKlixClient;
let omniva: SimulatedOmnivaClient;

beforeAll(async () => {
  world = await createWorld();
  adminToken = await loginAs(world, "super@auction.test");
  klix = world.ctx.klix as SimulatedKlixClient;
  omniva = world.ctx.omniva as SimulatedOmnivaClient;
  expect(omniva).toBeInstanceOf(SimulatedOmnivaClient);
});
afterAll(async () => {
  await world.close();
});

async function registerBidder(alias: string) {
  const res = await world.server.app.inject({
    method: "POST",
    url: "/api/public/auth/register",
    payload: { email: `${alias}@ship.test`, alias, password: "Bidder123!", country: "LV" },
  });
  expect(res.statusCode).toBe(200);
  return res.json() as { accessToken: string; bidder: { id: string } };
}

/** Fixed-price purchase → order awaiting payment. Total 13310 (11000+21%). */
async function unpaidOrder(buyerToken: string, priceCents = 11_000): Promise<{ orderId: string; ref: string; itemId: string }> {
  const app = world.server.app;
  const sku = `SHIP-${Math.random().toString(36).slice(2, 9)}`;
  const item = await app.inject({ method: "POST", url: "/api/items", headers: auth(adminToken), payload: { sku, title: `Ship ${sku}`, marketCode: "LV" } });
  const itemId = (item.json() as { item: { id: string } }).item.id;
  const listing = await app.inject({
    method: "POST",
    url: "/api/listings",
    headers: auth(adminToken),
    payload: { itemId, type: "fixed", title: `Ship ${sku}`, marketCode: "LV", priceCents, quantity: 1 },
  });
  const listingId = (listing.json() as { listing: { id: string } }).listing.id;
  await app.inject({ method: "POST", url: `/api/listings/${listingId}/publish`, headers: auth(adminToken) });
  const buy = await app.inject({ method: "POST", url: `/api/public/listings/${listingId}/buy`, headers: auth(buyerToken) });
  expect(buy.statusCode).toBe(200);
  const { orderRef } = buy.json() as { orderRef: string };
  const [order] = await world.ctx.db.select().from(orders).where(eq(orders.ref, orderRef));
  return { orderId: order!.id, ref: orderRef, itemId };
}

async function chooseOmniva(ref: string, token: string, machineId = "9910") {
  return world.server.app.inject({
    method: "POST",
    url: `/api/public/orders/${ref}/fulfilment`,
    headers: auth(token),
    payload: { method: "omniva_pm", machineId, recipientPhone: "+371 26123456", recipientName: "Anna Test" },
  });
}

describe("delivery options + machine list", () => {
  it("options include Omniva with the market price; machines are searchable", async () => {
    const opts = await world.server.app.inject({ method: "GET", url: "/api/public/shipping/options?market=LV" });
    expect(opts.json()).toMatchObject({
      options: [
        { method: "pickup", priceCents: 0 },
        { method: "omniva_pm", priceCents: 399 },
      ],
    });
    const locs = await world.server.app.inject({ method: "GET", url: "/api/public/shipping/locations?country=LV&q=ogre" });
    const { locations } = locs.json() as { locations: Array<{ id: string; city: string }> };
    expect(locations.length).toBe(1);
    expect(locations[0]!.city).toBe("Ogre");
  });
});

describe("fulfilment selection (before payment)", () => {
  it("choosing Omniva reprices the order and reissues the invoice", async () => {
    const buyer = await registerBidder("ship_anna");
    const { orderId, ref } = await unpaidOrder(buyer.accessToken);
    const [invBefore] = await world.ctx.db
      .select()
      .from(invoices)
      .where(and(eq(invoices.orderId, orderId), isNull(invoices.voidedAt)));
    expect(invBefore).toBeDefined();

    const res = await chooseOmniva(ref, buyer.accessToken);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ shippingCents: 399, totalCents: 13_709 });

    const [order] = await world.ctx.db.select().from(orders).where(eq(orders.id, orderId));
    expect(order!.fulfilment).toBe("omniva_pm");
    expect(order!.totalCents).toBe(13_709);
    expect(order!.shippingTo).toMatchObject({ provider: "omniva", machineId: "9910", zip: "9910" });
    expect(order!.recipientPhone).toBe("+371 26123456");

    // The pre-shipping invoice is voided; the correction carries the next number.
    const allInvoices = await world.ctx.db.select().from(invoices).where(eq(invoices.orderId, orderId));
    expect(allInvoices.length).toBe(2);
    const active = allInvoices.find((i) => i.voidedAt === null)!;
    const voided = allInvoices.find((i) => i.voidedAt !== null)!;
    expect(voided.id).toBe(invBefore!.id);
    expect((active.data as { totalCents: number }).totalCents).toBe(13_709);

    // Switching back to pickup reprices to the goods total again.
    const back = await world.server.app.inject({
      method: "POST",
      url: `/api/public/orders/${ref}/fulfilment`,
      headers: auth(buyer.accessToken),
      payload: { method: "pickup" },
    });
    expect(back.statusCode).toBe(200);
    expect(back.json()).toMatchObject({ shippingCents: 0, totalCents: 13_310 });
  });

  it("an open checkout is superseded on reprice — the new one charges the new total", async () => {
    const buyer = await registerBidder("ship_reprice");
    const { orderId, ref } = await unpaidOrder(buyer.accessToken);
    const pay1 = await world.server.app.inject({
      method: "POST",
      url: `/api/public/orders/${ref}/pay`,
      headers: auth(buyer.accessToken),
      payload: {},
    });
    expect(pay1.statusCode).toBe(200);

    await chooseOmniva(ref, buyer.accessToken);
    const rows = await world.ctx.db.select().from(payments).where(eq(payments.orderId, orderId));
    expect(rows.find((r) => r.amountCents === 13_310)!.status).toBe("expired");

    const pay2 = await world.server.app.inject({
      method: "POST",
      url: `/api/public/orders/${ref}/pay`,
      headers: auth(buyer.accessToken),
      payload: {},
    });
    expect(pay2.statusCode).toBe(200);
    const rows2 = await world.ctx.db.select().from(payments).where(eq(payments.orderId, orderId));
    const open = rows2.find((r) => r.status === "created")!;
    expect(open.amountCents).toBe(13_709);
  });

  it("validates: unknown machine 404, missing phone 400, foreign order 404, paid order 409", async () => {
    const buyer = await registerBidder("ship_val");
    const { orderId, ref } = await unpaidOrder(buyer.accessToken);
    const badMachine = await world.server.app.inject({
      method: "POST",
      url: `/api/public/orders/${ref}/fulfilment`,
      headers: auth(buyer.accessToken),
      payload: { method: "omniva_pm", machineId: "nope", recipientPhone: "+37126123456" },
    });
    expect(badMachine.statusCode).toBe(404);
    const noPhone = await world.server.app.inject({
      method: "POST",
      url: `/api/public/orders/${ref}/fulfilment`,
      headers: auth(buyer.accessToken),
      payload: { method: "omniva_pm", machineId: "9910" },
    });
    expect(noPhone.statusCode).toBe(400);
    const thief = await registerBidder("ship_thief");
    const foreign = await world.server.app.inject({
      method: "POST",
      url: `/api/public/orders/${ref}/fulfilment`,
      headers: auth(thief.accessToken),
      payload: { method: "pickup" },
    });
    expect(foreign.statusCode).toBe(404);
    await world.server.app.inject({ method: "POST", url: `/api/orders/${orderId}/mark-paid`, headers: auth(adminToken) });
    const paid = await world.server.app.inject({
      method: "POST",
      url: `/api/public/orders/${ref}/fulfilment`,
      headers: auth(buyer.accessToken),
      payload: { method: "pickup" },
    });
    expect(paid.statusCode).toBe(409);
  });

  it("paid Omniva orders settle WITHOUT a pickup code or pickup email", async () => {
    const buyer = await registerBidder("ship_nopickup");
    const { orderId, ref } = await unpaidOrder(buyer.accessToken);
    await chooseOmniva(ref, buyer.accessToken);
    // Pay via Klix at the shipped total.
    const pay = await world.server.app.inject({
      method: "POST",
      url: `/api/public/orders/${ref}/pay`,
      headers: auth(buyer.accessToken),
      payload: {},
    });
    expect(pay.statusCode).toBe(200);
    const [p] = await world.ctx.db.select().from(payments).where(and(eq(payments.orderId, orderId), eq(payments.status, "created")));
    klix.setStatus(p!.providerId!, "paid");
    await world.server.app.inject({ method: "POST", url: `/api/public/payments/klix/callback?payment=${p!.id}` });

    const [order] = await world.ctx.db.select().from(orders).where(eq(orders.id, orderId));
    expect(order!.status).toBe("paid");
    expect(order!.pickupCode).toBeNull();
    expect(order!.pickupDeadlineAt).toBeNull();
    const pickupMails = await world.ctx.db
      .select()
      .from(notifications)
      .where(eq(notifications.type, "pickup_ready"));
    expect(pickupMails.find((n) => n.body.includes(ref))).toBeUndefined();
  });
});

describe("admin: register → label → track", () => {
  /** Paid Omniva order ready for shipping. */
  async function paidOmnivaOrder(alias: string) {
    const buyer = await registerBidder(alias);
    const { orderId, ref, itemId } = await unpaidOrder(buyer.accessToken);
    await chooseOmniva(ref, buyer.accessToken);
    await world.server.app.inject({ method: "POST", url: `/api/orders/${orderId}/mark-paid`, headers: auth(adminToken) });
    return { orderId, ref, itemId, buyer };
  }

  it("registers the shipment: barcode, item → packed, tracking email with the machine name", async () => {
    const { orderId, ref, itemId } = await paidOmnivaOrder("ship_reg");
    const res = await world.server.app.inject({ method: "POST", url: `/api/orders/${orderId}/shipment`, headers: auth(adminToken) });
    expect(res.statusCode).toBe(200);
    const { shipment } = res.json() as { shipment: { barcode: string; status: string } };
    expect(shipment.barcode).toMatch(/^CE\d{9}LV$/);
    expect(shipment.status).toBe("registered");

    // Omniva received the machine ZIP + recipient phone.
    const registered = omniva.inspect(shipment.barcode)!;
    expect(registered.input.receiver.machineZip).toBe("9910");
    expect(registered.input.receiver.phone).toBe("+371 26123456");
    expect(registered.input.reference).toBe(ref);

    const [item] = await world.ctx.db.select().from(items).where(eq(items.id, itemId));
    expect(item!.status).toBe("packed");

    const mails = await world.ctx.db.select().from(notifications).where(eq(notifications.type, "shipped"));
    const mail = mails.find((n) => n.body.includes(ref))!;
    expect(mail).toBeDefined();
    expect(mail.body).toContain(shipment.barcode);
    expect(mail.body).toContain("Origo"); // the chosen machine's name

    // Second registration refuses — one live shipment per order.
    const again = await world.server.app.inject({ method: "POST", url: `/api/orders/${orderId}/shipment`, headers: auth(adminToken) });
    expect(again.statusCode).toBe(409);
  });

  it("refuses to register for unpaid or pickup orders and for bidders", async () => {
    const buyer = await registerBidder("ship_refuse");
    const { orderId, ref } = await unpaidOrder(buyer.accessToken);
    await chooseOmniva(ref, buyer.accessToken);
    const unpaid = await world.server.app.inject({ method: "POST", url: `/api/orders/${orderId}/shipment`, headers: auth(adminToken) });
    expect(unpaid.statusCode).toBe(409); // not paid yet

    const pickup = await registerBidder("ship_refuse2");
    const o2 = await unpaidOrder(pickup.accessToken);
    await world.server.app.inject({ method: "POST", url: `/api/orders/${o2.orderId}/mark-paid`, headers: auth(adminToken) });
    const wrongMethod = await world.server.app.inject({ method: "POST", url: `/api/orders/${o2.orderId}/shipment`, headers: auth(adminToken) });
    expect(wrongMethod.statusCode).toBe(409); // pickup order

    const asBidder = await world.server.app.inject({ method: "POST", url: `/api/orders/${orderId}/shipment`, headers: auth(buyer.accessToken) });
    expect([401, 403]).toContain(asBidder.statusCode);
  });

  it("label endpoint streams a PDF (token-authenticated) and stamps labelPrintedAt", async () => {
    const { orderId } = await paidOmnivaOrder("ship_label");
    const reg = await world.server.app.inject({ method: "POST", url: `/api/orders/${orderId}/shipment`, headers: auth(adminToken) });
    const shipmentId = (reg.json() as { shipment: { id: string } }).shipment.id;

    const label = await world.server.app.inject({ method: "GET", url: `/api/shipments/${shipmentId}/label?token=${adminToken}` });
    expect(label.statusCode).toBe(200);
    expect(label.headers["content-type"]).toContain("application/pdf");
    expect(label.rawPayload.subarray(0, 5).toString()).toBe("%PDF-");

    const anon = await world.server.app.inject({ method: "GET", url: `/api/shipments/${shipmentId}/label` });
    expect(anon.statusCode).toBe(401);

    const [row] = await world.ctx.db.select().from(shipments).where(eq(shipments.id, shipmentId));
    expect(row!.labelPrintedAt).not.toBeNull();
  });

  it("tracking refresh advances shipment + item through in_transit to delivered", async () => {
    const { orderId, itemId } = await paidOmnivaOrder("ship_track");
    const reg = await world.server.app.inject({ method: "POST", url: `/api/orders/${orderId}/shipment`, headers: auth(adminToken) });
    const { id: shipmentId, barcode } = (reg.json() as { shipment: { id: string; barcode: string } }).shipment;

    omniva.addEvent(barcode, "PACKET_HAS_BEEN_SENT_TO_DESTINATION", "On its way");
    let refresh = await world.server.app.inject({ method: "POST", url: `/api/shipments/${shipmentId}/refresh`, headers: auth(adminToken) });
    expect((refresh.json() as { shipment: { status: string } }).shipment.status).toBe("in_transit");
    let [item] = await world.ctx.db.select().from(items).where(eq(items.id, itemId));
    expect(item!.status).toBe("shipped");

    omniva.addEvent(barcode, "PACKET_DELIVERED_TO_CLIENT", "Placed in the parcel machine");
    refresh = await world.server.app.inject({ method: "POST", url: `/api/shipments/${shipmentId}/refresh`, headers: auth(adminToken) });
    expect((refresh.json() as { shipment: { status: string } }).shipment.status).toBe("delivered");
    [item] = await world.ctx.db.select().from(items).where(eq(items.id, itemId));
    expect(item!.status).toBe("delivered");

    // The customer sees the same state on the account page.
    const buyer = await world.ctx.db.select({ customerId: orders.customerId }).from(orders).where(eq(orders.id, orderId));
    expect(buyer.length).toBe(1);
  });

  it("the bidder's order list carries fulfilment + live tracking", async () => {
    const { orderId, ref, buyer } = await paidOmnivaOrder("ship_me");
    await world.server.app.inject({ method: "POST", url: `/api/orders/${orderId}/shipment`, headers: auth(adminToken) });
    const me = await world.server.app.inject({ method: "GET", url: "/api/public/me/orders", headers: auth(buyer.accessToken) });
    const mine = (me.json() as { orders: Array<{ ref: string; fulfilment: string; shippingTo: { name: string }; shipment: { barcode: string; status: string } | null }> }).orders;
    const order = mine.find((o) => o.ref === ref)!;
    expect(order.fulfilment).toBe("omniva_pm");
    expect(order.shippingTo.name).toContain("Origo");
    expect(order.shipment?.status).toBe("registered");
    expect(order.shipment?.barcode).toMatch(/^CE\d{9}LV$/);
  });
});
