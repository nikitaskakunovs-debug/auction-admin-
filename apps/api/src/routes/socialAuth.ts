import { randomBytes } from "node:crypto";
import { customers } from "@auction/db";
import { eq } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { SocialAuthError, facebookExchange, googleExchange, telegramVerify, type SocialProfile } from "../engine/socialAuth.js";

/**
 * Соцвход (макеты № 50, 52–54).
 *
 * Правила привязки:
 *  - по id провайдера — вход в существующий аккаунт;
 *  - по адресу, который провайдер сам подтвердил, — привязка к аккаунту с
 *    тем же адресом, дублей не создаём (№ 53);
 *  - без адреса (Telegram) — новый аккаунт со служебным адресом
 *    tg…@nav.izsoli.lv: солить нельзя, пока человек не впишет и не
 *    подтвердит настоящий (№ 50).
 *
 * Токены уходят в витрину фрагментом ссылки (#…) — фрагмент не попадает
 * ни в серверные логи, ни в Referer.
 */
export function registerSocialAuthRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  deps: {
    issueTokens: (customer: { id: string; email: string; alias: string }, req?: FastifyRequest) => Promise<{ accessToken: string; refreshToken: string }>;
  },
): void {
  const enabled = () => ({
    google: ctx.config.google !== null,
    facebook: ctx.config.facebook !== null,
    telegram: ctx.config.telegram ? ctx.config.telegram.botName : null,
  });

  app.get("/api/public/auth/oauth/config", async () => enabled());

  const apiCallbackUrl = (req: FastifyRequest, provider: string) =>
    `${req.protocol}://${req.headers.host}/api/public/auth/oauth/${provider}/callback`;

  /** redirect из витрины подписываем в state — колбэк вернёт человека туда,
   *  откуда он ушёл, и никуда больше (только свой origin). */
  const packState = (redirect: string) => {
    const nonce = randomBytes(8).toString("base64url");
    return `${nonce}.${Buffer.from(redirect).toString("base64url")}`;
  };
  const unpackState = (state: string | undefined): string => {
    const fallback = `${ctx.config.storefrontBaseUrl}/account`;
    if (!state) return fallback;
    const part = state.split(".")[1];
    if (!part) return fallback;
    try {
      const url = Buffer.from(part, "base64url").toString();
      return url.startsWith(ctx.config.storefrontBaseUrl) ? url : fallback;
    } catch {
      return fallback;
    }
  };

  app.get("/api/public/auth/oauth/:provider/start", async (req, reply) => {
    const { provider } = req.params as { provider: string };
    const { redirect } = req.query as { redirect?: string };
    const target = redirect && redirect.startsWith(ctx.config.storefrontBaseUrl)
      ? redirect
      : `${ctx.config.storefrontBaseUrl}/account`;
    const state = packState(target);

    if (provider === "google" && ctx.config.google) {
      const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      url.searchParams.set("client_id", ctx.config.google.clientId);
      url.searchParams.set("redirect_uri", apiCallbackUrl(req, "google"));
      url.searchParams.set("response_type", "code");
      url.searchParams.set("scope", "openid email profile");
      url.searchParams.set("state", state);
      return reply.redirect(url.toString());
    }
    if (provider === "facebook" && ctx.config.facebook) {
      const url = new URL("https://www.facebook.com/v19.0/dialog/oauth");
      url.searchParams.set("client_id", ctx.config.facebook.appId);
      url.searchParams.set("redirect_uri", apiCallbackUrl(req, "facebook"));
      url.searchParams.set("scope", "email,public_profile");
      url.searchParams.set("state", state);
      return reply.redirect(url.toString());
    }
    if (provider === "telegram" && ctx.config.telegram) {
      // У Telegram нет OAuth-кода — виджет постит подписанные поля на
      // data-auth-url. Отдаём страницу с виджетом.
      const cb = `${apiCallbackUrl(req, "telegram")}?state=${encodeURIComponent(state)}`;
      // Без meta viewport телефон рисует страницу «в миниатюре» и кнопка
      // виджета выглядит потерянной точкой — человек решает, что всё зависло.
      return reply.type("text/html").send(`<!doctype html><html lang="lv"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Telegram · Izsoli.lv</title></head>
<body style="margin:0;display:grid;place-items:center;min-height:100vh;background:#F7F5F0;font-family:system-ui,sans-serif">
<div style="text-align:center;padding:24px;max-width:340px">
  <p style="font-size:22px;font-weight:800;color:#163300;margin:0 0 6px">Izsoli.lv</p>
  <p style="font-size:15px;color:#3d4a38;line-height:1.5;margin:0 0 22px">Nospied pogu, lai ienāktu ar Telegram — apstiprināsi ieeju lietotnē.</p>
  <script async src="https://telegram.org/js/telegram-widget.js?22"
    data-telegram-login="${ctx.config.telegram.botName}" data-size="large"
    data-auth-url="${cb}" data-request-access="write"></script>
</div>
</body></html>`);
    }
    return reply.code(501).send({ error: "provider_not_configured" });
  });

  /** Найти или создать аккаунт по профилю провайдера. */
  async function upsert(profile: SocialProfile): Promise<typeof customers.$inferSelect> {
    if (!profile.sub) throw new SocialAuthError("provider returned empty id");
    const idColumn =
      profile.provider === "google" ? customers.googleId
      : profile.provider === "facebook" ? customers.facebookId
      : customers.telegramId;

    const [byId] = await ctx.db.select().from(customers).where(eq(idColumn, profile.sub));
    if (byId && byId.erasedAt === null) return byId;

    if (profile.email && profile.emailVerified) {
      const [byEmail] = await ctx.db.select().from(customers).where(eq(customers.email, profile.email));
      if (byEmail && byEmail.erasedAt === null) {
        // № 53: адрес занят — привязываем соцсеть, дубль не создаём. Адрес
        // подтверждён самим провайдером, заодно закрывает и нашу проверку.
        const [updated] = await ctx.db
          .update(customers)
          .set({
            ...(profile.provider === "google" ? { googleId: profile.sub } : {}),
            ...(profile.provider === "facebook" ? { facebookId: profile.sub } : {}),
            ...(byEmail.emailVerifiedAt === null ? { emailVerifiedAt: ctx.now() } : {}),
          })
          .where(eq(customers.id, byEmail.id))
          .returning();
        return updated!;
      }
    }

    // Новый аккаунт. Без адреса от провайдера — служебный, до «Pabeidz profilu».
    const email = profile.email ?? `tg${profile.sub}@nav.izsoli.lv`;
    const aliasBase = (profile.name ?? profile.provider)
      .toLowerCase()
      .replace(/[^a-z0-9_.-]+/g, ".")
      .replace(/^\.+|\.+$/g, "")
      .slice(0, 16) || profile.provider;
    const alias = `${aliasBase}.${randomBytes(2).toString("hex")}`;
    const [row] = await ctx.db
      .insert(customers)
      .values({
        email,
        alias,
        name: profile.name,
        marketCode: "LV",
        country: "LV",
        passwordHash: null,
        emailVerifiedAt: profile.email && profile.emailVerified ? ctx.now() : null,
        ...(profile.provider === "google" ? { googleId: profile.sub } : {}),
        ...(profile.provider === "facebook" ? { facebookId: profile.sub } : {}),
        ...(profile.provider === "telegram" ? { telegramId: profile.sub } : {}),
      })
      .onConflictDoNothing()
      .returning();
    if (!row) throw new SocialAuthError("account already exists for this address", 409);
    return row;
  }

  async function finish(profile: SocialProfile, state: string | undefined, req: FastifyRequest, reply: FastifyReply) {
    const customer = await upsert(profile);
    const tokens = await deps.issueTokens(customer, req);
    const target = unpackState(state);
    const sep = "#";
    return reply.redirect(`${target}${sep}a=${tokens.accessToken}&r=${tokens.refreshToken}`);
  }

  const failure = (reply: FastifyReply, err: unknown) => {
    const status = err instanceof SocialAuthError ? err.status : 401;
    const target = `${ctx.config.storefrontBaseUrl}/login`;
    void status;
    return reply.redirect(`${target}#social-error=1`);
  };

  app.get("/api/public/auth/oauth/google/callback", async (req, reply) => {
    const q = req.query as { code?: string; state?: string; error?: string };
    if (!q.code) return failure(reply, new SocialAuthError(q.error ?? "no code"));
    try {
      const profile = await googleExchange(ctx.config, q.code, apiCallbackUrl(req, "google"));
      return await finish(profile, q.state, req, reply);
    } catch (err) {
      req.log.warn({ err }, "google oauth failed");
      return failure(reply, err);
    }
  });

  app.get("/api/public/auth/oauth/facebook/callback", async (req, reply) => {
    const q = req.query as { code?: string; state?: string; error?: string };
    if (!q.code) return failure(reply, new SocialAuthError(q.error ?? "no code"));
    try {
      const profile = await facebookExchange(ctx.config, q.code, apiCallbackUrl(req, "facebook"));
      return await finish(profile, q.state, req, reply);
    } catch (err) {
      req.log.warn({ err }, "facebook oauth failed");
      return failure(reply, err);
    }
  });

  app.get("/api/public/auth/oauth/telegram/callback", async (req, reply) => {
    const { state, ...params } = req.query as Record<string, string>;
    try {
      const profile = telegramVerify(ctx.config, params, ctx.now().getTime());
      return await finish(profile, state, req, reply);
    } catch (err) {
      req.log.warn({ err }, "telegram oauth failed");
      return failure(reply, err);
    }
  });

  /** № 54: пароль для входа без соцсети. Только когда пароля ещё нет —
   *  смена существующего идёт через восстановление по почте. */
  app.post("/api/public/auth/password/set", async (req, reply) => {
    if (!req.bidder) return reply.code(401).send({ error: "unauthenticated" });
    const body = z.object({ password: z.string().min(8) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body" });
    const [c] = await ctx.db.select().from(customers).where(eq(customers.id, req.bidder.sub));
    if (!c || c.erasedAt !== null) return reply.code(401).send({ error: "unauthenticated" });
    if (c.passwordHash !== null) return reply.code(409).send({ error: "password_exists" });
    const { hashPassword } = await import("@auction/db");
    await ctx.db
      .update(customers)
      .set({ passwordHash: await hashPassword(body.data.password) })
      .where(eq(customers.id, c.id));
    return { ok: true };
  });
}
