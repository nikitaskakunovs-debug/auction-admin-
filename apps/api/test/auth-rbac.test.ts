import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auth, createWorld, loginAs, seedTotpCode, type TestWorld } from "./helpers.js";

let world: TestWorld;

beforeAll(async () => {
  world = await createWorld();
});
afterAll(async () => {
  await world.close();
});

type InjectResult = Awaited<ReturnType<TestWorld["server"]["app"]["inject"]>>;

/** Pull the httpOnly refresh cookie value out of a login/refresh response. */
function refreshCookie(res: InjectResult): string {
  const c = res.cookies.find((c) => c.name === "admin_rt");
  if (!c) throw new Error("no refresh cookie set");
  return c.value;
}

describe("authentication", () => {
  it("rejects bad credentials without a second-factor challenge", async () => {
    const res = await world.server.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "ops@auction.test", password: "wrong-password" },
    });
    expect(res.statusCode).toBe(401);
    expect((res.json() as { challengeToken?: string }).challengeToken).toBeUndefined();
  });

  it("password step returns a 2FA challenge, not a session", async () => {
    const res = await world.server.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "finance@auction.test", password: "Admin123!" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { challenge: string; challengeToken: string; accessToken?: string };
    expect(body.challenge).toBe("totp");
    expect(body.challengeToken).toBeTruthy();
    // No session material leaks before the second factor.
    expect(body.accessToken).toBeUndefined();
    expect(res.cookies.find((c) => c.name === "admin_rt")).toBeUndefined();
  });

  it("completing TOTP returns role + permissions and sets an httpOnly cookie", async () => {
    const step1 = await world.server.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "finance@auction.test", password: "Admin123!" },
    });
    const { challengeToken } = step1.json() as { challengeToken: string };
    const step2 = await world.server.app.inject({
      method: "POST",
      url: "/api/auth/login/2fa",
      payload: { challengeToken, code: seedTotpCode(world) },
    });
    expect(step2.statusCode).toBe(200);
    const body = step2.json() as { user: { role: string; permissions: string[] }; accessToken: string; refreshToken?: string };
    expect(body.user.role).toBe("finance");
    expect(body.user.permissions).toContain("invoices.issue");
    expect(body.user.permissions).not.toContain("team.manage");
    expect(body.accessToken).toBeTruthy();
    // The refresh token is delivered ONLY as an httpOnly cookie, never in JSON.
    expect(body.refreshToken).toBeUndefined();
    const cookie = step2.cookies.find((c) => c.name === "admin_rt");
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.sameSite?.toLowerCase()).toBe("strict");
  });

  it("rejects a wrong TOTP code", async () => {
    const step1 = await world.server.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "support@auction.test", password: "Admin123!" },
    });
    const { challengeToken } = step1.json() as { challengeToken: string };
    const bad = await world.server.app.inject({
      method: "POST",
      url: "/api/auth/login/2fa",
      payload: { challengeToken, code: "000000" },
    });
    expect(bad.statusCode).toBe(401);
  });

  it("refresh rotates the cookie and burns the family on reuse (theft detection)", async () => {
    const step1 = await world.server.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "sales@auction.test", password: "Admin123!" },
    });
    const { challengeToken } = step1.json() as { challengeToken: string };
    const login = await world.server.app.inject({
      method: "POST",
      url: "/api/auth/login/2fa",
      payload: { challengeToken, code: seedTotpCode(world) },
    });
    const rt0 = refreshCookie(login);

    const r1 = await world.server.app.inject({ method: "POST", url: "/api/auth/refresh", cookies: { admin_rt: rt0 } });
    expect(r1.statusCode).toBe(200);
    const rt1 = refreshCookie(r1);

    // Replaying the already-rotated rt0 is treated as theft → whole family dies.
    const reuse = await world.server.app.inject({ method: "POST", url: "/api/auth/refresh", cookies: { admin_rt: rt0 } });
    expect(reuse.statusCode).toBe(401);
    // …so even the legitimately-rotated rt1 is now revoked.
    const r3 = await world.server.app.inject({ method: "POST", url: "/api/auth/refresh", cookies: { admin_rt: rt1 } });
    expect(r3.statusCode).toBe(401);
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
