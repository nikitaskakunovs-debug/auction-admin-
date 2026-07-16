import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createWorld, seedTotpCode, type TestWorld } from "./helpers.js";

/**
 * Phase 24 auth UX: "trust this device" (skip TOTP on a proven browser) and
 * the forgot-password email flow for admins and customers.
 */

let world: TestWorld;

beforeAll(async () => {
  world = await createWorld();
});
afterAll(async () => {
  await world.close();
});

const app = () => world.server.app;

/** The forgot-password send runs after the response — poll the capture. */
async function waitForEmail(to: string, since: number): Promise<string> {
  for (let i = 0; i < 100; i++) {
    const hit = world.email.sent.slice(since).find((m) => m.to === to && m.text.includes("[password_reset]"));
    if (hit) return hit.text;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`no password_reset email captured for ${to}`);
}

function cookieValue(res: { headers: Record<string, unknown> }, name: string): string | null {
  const raw = res.headers["set-cookie"];
  const all = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
  for (const c of all) {
    const m = new RegExp(`^${name}=([^;]+)`).exec(c);
    if (m) return m[1]!;
  }
  return null;
}

describe("trusted device: skip the TOTP step on a remembered browser", () => {
  const email = "ops@auction.test";
  let trustedCookie: string;

  it("issues a trusted-device cookie when 2FA completes with rememberDevice", async () => {
    const step1 = await app().inject({ method: "POST", url: "/api/auth/login", payload: { email, password: "Admin123!" } });
    expect(step1.statusCode).toBe(200);
    const { challenge, challengeToken } = step1.json() as { challenge: string; challengeToken: string };
    expect(challenge).toBe("totp");

    const step2 = await app().inject({
      method: "POST",
      url: "/api/auth/login/2fa",
      payload: { challengeToken, code: seedTotpCode(world), rememberDevice: true },
    });
    expect(step2.statusCode).toBe(200);
    const td = cookieValue(step2, "admin_td");
    expect(td).toBeTruthy();
    trustedCookie = td!;
  });

  it("signs in with password alone on the trusted browser", async () => {
    const res = await app().inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email, password: "Admin123!" },
      cookies: { admin_td: trustedCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body.accessToken).toBeTruthy(); // full session, no challenge
    expect(body.challenge).toBeUndefined();
  });

  it("still demands the code without the cookie, and for the wrong user with it", async () => {
    const plain = await app().inject({ method: "POST", url: "/api/auth/login", payload: { email, password: "Admin123!" } });
    expect((plain.json() as { challenge?: string }).challenge).toBe("totp");

    // Another admin presenting ops' trusted cookie still gets challenged.
    const cross = await app().inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "sales@auction.test", password: "Admin123!" },
      cookies: { admin_td: trustedCookie },
    });
    expect((cross.json() as { challenge?: string }).challenge).toBe("totp");
  });

  it("a password change revokes the trust", async () => {
    // Sign in on the trusted browser, then change the password.
    const login = await app().inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email, password: "Admin123!" },
      cookies: { admin_td: trustedCookie },
    });
    const token = (login.json() as { accessToken: string }).accessToken;
    const change = await app().inject({
      method: "POST",
      url: "/api/auth/change-password",
      headers: { authorization: `Bearer ${token}` },
      payload: { currentPassword: "Admin123!", newPassword: "Fresh-Horizon-42!" },
    });
    expect(change.statusCode).toBe(200);

    // The old trusted cookie no longer skips the second factor.
    const after = await app().inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email, password: "Fresh-Horizon-42!" },
      cookies: { admin_td: trustedCookie },
    });
    expect((after.json() as { challenge?: string }).challenge).toBe("totp");
  });
});

describe("admin forgot-password", () => {
  const email = "finance@auction.test";

  it("emails a single-use reset link that sets a new password and ends sessions", async () => {
    const mark = world.email.sent.length;
    const req = await app().inject({ method: "POST", url: "/api/auth/forgot-password", payload: { email } });
    expect(req.statusCode).toBe(200);

    const text = await waitForEmail(email, mark);
    const token = /#\/reset\?token=([A-Za-z0-9_-]+)/.exec(text)?.[1];
    expect(token).toBeTruthy();

    // Weak replacement is rejected with the strength detail.
    const weak = await app().inject({
      method: "POST",
      url: "/api/auth/reset-password",
      payload: { token, newPassword: "short" },
    });
    expect(weak.statusCode).toBe(422);

    const ok = await app().inject({
      method: "POST",
      url: "/api/auth/reset-password",
      payload: { token, newPassword: "Quiet-Meadow-77!" },
    });
    expect(ok.statusCode).toBe(200);

    // Old password dead, new password proceeds to the normal 2FA challenge.
    const oldPw = await app().inject({ method: "POST", url: "/api/auth/login", payload: { email, password: "Admin123!" } });
    expect(oldPw.statusCode).toBe(401);
    const newPw = await app().inject({ method: "POST", url: "/api/auth/login", payload: { email, password: "Quiet-Meadow-77!" } });
    expect((newPw.json() as { challenge?: string }).challenge).toBe("totp");

    // The link is single-use.
    const replay = await app().inject({
      method: "POST",
      url: "/api/auth/reset-password",
      payload: { token, newPassword: "Another-Try-88!" },
    });
    expect(replay.statusCode).toBe(401);
  });

  it("answers a flat ok for unknown emails and sends nothing", async () => {
    const mark = world.email.sent.length;
    const res = await app().inject({
      method: "POST",
      url: "/api/auth/forgot-password",
      payload: { email: "ghost@auction.test" },
    });
    expect(res.statusCode).toBe(200);
    await new Promise((r) => setTimeout(r, 150));
    expect(world.email.sent.slice(mark).filter((m) => m.to === "ghost@auction.test")).toHaveLength(0);
  });
});

describe("customer forgot-password", () => {
  const email = "bidder-reset@test.lv";
  let refreshToken: string;

  it("resets the password via the emailed link and revokes live sessions", async () => {
    const reg = await app().inject({
      method: "POST",
      url: "/api/public/auth/register",
      payload: { email, alias: "reset_tester", password: "OriginalPw123", country: "LV" },
    });
    expect(reg.statusCode).toBe(200);
    refreshToken = (reg.json() as { refreshToken: string }).refreshToken;

    const mark = world.email.sent.length;
    const req = await app().inject({ method: "POST", url: "/api/public/auth/forgot-password", payload: { email } });
    expect(req.statusCode).toBe(200);

    const text = await waitForEmail(email, mark);
    const token = /\/reset-password\?token=([A-Za-z0-9_-]+)/.exec(text)?.[1];
    expect(token).toBeTruthy();

    const ok = await app().inject({
      method: "POST",
      url: "/api/public/auth/reset-password",
      payload: { token, newPassword: "BrandNewPw456" },
    });
    expect(ok.statusCode).toBe(200);

    const oldPw = await app().inject({ method: "POST", url: "/api/public/auth/login", payload: { email, password: "OriginalPw123" } });
    expect(oldPw.statusCode).toBe(401);
    const newPw = await app().inject({ method: "POST", url: "/api/public/auth/login", payload: { email, password: "BrandNewPw456" } });
    expect(newPw.statusCode).toBe(200);

    // The session from before the reset is gone.
    const refresh = await app().inject({ method: "POST", url: "/api/public/auth/refresh", payload: { refreshToken } });
    expect(refresh.statusCode).toBe(401);
  });

  it("expires reset links after their TTL", async () => {
    const mark = world.email.sent.length;
    await app().inject({ method: "POST", url: "/api/public/auth/forgot-password", payload: { email } });
    const text = await waitForEmail(email, mark);
    const token = /\/reset-password\?token=([A-Za-z0-9_-]+)/.exec(text)?.[1];

    world.setNow(new Date(Date.now() + 31 * 60 * 1000)); // past the 30-min TTL
    try {
      const res = await app().inject({
        method: "POST",
        url: "/api/public/auth/reset-password",
        payload: { token, newPassword: "TooLatePw789" },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      world.setNow(null);
    }
  });
});
