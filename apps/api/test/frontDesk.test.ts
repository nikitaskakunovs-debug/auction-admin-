import { auditLog, customerFees, orders } from "@auction/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAuction } from "../src/engine/close.js";
import { dispatchNotifications } from "../src/engine/notifications.js";
import { auth, createBidder, createLiveAuction, createWorld, loginAs, type TestWorld } from "./helpers.js";

/**
 * W4 — the counter workstation. The desk answers "what do I do with this
 * person?" in one call, takes money for orders and fees together, and can
 * hand over without the code as an audited exception.
 */
describe("front desk (W4)", () => {
  let world: TestWorld;
  let token: string;

  beforeAll(async () => {
    world = await createWorld();
    token = await loginAs(world, "super@auction.test");
  });
  afterAll(async () => {
    if (world) await world.close();
  });

  /** Win an auction so the bidder has a real awaiting-payment order. */
  async function winFor(alias: string, maxCents: number): Promise<{ bidderId: string; ref: string }> {
    const bidderId = await createBidder(world, alias);
    const { auctionId } = await createLiveAuction(world, token, { startPriceCents: 1_000, endsInMs: 1_000 });
    const bid = await world.server.app.inject({
      method: "POST",
      url: `/api/auctions/${auctionId}/bids`,
      headers: auth(token),
      payload: { customerId: bidderId, maxCents },
    });
    expect(bid.statusCode).toBe(200);
    world.setNow(new Date(Date.now() + 60_000));
    const closed = await closeAuction(world.ctx, auctionId);
    world.setNow(null);
    if (!closed.ok || !closed.orderRef) throw new Error("auction did not close won");
    return { bidderId, ref: closed.orderRef };
  }

  it("finds a person by alias and reports what they owe", async () => {
    const { ref } = await winFor("desk_search", 4_000);
    const res = await world.server.app.inject({
      method: "GET",
      url: "/api/desk/search?q=desk_search",
      headers: auth(token),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      customer: { alias: string };
      awaitingPayment: Array<{ ref: string; totalCents: number }>;
      collectable: unknown[];
      dueCents: number;
    };
    expect(body.customer.alias).toBe("desk_search");
    expect(body.awaitingPayment.map((o) => o.ref)).toContain(ref);
    expect(body.collectable).toHaveLength(0);
    expect(body.dueCents).toBeGreaterThan(0);
  });

  it("finds the same person by order ref", async () => {
    const { ref } = await winFor("desk_by_ref", 3_000);
    const res = await world.server.app.inject({
      method: "GET",
      url: `/api/desk/search?q=${encodeURIComponent(ref)}`,
      headers: auth(token),
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { customer: { alias: string } }).customer.alias).toBe("desk_by_ref");
  });

  it("takes cash for an order and an outstanding fee in one action", async () => {
    const { bidderId, ref } = await winFor("desk_pay", 5_000);
    const [order] = await world.ctx.db.select().from(orders).where(eq(orders.ref, ref));
    // An old restock fee is what pauses the account — the desk clears it too.
    const [fee] = await world.ctx.db
      .insert(customerFees)
      .values({
        customerId: bidderId,
        orderId: order!.id,
        orderRef: ref,
        type: "unpaid_restock",
        amountCents: 1_250,
        status: "outstanding",
      })
      .returning();

    const res = await world.server.app.inject({
      method: "POST",
      url: "/api/desk/pay",
      headers: auth(token),
      payload: { orderIds: [order!.id], feeIds: [fee!.id], method: "cash" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; takenCents: number; paidRefs: string[] };
    expect(body.ok).toBe(true);
    expect(body.paidRefs).toContain(ref);
    expect(body.takenCents).toBe(order!.totalCents + 1_250);

    const [after] = await world.ctx.db.select().from(orders).where(eq(orders.id, order!.id));
    expect(after!.status).toBe("paid");
    const [feeAfter] = await world.ctx.db.select().from(customerFees).where(eq(customerFees.id, fee!.id));
    expect(feeAfter!.status).toBe("settled");
  });

  it("shows a paid order as collectable and prints a receipt", async () => {
    const { ref } = await winFor("desk_collect", 6_000);
    const [order] = await world.ctx.db.select().from(orders).where(eq(orders.ref, ref));
    await world.server.app.inject({
      method: "POST",
      url: "/api/desk/pay",
      headers: auth(token),
      payload: { orderIds: [order!.id], method: "card_terminal" },
    });

    const res = await world.server.app.inject({
      method: "GET",
      url: "/api/desk/search?q=desk_collect",
      headers: auth(token),
    });
    const body = res.json() as { collectable: Array<{ ref: string }>; awaitingPayment: unknown[]; dueCents: number };
    expect(body.collectable.map((o) => o.ref)).toContain(ref);
    expect(body.awaitingPayment).toHaveLength(0);
    expect(body.dueCents).toBe(0);

    const receipt = await world.server.app.inject({
      method: "GET",
      url: `/api/desk/orders/${order!.id}/receipt`,
      headers: auth(token),
    });
    expect(receipt.statusCode).toBe(200);
    expect(receipt.body).toContain(ref);
  });

  it("hands over without the code only with a written reason, and audits it", async () => {
    const { bidderId, ref } = await winFor("desk_override", 7_000);
    const [order] = await world.ctx.db.select().from(orders).where(eq(orders.ref, ref));
    await world.server.app.inject({
      method: "POST",
      url: "/api/desk/pay",
      headers: auth(token),
      payload: { orderIds: [order!.id], method: "cash" },
    });

    const checkin = await world.server.app.inject({
      method: "POST",
      url: "/api/pickup/checkin",
      headers: auth(token),
      payload: { customerId: bidderId },
    });
    expect(checkin.statusCode).toBe(200);
    const ticketId = (checkin.json() as { ticketId: string }).ticketId;

    await world.server.app.inject({ method: "POST", url: `/api/pickup/tickets/${ticketId}/claim`, headers: auth(token) });
    const queue = await world.server.app.inject({ method: "GET", url: "/api/pickup/queue", headers: auth(token) });
    const ticket = (queue.json() as { tickets: Array<{ id: string; lines: Array<{ id: string }> }> }).tickets.find((t) => t.id === ticketId);
    for (const line of ticket!.lines) {
      await world.server.app.inject({
        method: "POST",
        url: `/api/pickup/tickets/${ticketId}/lines/${line.id}`,
        headers: auth(token),
        payload: { status: "picked" },
      });
    }
    await world.server.app.inject({ method: "POST", url: `/api/pickup/tickets/${ticketId}/delivering`, headers: auth(token) });

    // A wrong code is still refused…
    const wrong = await world.server.app.inject({
      method: "POST",
      url: `/api/pickup/tickets/${ticketId}/complete`,
      headers: auth(token),
      payload: { pickupCode: "000000" },
    });
    expect(wrong.statusCode).toBe(403);

    // …but staff may override with a reason.
    const ok = await world.server.app.inject({
      method: "POST",
      url: `/api/pickup/tickets/${ticketId}/complete`,
      headers: auth(token),
      payload: { overrideReason: "Klients uzrādīja pasi, kods pazudis" },
    });
    expect(ok.statusCode).toBe(200);

    const audit = await world.server.app.inject({ method: "GET", url: "/api/audit?type=pickup&limit=50", headers: auth(token) });
    const actions = (audit.json() as { entries: Array<{ action: string; detail: Record<string, unknown> | null }> }).entries;
    const override = actions.find((e) => e.action === "handover_override");
    expect(override, "override is audited").toBeTruthy();
    expect(String(override!.detail?.reason)).toContain("pasi");
  });

  it("pins a person by id, so picking one of several matches actually opens them", async () => {
    const { bidderId } = await winFor("desk_by_id", 4_500);
    // The screen passes the customer's id — when several people match a name,
    // and again when it re-reads someone after an action.
    const res = await world.server.app.inject({
      method: "GET",
      url: `/api/desk/search?q=${bidderId}`,
      headers: auth(token),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { customer?: { id: string; alias: string }; matches: unknown[] };
    expect(body.customer, "an id resolves to that person, not to nobody").toBeTruthy();
    expect(body.customer!.id).toBe(bidderId);
    expect(body.customer!.alias).toBe("desk_by_id");
  });

  it("refuses a handover with neither code nor reason", async () => {
    const res = await world.server.app.inject({
      method: "POST",
      url: `/api/pickup/tickets/${"00000000-0000-0000-0000-000000000000"}/complete`,
      headers: auth(token),
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  /** Win, pay at the counter, and read the order back — the state every one
   * of these checks starts from. */
  async function paidFor(alias: string) {
    const { bidderId, ref } = await winFor(alias, 4_000);
    const [before] = await world.ctx.db.select().from(orders).where(eq(orders.ref, ref));
    const paid = await world.server.app.inject({
      method: "POST", url: "/api/desk/pay", headers: auth(token),
      payload: { orderIds: [before!.id], method: "cash" },
    });
    expect(paid.statusCode).toBe(200);
    const [order] = await world.ctx.db.select().from(orders).where(eq(orders.id, before!.id));
    return { bidderId, orderId: order!.id, order: order! };
  }

  /**
   * N — one box, one card. The person at the counter says a number; the desk
   * should not have to know whether that was a queue ticket, an order, or a
   * collection code. And the code itself is readable, but never quietly.
   */
  describe("one lookup for every number a client says", () => {
    it("finds the client by today's ticket number, and shows the ticket on the card", async () => {
      const { bidderId, orderId, order } = await paidFor("num_talons");

      const checkin = await world.server.app.inject({
        method: "POST", url: "/api/pickup/checkin", headers: auth(token),
        payload: { customerId: bidderId },
      });
      expect(checkin.statusCode).toBe(200);
      const number = (checkin.json() as { number: number }).number;

      for (const typed of [String(number), `#${number}`]) {
        const res = await world.server.app.inject({
          method: "GET", url: `/api/desk/search?q=${encodeURIComponent(typed)}`, headers: auth(token),
        });
        expect(res.statusCode, typed).toBe(200);
        const body = res.json() as {
          customer?: { id: string };
          ticket?: { number: number; status: string } | null;
          collectable?: Array<{ pickupCodeMasked: string | null }>;
        };
        expect(body.customer?.id, `typing ${typed}`).toBe(bidderId);
        expect(body.ticket?.number).toBe(number);
        expect(body.ticket?.status).toBe("waiting");
      }

      // The code travels masked — enough to check what was said, not enough to
      // hand the goods to yourself.
      const byCode = await world.server.app.inject({
        method: "GET", url: `/api/desk/search?q=${order.pickupCode}`, headers: auth(token),
      });
      const card = byCode.json() as { collectable?: Array<{ pickupCodeMasked: string | null }> };
      const masked = card.collectable?.[0]?.pickupCodeMasked;
      expect(masked).toBe(`••${order.pickupCode!.slice(-2)}`);
      expect(JSON.stringify(card)).not.toContain(`"${order.pickupCode}"`);
    });

    it("names the shelf the lot is actually on, not the empty legacy field", async () => {
    const { bidderId, orderId } = await paidFor("num_bin");
    const [order] = await world.ctx.db.select().from(orders).where(eq(orders.id, orderId));

    const bin = await world.server.app.inject({
      method: "POST", url: "/api/warehouse/locations", headers: auth(token),
      payload: { zone: "FRONT", aisle: "A4", rack: "R2", shelf: "S1" },
    });
    const location = (bin.json() as { location: { id: string; label: string } }).location;
    await world.server.app.inject({
      method: "POST", url: `/api/items/${order!.itemId}/putaway`, headers: auth(token),
      payload: { locationId: location.id, reason: "test shelf" },
    });

    const res = await world.server.app.inject({
      method: "GET", url: `/api/desk/search?q=${bidderId}`, headers: auth(token),
    });
    const body = res.json() as { collectable?: Array<{ location: string }> };
    expect(body.collectable?.[0]?.location, "the counter is told where to walk").toBe(location.label);
  });

  it("issues four-digit codes and still accepts the six-digit ones already out there", async () => {
      const { orderId, order } = await paidFor("num_four");
      expect(order.pickupCode, "short enough to say out loud").toMatch(/^\d{4}$/);

      // A code minted before the change is six digits; the kiosk must not
      // suddenly reject a customer holding one.
      await world.ctx.db.update(orders).set({ pickupCode: "654321" }).where(eq(orders.id, orderId));
      const kiosk = await world.server.app.inject({
        method: "POST", url: "/api/public/pickup/checkin", payload: { code: "654321" },
      });
      expect(kiosk.statusCode).toBe(200);
    });

    it("reveals a code only with a reason, and writes down who looked", async () => {
      const { orderId, order } = await paidFor("num_reveal");

      const noReason = await world.server.app.inject({
        method: "POST", url: `/api/desk/orders/${orderId}/reveal-code`, headers: auth(token), payload: {},
      });
      expect(noReason.statusCode, "a reason is the whole point").toBe(400);

      const ok = await world.server.app.inject({
        method: "POST", url: `/api/desk/orders/${orderId}/reveal-code`, headers: auth(token),
        payload: { reason: "klients pazaudējis e-pastu" },
      });
      expect(ok.statusCode).toBe(200);
      expect((ok.json() as { pickupCode: string }).pickupCode).toBe(order.pickupCode);

      const [entry] = await world.ctx.db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.type, "order"), eq(auditLog.action, "pickup_code_revealed"), eq(auditLog.target, order.ref)));
      expect(entry, "the reveal is in the audit trail").toBeTruthy();
      expect(JSON.stringify(entry!.detail), "the record names the reason, not the secret").not.toContain(order.pickupCode!);
    });

    it("tells the client their queue number the moment they check in", async () => {
      const { bidderId } = await paidFor("num_email");
      world.email.sent.length = 0;

      const checkin = await world.server.app.inject({
        method: "POST", url: "/api/pickup/checkin", headers: auth(token),
        payload: { customerId: bidderId },
      });
      const number = (checkin.json() as { number: number }).number;
      await dispatchNotifications(world.ctx);

      // Earlier checks in this file also queued arrivals, so match on the
      // number this test was given rather than on the first one out.
      const mail = world.email.sent.find((m) => m.text.includes("[checked_in]") && m.subject.includes(String(number)));
      expect(mail, "the number reached the person waiting for it").toBeTruthy();
      expect(mail!.subject).toContain(String(number));
      expect(mail!.html!).toContain(String(number));
    });
  });
});
