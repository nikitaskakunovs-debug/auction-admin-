import { customers, invoices, orders } from "@auction/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AuctionScheduler } from "../src/engine/scheduler.js";
import { auth, createBidder, createLiveAuction, createWorld, loginAs, type TestWorld } from "./helpers.js";

let world: TestWorld;
let token: string;
let scheduler: AuctionScheduler;

beforeAll(async () => {
  world = await createWorld();
  token = await loginAs(world, "super@auction.test");
  scheduler = new AuctionScheduler(world.ctx);
});
afterAll(async () => {
  await world.close();
});

async function winAuction(opts: { maxCents?: number; bidderExtra?: Record<string, unknown> } = {}) {
  const { auctionId, itemId } = await createLiveAuction(world, token, {
    startPriceCents: 10_000,
    endsInMs: 250,
    antiSnipeSec: 0,
  });
  const buyer = await createBidder(world, `fin_${Math.random().toString(36).slice(2, 8)}`, opts.bidderExtra ?? {});
  const res = await world.server.app.inject({
    method: "POST",
    url: `/api/auctions/${auctionId}/bids`,
    headers: auth(token),
    payload: { customerId: buyer, maxCents: opts.maxCents ?? 10_000 },
  });
  expect(res.statusCode).toBe(200);
  await new Promise((r) => setTimeout(r, 350));
  await scheduler.tick();
  const [order] = await world.ctx.db.select().from(orders).where(eq(orders.auctionId, auctionId));
  return { order: order!, itemId, buyer };
}

describe("invoice issuing", () => {
  it("closing a won auction issues a sequential invoice in the market series", async () => {
    const year = new Date().getUTCFullYear();
    const a = await winAuction();
    const b = await winAuction();

    const [invA] = await world.ctx.db.select().from(invoices).where(eq(invoices.orderId, a.order.id));
    const [invB] = await world.ctx.db.select().from(invoices).where(eq(invoices.orderId, b.order.id));
    expect(invA).toBeDefined();
    expect(invB).toBeDefined();
    expect(invA!.series).toBe(`LV-${year}`);
    expect(invA!.number).toBe(`LV-${year}-00001`);
    expect(invB!.number).toBe(`LV-${year}-00002`);

    const data = invA!.data as { totalCents: number; hammerCents: number; seller: { legalName: string } };
    expect(data.hammerCents).toBe(10_000);
    expect(data.totalCents).toBe(13_310); // €100 + 10% + 21% VAT
    expect(data.seller.legalName).toBe("Skakunov’s SIA");
  });

  it("issue-invoice endpoint is idempotent (409 when one exists)", async () => {
    const { order } = await winAuction();
    const res = await world.server.app.inject({
      method: "POST",
      url: `/api/orders/${order.id}/issue-invoice`,
      headers: auth(token),
    });
    expect(res.statusCode).toBe(409);
  });

  it("finance role can list invoices; listing manager cannot", async () => {
    const fin = await loginAs(world, "finance@auction.test");
    const ok = await world.server.app.inject({ method: "GET", url: "/api/invoices", headers: auth(fin) });
    expect(ok.statusCode).toBe(200);
    expect((ok.json() as { invoices: unknown[] }).invoices.length).toBeGreaterThan(0);

    const lm = await loginAs(world, "listings@auction.test");
    const no = await world.server.app.inject({ method: "GET", url: "/api/invoices", headers: auth(lm) });
    expect(no.statusCode).toBe(403);
  });

  it("renders printable HTML via header auth AND query-token auth", async () => {
    const { order } = await winAuction();
    const [inv] = await world.ctx.db.select().from(invoices).where(eq(invoices.orderId, order.id));

    const viaHeader = await world.server.app.inject({
      method: "GET",
      url: `/api/invoices/${inv!.id}/html`,
      headers: auth(token),
    });
    expect(viaHeader.statusCode).toBe(200);
    expect(viaHeader.headers["content-type"]).toContain("text/html");
    expect(viaHeader.body).toContain(inv!.number);
    expect(viaHeader.body).toContain("€133.10");
    expect(viaHeader.body).toContain("Buyer&#039;s premium".replace("&#039;", "'")); // premium line present

    const fin = await loginAs(world, "finance@auction.test");
    const viaQuery = await world.server.app.inject({
      method: "GET",
      url: `/api/invoices/${inv!.id}/html?token=${encodeURIComponent(fin)}`,
    });
    expect(viaQuery.statusCode).toBe(200);

    const unauth = await world.server.app.inject({ method: "GET", url: `/api/invoices/${inv!.id}/html` });
    expect(unauth.statusCode).toBe(401);

    // A bidder token in ?token= must NOT authenticate an admin endpoint.
    const reg = await world.server.app.inject({
      method: "POST",
      url: "/api/public/auth/register",
      payload: { email: "invoice-peeker@public.test", alias: "peeker", password: "Bidder123!" },
    });
    const bidderToken = (reg.json() as { accessToken: string }).accessToken;
    const viaBidder = await world.server.app.inject({
      method: "GET",
      url: `/api/invoices/${inv!.id}/html?token=${encodeURIComponent(bidderToken)}`,
    });
    expect(viaBidder.statusCode).toBe(401);
  });

  it("reverse-charge buyer (validated EE VAT) gets a 0% invoice with the Art. 196 note", async () => {
    const { order } = await winAuction({
      bidderExtra: {
        country: "EE",
        company: "Tallinn Trade OÜ",
        vatNo: "EE123456789",
        vies: { valid: true, checkedAt: new Date().toISOString(), consult: "WEE1TEST" },
      },
    });
    expect(order.reverseCharge).toBe(true);
    expect(order.vatCents).toBe(0);
    expect(order.totalCents).toBe(11_000);

    const [inv] = await world.ctx.db.select().from(invoices).where(eq(invoices.orderId, order.id));
    const html = await world.server.app.inject({
      method: "GET",
      url: `/api/invoices/${inv!.id}/html`,
      headers: auth(token),
    });
    expect(html.body).toContain("reverse charge");
    expect(html.body).toContain("2006/112/EC");
  });
});

describe("VAT report", () => {
  it("aggregates issued invoices per market with reverse-charge split", async () => {
    await winAuction(); // ensure at least one normal invoice
    const from = new Date(Date.now() - 86_400_000).toISOString();
    const to = new Date(Date.now() + 86_400_000).toISOString();
    const fin = await loginAs(world, "finance@auction.test");
    const res = await world.server.app.inject({
      method: "GET",
      url: `/api/reports/vat?from=${from}&to=${to}`,
      headers: auth(fin),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      basis: string;
      markets: Array<{ marketCode: string; invoiceCount: number; netCents: number; vatCents: number; grossCents: number }>;
    };
    expect(body.basis).toBe("invoices_issued");
    const lv = body.markets.find((m) => m.marketCode === "LV")!;
    expect(lv.invoiceCount).toBeGreaterThan(0);
    // Internal consistency: gross = net + vat for non-RC + RC rows combined.
    expect(lv.grossCents).toBe(lv.netCents + lv.vatCents);
  });

  it("requires finance.view (support gets 403) and a valid range", async () => {
    const support = await loginAs(world, "support@auction.test");
    const no = await world.server.app.inject({
      method: "GET",
      url: "/api/reports/vat?from=2026-01-01&to=2026-02-01",
      headers: auth(support),
    });
    expect(no.statusCode).toBe(403);

    const fin = await loginAs(world, "finance@auction.test");
    const bad = await world.server.app.inject({ method: "GET", url: "/api/reports/vat", headers: auth(fin) });
    expect(bad.statusCode).toBe(400);
  });
});

describe("VIES check endpoint (simulate mode)", () => {
  it("stamps a valid consultation for a well-formed VAT number", async () => {
    const id = await createBidder(world, "vies_ok", { vatNo: "EE123456789", country: "EE" });
    const fin = await loginAs(world, "finance@auction.test");
    const res = await world.server.app.inject({
      method: "POST",
      url: `/api/customers/${id}/vies-check`,
      headers: auth(fin),
    });
    expect(res.statusCode).toBe(200);
    const { vies } = res.json() as { vies: { valid: boolean; consult: string } };
    expect(vies.valid).toBe(true);
    expect(vies.consult).toMatch(/^SIM/);
    const [c] = await world.ctx.db.select().from(customers).where(eq(customers.id, id));
    expect(c!.vies?.valid).toBe(true);
  });

  it("marks malformed numbers invalid, 422 without a VAT number, RBAC enforced", async () => {
    const badFmt = await createBidder(world, "vies_bad", { vatNo: "EE12" });
    const fin = await loginAs(world, "finance@auction.test");
    const res = await world.server.app.inject({
      method: "POST",
      url: `/api/customers/${badFmt}/vies-check`,
      headers: auth(fin),
    });
    expect((res.json() as { vies: { valid: boolean } }).vies.valid).toBe(false);

    const noVat = await createBidder(world, "vies_none");
    const r422 = await world.server.app.inject({
      method: "POST",
      url: `/api/customers/${noVat}/vies-check`,
      headers: auth(fin),
    });
    expect(r422.statusCode).toBe(422);

    const content = await loginAs(world, "content@auction.test");
    const r403 = await world.server.app.inject({
      method: "POST",
      url: `/api/customers/${badFmt}/vies-check`,
      headers: auth(content),
    });
    expect(r403.statusCode).toBe(403);
  });
});
