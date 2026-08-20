import { customers, items, listings, notifications, orders, pickupTickets, shipments } from "@auction/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createWorld, type TestWorld } from "./helpers.js";

/**
 * Кабинет, вкладки «Brīdinājumi» и «Izņemšana»: лента собственных уведомлений,
 * свои посылки и талон очереди. Всё — только чтение и только своё: чужие
 * строки в ответ попадать не должны.
 */
describe("кабинет: уведомления, посылки, талон", () => {
  let world: TestWorld;
  let token: string;
  let bidderId: string;

  const register = async (email: string) => {
    const res = await world.server.app.inject({
      method: "POST",
      url: "/api/public/auth/register",
      payload: { email, alias: email.split("@")[0]!.replace(/[^a-z0-9]/gi, ""), password: "Bidder123!" },
    });
    expect(res.statusCode).toBe(200);
    return res.json() as { accessToken: string; bidder: { id: string } };
  };

  beforeAll(async () => {
    world = await createWorld();
    const me = await register("portal.me@test.lv");
    token = me.accessToken;
    bidderId = me.bidder.id;
  });
  afterAll(async () => {
    if (world) await world.close();
  });

  it("отдаёт свои уведомления новыми вперёд и не отдаёт чужие", async () => {
    const other = await register("portal.other@test.lv");
    await world.ctx.db.insert(notifications).values([
      { customerId: bidderId, type: "outbid", toEmail: "portal.me@test.lv", subject: "Tevi pārsolīja", body: "Pašreizējā cena 77,00 €\nOtra rinda" },
      { customerId: bidderId, type: "won", toEmail: "portal.me@test.lv", subject: "Apsveicam!", body: "Tu uzvarēji šo lotu" },
      { customerId: other.bidder.id, type: "outbid", toEmail: "portal.other@test.lv", subject: "ČUŽOJE", body: "не должно попасть" },
    ]);

    const res = await world.server.app.inject({
      method: "GET",
      url: "/api/public/me/notifications",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const list = (res.json() as { notifications: Array<{ subject: string; body: string }> }).notifications;
    expect(list.length).toBe(2);
    expect(list.map((n) => n.subject)).not.toContain("ČUŽOJE");
    // Краткий текст — первая непустая строка письма, без остального.
    const outbid = list.find((n) => n.subject === "Tevi pārsolīja")!;
    expect(outbid.body).toBe("Pašreizējā cena 77,00 €");

    const anon = await world.server.app.inject({ method: "GET", url: "/api/public/me/notifications" });
    expect(anon.statusCode).toBe(401);
  });

  it("отдаёт свои посылки с последним событием и талон очереди с местом в ней", async () => {
    // Заказ с посылкой Omniva.
    const [item] = await world.ctx.db
      .insert(items)
      .values({ sku: "PORT-1", title: "Austiņas Sony", marketCode: "LV", status: "paid" })
      .returning({ id: items.id });
    const [listing] = await world.ctx.db
      .insert(listings)
      .values({ itemId: item!.id, type: "fixed", title: "Austiņas Sony", marketCode: "LV", priceCents: 5000, status: "sold" })
      .returning({ id: listings.id });
    const [order] = await world.ctx.db
      .insert(orders)
      .values({
        ref: "A-9901",
        listingId: listing!.id,
        itemId: item!.id,
        customerId: bidderId,
        customerAlias: "portalme",
        customerEmail: "portal.me@test.lv",
        marketCode: "LV",
        hammerCents: 5000,
        premiumCents: 500,
        vatCents: 1155,
        vatRateBp: 2100,
        totalCents: 6655,
        status: "paid",
      })
      .returning({ id: orders.id });
    await world.ctx.db.insert(shipments).values({
      orderId: order!.id,
      provider: "omniva",
      barcode: "CC123456789LV",
      status: "in_transit",
      providerStatus: "PACKET_IN_TRANSIT",
      events: [{ code: "PACKET_IN_TRANSIT", at: "2026-08-19T10:00:00Z", description: "Ceļā uz Rīgu" }],
    });

    const res = await world.server.app.inject({
      method: "GET",
      url: "/api/public/me/shipments",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const ship = (res.json() as { shipments: Array<{ ref: string; provider: string; status: string; lastEvent: { code: string } | null }> }).shipments;
    expect(ship.length).toBe(1);
    expect(ship[0]!.ref).toBe("A-9901");
    expect(ship[0]!.provider).toBe("omniva");
    expect(ship[0]!.lastEvent?.code).toBe("PACKET_IN_TRANSIT");

    // Талон: сегодня, в очереди, перед нами один талон с меньшим номером.
    const dayKey = world.ctx.now().toISOString().slice(0, 10);
    const [otherCustomer] = await world.ctx.db
      .select({ id: customers.id })
      .from(customers)
      .where(eq(customers.email, "portal.other@test.lv"));
    await world.ctx.db.insert(pickupTickets).values([
      { number: 214, dayKey, customerId: bidderId, status: "waiting", checkedInVia: "kiosk" },
      { number: 210, dayKey, customerId: otherCustomer!.id, status: "waiting", checkedInVia: "kiosk" },
    ]);
    const pickup = await world.server.app.inject({
      method: "GET",
      url: "/api/public/me/pickup",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(pickup.statusCode).toBe(200);
    const t = (pickup.json() as { ticket: { number: number; status: string; queueAhead: number } | null }).ticket;
    expect(t).not.toBeNull();
    expect(t!.number).toBe(214);
    expect(t!.queueAhead).toBe(1);
  });
});
