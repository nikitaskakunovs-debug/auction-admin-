import { createHash, createHmac } from "node:crypto";
import { customers, notifications } from "@auction/db";
import { desc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auth, createWorld, loginAs, type TestWorld } from "./helpers.js";

/**
 * Соцвход (№ 50, 52–54), удаление аккаунта и выгрузка данных (№ 58).
 * Google/Facebook гоняются в режиме simulate (код `ok:<email>:<sub>`),
 * Telegram — с настоящей подписью HMAC: там сети нет и в бою.
 */

const TG_TOKEN = "123456:test-telegram-token";

describe("соцвход и жизненный цикл аккаунта", () => {
  let world: TestWorld;

  beforeAll(async () => {
    world = await createWorld({
      SOCIAL_MODE: "simulate",
      TELEGRAM_BOT_TOKEN: TG_TOKEN,
      TELEGRAM_BOT_NAME: "izsoli_test_bot",
    });
  });
  afterAll(async () => {
    if (world) await world.close();
  });

  /** Токены из фрагмента ссылки, куда колбэк вернул человека. */
  const tokensFromRedirect = (location: string) => {
    const frag = location.split("#")[1] ?? "";
    const p = new URLSearchParams(frag);
    return { access: p.get("a"), refresh: p.get("r") };
  };

  const me = async (access: string) => {
    const res = await world.server.app.inject({
      method: "GET", url: "/api/public/auth/me", headers: auth(access),
    });
    expect(res.statusCode).toBe(200);
    return (res.json() as { bidder: Record<string, unknown> }).bidder;
  };

  it("/oauth/config говорит, какие провайдеры включены", async () => {
    const res = await world.server.app.inject({ method: "GET", url: "/api/public/auth/oauth/config" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ google: true, facebook: true, telegram: "izsoli_test_bot" });
  });

  it("Google: первый вход создаёт аккаунт, повторный — входит в него же", async () => {
    const cb = "/api/public/auth/oauth/google/callback?code=" + encodeURIComponent("ok:anna@example.com:g-sub-1");
    const first = await world.server.app.inject({ method: "GET", url: cb });
    expect(first.statusCode).toBe(302);
    const t1 = tokensFromRedirect(first.headers.location as string);
    expect(t1.access).toBeTruthy();
    expect(t1.refresh).toBeTruthy();

    const bidder = await me(t1.access!);
    expect(bidder.email).toBe("anna@example.com");
    // Google подтвердил адрес сам — наша проверка закрыта той же меткой.
    expect(bidder.emailVerified).toBe(true);
    expect(bidder.hasPassword).toBe(false);
    expect(bidder.emailPending).toBe(false);

    const second = await world.server.app.inject({ method: "GET", url: cb });
    expect(second.statusCode).toBe(302);
    const t2 = tokensFromRedirect(second.headers.location as string);
    const again = await me(t2.access!);
    expect(again.id).toBe(bidder.id);

    const rows = await world.ctx.db.select().from(customers).where(eq(customers.email, "anna@example.com"));
    expect(rows).toHaveLength(1);
  });

  it("№ 53: адрес уже занят — соцсеть привязывается, дубль не создаётся", async () => {
    const reg = await world.server.app.inject({
      method: "POST", url: "/api/public/auth/register",
      payload: { email: "bob@example.com", alias: "bob", password: "Bidder123!" },
    });
    expect(reg.statusCode).toBe(200);
    const bobId = (reg.json() as { bidder: { id: string } }).bidder.id;

    const cb = "/api/public/auth/oauth/google/callback?code=" + encodeURIComponent("ok:bob@example.com:g-sub-bob");
    const res = await world.server.app.inject({ method: "GET", url: cb });
    expect(res.statusCode).toBe(302);
    const t = tokensFromRedirect(res.headers.location as string);
    const bidder = await me(t.access!);
    expect(bidder.id).toBe(bobId);
    expect(bidder.hasPassword).toBe(true);

    const [row] = await world.ctx.db.select().from(customers).where(eq(customers.id, bobId));
    expect(row!.googleId).toBe("g-sub-bob");
    // Провайдер подтвердил адрес — метка закрыта и у нас.
    expect(row!.emailVerifiedAt).not.toBeNull();
  });

  it("Telegram: настоящая подпись входит, порченая — нет", async () => {
    const fields: Record<string, string> = {
      id: "777001",
      first_name: "Toms",
      username: "toms_lv",
      auth_date: String(Math.floor(world.ctx.now().getTime() / 1000)),
    };
    const checkString = Object.keys(fields).sort().map((k) => `${k}=${fields[k]}`).join("\n");
    const secret = createHash("sha256").update(TG_TOKEN).digest();
    const hash = createHmac("sha256", secret).update(checkString).digest("hex");

    const qs = new URLSearchParams({ ...fields, hash }).toString();
    const res = await world.server.app.inject({ method: "GET", url: `/api/public/auth/oauth/telegram/callback?${qs}` });
    expect(res.statusCode).toBe(302);
    const t = tokensFromRedirect(res.headers.location as string);
    expect(t.access).toBeTruthy();

    // Адреса Telegram не даёт: стоит служебный, кабинет просит «Pabeidz profilu».
    const bidder = await me(t.access!);
    expect(bidder.email).toBe("tg777001@nav.izsoli.lv");
    expect(bidder.emailPending).toBe(true);
    expect(bidder.emailVerified).toBe(false);
    expect(bidder.hasPassword).toBe(false);

    const badQs = new URLSearchParams({ ...fields, hash: hash.replace(/^./, hash[0] === "0" ? "1" : "0") }).toString();
    const bad = await world.server.app.inject({ method: "GET", url: `/api/public/auth/oauth/telegram/callback?${badQs}` });
    expect(bad.statusCode).toBe(302);
    expect(bad.headers.location).toContain("social-error=1");
  });

  it("№ 54 и № 50: пароль создаётся один раз, адрес меняется с новым письмом", async () => {
    const fields: Record<string, string> = {
      id: "777002",
      first_name: "Ilze",
      auth_date: String(Math.floor(world.ctx.now().getTime() / 1000)),
    };
    const checkString = Object.keys(fields).sort().map((k) => `${k}=${fields[k]}`).join("\n");
    const secret = createHash("sha256").update(TG_TOKEN).digest();
    const hash = createHmac("sha256", secret).update(checkString).digest("hex");
    const res = await world.server.app.inject({
      method: "GET",
      url: `/api/public/auth/oauth/telegram/callback?${new URLSearchParams({ ...fields, hash })}`,
    });
    const t = tokensFromRedirect(res.headers.location as string);

    // Пароль: первый раз — ок, второй раз — 409 (смена только через почту).
    const set1 = await world.server.app.inject({
      method: "POST", url: "/api/public/auth/password/set",
      headers: auth(t.access!), payload: { password: "Parole123!" },
    });
    expect(set1.statusCode).toBe(200);
    const set2 = await world.server.app.inject({
      method: "POST", url: "/api/public/auth/password/set",
      headers: auth(t.access!), payload: { password: "Cita123456" },
    });
    expect(set2.statusCode).toBe(409);

    // «Pabeidz profilu»: вписываем настоящий адрес — уходит письмо, метка снята.
    const patch = await world.server.app.inject({
      method: "PATCH", url: "/api/public/me",
      headers: auth(t.access!), payload: { email: "ilze@example.com" },
    });
    expect(patch.statusCode).toBe(200);
    const bidder = await me(t.access!);
    expect(bidder.email).toBe("ilze@example.com");
    expect(bidder.emailPending).toBe(false);
    expect(bidder.emailVerified).toBe(false);
    expect(bidder.hasPassword).toBe(true);

    const [mail] = await world.ctx.db
      .select()
      .from(notifications)
      .where(eq(notifications.customerId, bidder.id as string))
      .orderBy(desc(notifications.createdAt));
    expect(mail?.type).toBe("verify_email");
    expect(mail?.toEmail).toBe("ilze@example.com");
  });

  it("№ 58: выгрузка отдаёт файл с профилем и историей", async () => {
    const reg = await world.server.app.inject({
      method: "POST", url: "/api/public/auth/register",
      payload: { email: "carl@example.com", alias: "carl", password: "Bidder123!" },
    });
    const access = (reg.json() as { accessToken: string }).accessToken;
    const res = await world.server.app.inject({
      method: "GET", url: "/api/public/me/export", headers: auth(access),
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-disposition"]).toContain("izsoli-mani-dati.json");
    const body = res.json() as { profile: { email: string }; bids: unknown[]; orders: unknown[]; cookieConsents: unknown[] };
    expect(body.profile.email).toBe("carl@example.com");
    expect(Array.isArray(body.bids)).toBe(true);
    expect(Array.isArray(body.orders)).toBe(true);
  });

  it("№ 58: аванс на счету блокирует удаление, без него — профиль обезличен", async () => {
    const reg = await world.server.app.inject({
      method: "POST", url: "/api/public/auth/register",
      payload: { email: "dita@example.com", alias: "dita", password: "Bidder123!" },
    });
    const { accessToken, refreshToken, bidder } = reg.json() as { accessToken: string; refreshToken: string; bidder: { id: string } };

    // Начисляем аванс из панели — удаление обязано упереться в баланс.
    const adminToken = await loginAs(world, "super@auction.test");
    const grant = await world.server.app.inject({
      method: "POST", url: `/api/customers/${bidder.id}/credit`,
      headers: auth(adminToken), payload: { amountCents: 500, kind: "grant", note: "тест" },
    });
    expect(grant.statusCode).toBe(200);

    const blocked = await world.server.app.inject({
      method: "POST", url: "/api/public/me/delete", headers: auth(accessToken),
    });
    expect(blocked.statusCode).toBe(409);
    expect((blocked.json() as { blockers: { creditCents: number } }).blockers.creditCents).toBe(500);

    // Выводим аванс — и удаление проходит.
    const withdraw = await world.server.app.inject({
      method: "POST", url: "/api/public/me/credit/withdraw", headers: auth(accessToken),
    });
    expect(withdraw.statusCode).toBe(200);
    const del = await world.server.app.inject({
      method: "POST", url: "/api/public/me/delete", headers: auth(accessToken),
    });
    expect(del.statusCode).toBe(200);

    // Профиль обезличен, вход и сессии мертвы.
    const [row] = await world.ctx.db.select().from(customers).where(eq(customers.id, bidder.id));
    expect(row!.erasedAt).not.toBeNull();
    expect(row!.alias.startsWith("dzests-")).toBe(true);
    expect(row!.email.endsWith("@izsoli.invalid")).toBe(true);
    expect(row!.passwordHash).toBeNull();

    const meDead = await world.server.app.inject({ method: "GET", url: "/api/public/auth/me", headers: auth(accessToken) });
    expect(meDead.statusCode).toBe(401);
    const refresh = await world.server.app.inject({
      method: "POST", url: "/api/public/auth/refresh", payload: { refreshToken },
    });
    expect(refresh.statusCode).toBe(401);
    const login = await world.server.app.inject({
      method: "POST", url: "/api/public/auth/login", payload: { email: "dita@example.com", password: "Bidder123!" },
    });
    expect(login.statusCode).toBe(401);
  });
});
