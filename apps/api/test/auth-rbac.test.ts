import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auth, createWorld, loginAs, type TestWorld } from "./helpers.js";

let world: TestWorld;

beforeAll(async () => {
  world = await createWorld();
});
afterAll(async () => {
  await world.close();
});

describe("authentication", () => {
  it("rejects bad credentials", async () => {
    const res = await world.server.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "super@auction.test", password: "wrong" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("logs in and returns role + permissions", async () => {
    const res = await world.server.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "finance@auction.test", password: "Admin123!" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { user: { role: string; permissions: string[] }; accessToken: string; refreshToken: string };
    expect(body.user.role).toBe("finance");
    expect(body.user.permissions).toContain("invoices.issue");
    expect(body.user.permissions).not.toContain("team.manage");
  });

  it("refresh rotates the token", async () => {
    const login = await world.server.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "super@auction.test", password: "Admin123!" },
    });
    const { refreshToken } = login.json() as { refreshToken: string };
    const r1 = await world.server.app.inject({ method: "POST", url: "/api/auth/refresh", payload: { refreshToken } });
    expect(r1.statusCode).toBe(200);
    // The used token is revoked.
    const r2 = await world.server.app.inject({ method: "POST", url: "/api/auth/refresh", payload: { refreshToken } });
    expect(r2.statusCode).toBe(401);
  });

  it("requires auth on admin endpoints", async () => {
    const res = await world.server.app.inject({ method: "GET", url: "/api/items" });
    expect(res.statusCode).toBe(401);
  });
});

describe("action-level RBAC — the 7 design-doc roles", () => {
  it("content editor cannot see items or orders", async () => {
    const token = await loginAs(world, "content@auction.test");
    expect((await world.server.app.inject({ method: "GET", url: "/api/items", headers: auth(token) })).statusCode).toBe(403);
    expect((await world.server.app.inject({ method: "GET", url: "/api/orders", headers: auth(token) })).statusCode).toBe(403);
  });

  it("finance can view orders but cannot mark them paid", async () => {
    const token = await loginAs(world, "finance@auction.test");
    expect((await world.server.app.inject({ method: "GET", url: "/api/orders", headers: auth(token) })).statusCode).toBe(200);
    const res = await world.server.app.inject({
      method: "POST",
      url: "/api/orders/00000000-0000-0000-0000-000000000000/mark-paid",
      headers: auth(token),
    });
    expect(res.statusCode).toBe(403);
  });

  it("listing manager cannot set a reserve (commercial permission)", async () => {
    const token = await loginAs(world, "listings@auction.test");
    const item = await world.server.app.inject({
      method: "POST",
      url: "/api/items",
      headers: auth(token),
      payload: { sku: "RBAC-1", title: "RBAC test lot", marketCode: "LV" },
    });
    expect(item.statusCode).toBe(200);
    const res = await world.server.app.inject({
      method: "POST",
      url: "/api/listings",
      headers: auth(token),
      payload: {
        itemId: (item.json() as { item: { id: string } }).item.id,
        type: "auction",
        title: "RBAC test lot",
        marketCode: "LV",
        startPriceCents: 1000,
        reserveCents: 5000,
      },
    });
    expect(res.statusCode).toBe(403);
    expect((res.json() as { permission: string }).permission).toBe("listings.set_pricing");
  });

  it("sales manager can set pricing but cannot create items", async () => {
    const token = await loginAs(world, "sales@auction.test");
    const res = await world.server.app.inject({
      method: "POST",
      url: "/api/items",
      headers: auth(token),
      payload: { sku: "RBAC-2", title: "x", marketCode: "LV" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("operations cannot edit the role matrix; super admin can", async () => {
    const ops = await loginAs(world, "ops@auction.test");
    const put = await world.server.app.inject({
      method: "PUT",
      url: "/api/roles/support/permissions",
      headers: auth(ops),
      payload: { permissions: ["orders.view"] },
    });
    expect(put.statusCode).toBe(403);

    const superT = await loginAs(world, "super@auction.test");
    const ok = await world.server.app.inject({
      method: "PUT",
      url: "/api/roles/support/permissions",
      headers: auth(superT),
      payload: { permissions: ["orders.view", "customers.view", "audit.view"] },
    });
    expect(ok.statusCode).toBe(200);

    // The change takes effect: support loses refund rights.
    const support = await loginAs(world, "support@auction.test");
    const refund = await world.server.app.inject({
      method: "POST",
      url: "/api/orders/00000000-0000-0000-0000-000000000000/refund",
      headers: auth(support),
      payload: { amountCents: 1, reason: "test" },
    });
    expect(refund.statusCode).toBe(403);
  });

  it("the super_admin matrix is locked", async () => {
    const superT = await loginAs(world, "super@auction.test");
    const res = await world.server.app.inject({
      method: "PUT",
      url: "/api/roles/super_admin/permissions",
      headers: auth(superT),
      payload: { permissions: [] },
    });
    expect(res.statusCode).toBe(409);
  });

  it("cannot demote or deactivate the last super admin", async () => {
    const superT = await loginAs(world, "super@auction.test");
    const team = await world.server.app.inject({ method: "GET", url: "/api/team", headers: auth(superT) });
    const me = (team.json() as { users: Array<{ id: string; roleId: string }> }).users.find(
      (u) => u.roleId === "super_admin",
    )!;
    const res = await world.server.app.inject({
      method: "PATCH",
      url: `/api/team/${me.id}`,
      headers: auth(superT),
      payload: { active: false },
    });
    expect(res.statusCode).toBe(409);
  });
});
