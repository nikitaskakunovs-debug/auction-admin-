import { base32Decode, totp } from "@auction/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auth, createWorld, loginAs, type TestWorld } from "./helpers.js";

let world: TestWorld;
let superToken: string;

beforeAll(async () => {
  world = await createWorld();
  superToken = await loginAs(world, "super@auction.test");
});
afterAll(async () => {
  await world.close();
});

const app = () => world.server.app;
const codeFor = (secret: string) => totp(base32Decode(secret), Math.floor(world.ctx.now().getTime() / 1000));

async function createAdmin(email: string, password: string) {
  return app().inject({
    method: "POST",
    url: "/api/team",
    headers: auth(superToken),
    payload: { email, name: email.split("@")[0], password, roleId: "operations" },
  });
}

describe("HTTP security headers", () => {
  it("sends helmet hardening headers on API responses", async () => {
    const res = await app().inject({ method: "GET", url: "/api/health" });
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["strict-transport-security"]).toBeDefined();
    // Clickjacking protection (frameguard).
    expect(res.headers["x-frame-options"]).toBeDefined();
    expect(res.headers["referrer-policy"]).toBeDefined();
  });
});

describe("CORS allowlist", () => {
  it("reflects an allowed origin but not an unknown one", async () => {
    const good = await app().inject({ method: "GET", url: "/api/health", headers: { origin: "http://localhost:5173" } });
    expect(good.headers["access-control-allow-origin"]).toBe("http://localhost:5173");

    const evil = await app().inject({ method: "GET", url: "/api/health", headers: { origin: "http://evil.example" } });
    expect(evil.headers["access-control-allow-origin"]).toBeUndefined();
  });
});

describe("brute-force lockout", () => {
  it("locks an account after repeated failures, even once the password is right", async () => {
    const email = "content@auction.test"; // isolated to this test in this file
    for (let i = 0; i < 8; i++) {
      const bad = await app().inject({ method: "POST", url: "/api/auth/login", payload: { email, password: "nope" } });
      expect(bad.statusCode).toBe(401);
    }
    // The correct password is now refused with a lockout, not a challenge.
    const locked = await app().inject({ method: "POST", url: "/api/auth/login", payload: { email, password: "Admin123!" } });
    expect(locked.statusCode).toBe(429);
  });
});

describe("mandatory 2FA enrollment (first login)", () => {
  it("forces enrollment, then requires the code on later logins", async () => {
    const email = "newop@auction.test";
    const created = await createAdmin(email, "Sturdy-Passphrase-7");
    expect(created.statusCode).toBe(200);

    // First login: password is correct but the account must enroll TOTP.
    const step1 = await app().inject({ method: "POST", url: "/api/auth/login", payload: { email, password: "Sturdy-Passphrase-7" } });
    const { challenge, challengeToken } = step1.json() as { challenge: string; challengeToken: string };
    expect(challenge).toBe("enroll");

    const setup = await app().inject({ method: "POST", url: "/api/auth/2fa/setup", payload: { challengeToken } });
    expect(setup.statusCode).toBe(200);
    const { secret } = setup.json() as { secret: string; otpauthUri: string };

    const enable = await app().inject({
      method: "POST",
      url: "/api/auth/2fa/enable",
      payload: { challengeToken, code: codeFor(secret) },
    });
    expect(enable.statusCode).toBe(200);
    const enabled = enable.json() as { recoveryCodes: string[]; accessToken: string };
    expect(enabled.recoveryCodes).toHaveLength(10);
    expect(enabled.accessToken).toBeTruthy(); // enrollment also logs the user in

    // A later login now presents a TOTP challenge and completes with the code.
    const later = await app().inject({ method: "POST", url: "/api/auth/login", payload: { email, password: "Sturdy-Passphrase-7" } });
    const { challenge: c2, challengeToken: t2 } = later.json() as { challenge: string; challengeToken: string };
    expect(c2).toBe("totp");
    const done = await app().inject({ method: "POST", url: "/api/auth/login/2fa", payload: { challengeToken: t2, code: codeFor(secret) } });
    expect(done.statusCode).toBe(200);
  });

  it("lets an enrolled user redeem a one-time recovery code", async () => {
    const email = "recov@auction.test";
    await createAdmin(email, "Another-Good-One-3");
    const s1 = await app().inject({ method: "POST", url: "/api/auth/login", payload: { email, password: "Another-Good-One-3" } });
    const t1 = (s1.json() as { challengeToken: string }).challengeToken;
    const setup = await app().inject({ method: "POST", url: "/api/auth/2fa/setup", payload: { challengeToken: t1 } });
    const secret = (setup.json() as { secret: string }).secret;
    const enable = await app().inject({ method: "POST", url: "/api/auth/2fa/enable", payload: { challengeToken: t1, code: codeFor(secret) } });
    const recovery = (enable.json() as { recoveryCodes: string[] }).recoveryCodes[0]!;

    const login = await app().inject({ method: "POST", url: "/api/auth/login", payload: { email, password: "Another-Good-One-3" } });
    const t2 = (login.json() as { challengeToken: string }).challengeToken;
    const first = await app().inject({ method: "POST", url: "/api/auth/login/2fa", payload: { challengeToken: t2, code: recovery } });
    expect(first.statusCode).toBe(200);
    // The same recovery code cannot be used twice.
    const login2 = await app().inject({ method: "POST", url: "/api/auth/login", payload: { email, password: "Another-Good-One-3" } });
    const t3 = (login2.json() as { challengeToken: string }).challengeToken;
    const second = await app().inject({ method: "POST", url: "/api/auth/login/2fa", payload: { challengeToken: t3, code: recovery } });
    expect(second.statusCode).toBe(401);
  });
});

describe("password policy + change-password", () => {
  it("rejects a weak password when creating an admin", async () => {
    const res = await createAdmin("weakpw@auction.test", "password123");
    expect(res.statusCode).toBe(422);
    expect((res.json() as { error: string }).error).toBe("weak_password");
  });

  it("change-password enforces the policy and revokes other sessions", async () => {
    const email = "changer@auction.test";
    await createAdmin(email, "Initial-Strong-8");
    // Enroll + get a session with a live refresh cookie.
    const s1 = await app().inject({ method: "POST", url: "/api/auth/login", payload: { email, password: "Initial-Strong-8" } });
    const t1 = (s1.json() as { challengeToken: string }).challengeToken;
    const setup = await app().inject({ method: "POST", url: "/api/auth/2fa/setup", payload: { challengeToken: t1 } });
    const secret = (setup.json() as { secret: string }).secret;
    const enable = await app().inject({ method: "POST", url: "/api/auth/2fa/enable", payload: { challengeToken: t1, code: codeFor(secret) } });
    const token = (enable.json() as { accessToken: string }).accessToken;
    const oldCookie = enable.cookies.find((c) => c.name === "admin_rt")!.value;

    // Weak new password is rejected.
    const weak = await app().inject({
      method: "POST",
      url: "/api/auth/change-password",
      headers: auth(token),
      payload: { currentPassword: "Initial-Strong-8", newPassword: "short" },
    });
    expect(weak.statusCode).toBe(422);

    // Strong change succeeds and revokes the pre-change refresh cookie.
    const ok = await app().inject({
      method: "POST",
      url: "/api/auth/change-password",
      headers: auth(token),
      payload: { currentPassword: "Initial-Strong-8", newPassword: "Rotated-Strong-9" },
    });
    expect(ok.statusCode).toBe(200);
    const reuseOld = await app().inject({ method: "POST", url: "/api/auth/refresh", cookies: { admin_rt: oldCookie } });
    expect(reuseOld.statusCode).toBe(401);
  });
});
