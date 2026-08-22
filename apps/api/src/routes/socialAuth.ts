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
/** Дружелюбный случайный сегвардс: «чьё» (город, река, время года, материал)
 *  + «кто/что» (зверь, птица, рыба, дерево, символ) + число 10–999.
 *  ~55 × 55 × 990 ≈ 3 млн сочетаний — на сотни тысяч клиентов без частых
 *  повторов; редкое совпадение решает повторная попытка вставки.
 *  Правило сегварда — латиница без диакритики, поэтому слова в привычной
 *  ASCII-записи (Rīgas → Rigas), как в доменах и адресах. */
const ALIAS_PREFIX = [
  // Города и места (родительный падеж)
  "Rigas", "Jurmalas", "Liepajas", "Ventspils", "Jelgavas", "Valmieras",
  "Siguldas", "Cesu", "Kuldigas", "Talsu", "Tukuma", "Bauskas", "Ogres",
  "Saldus", "Dobeles", "Madonas", "Gulbenes", "Ludzas", "Rezeknes",
  "Daugavpils", "Jekabpils", "Aizkraukles", "Smiltenes", "Kokneses",
  "Kandavas", "Sabiles", "Rojas", "Kolkas", "Engures", "Ikskiles",
  // Реки и вода
  "Gaujas", "Daugavas", "Ventas", "Lielupes", "Salacas", "Abavas",
  "Amatas", "Juras", "Ezera", "Upes",
  // Природа и время
  "Ziemas", "Vasaras", "Rudens", "Pavasara", "Vakara", "Nakts", "Ausmas",
  "Saules", "Zvaigznes", "Kalna", "Sila", "Lauka", "Krasta", "Salas",
  // Материалы
  "Zelta", "Sudraba", "Dzintara", "Vara",
];
const ALIAS_NOUN = [
  // Птицы
  "Vanags", "Gulbis", "Gailis", "Dzenis", "Strazds", "Zvirbulis",
  "Teteris", "Rubenis", "Cielava", "Grieze", "Sloka", "Kaija", "Zoss", "Pile",
  // Звери
  "Vilks", "Lapsa", "Alnis", "Briedis", "Stirna", "Ezis", "Bebrs",
  "Caune", "Sesks", "Susuris", "Zirgs",
  // Рыбы
  "Lasis", "Asaris", "Plaudis", "Karpa", "Menca", "Zutis", "Salaka",
  "Vimba", "Rauda", "Linis", "Sams",
  // Деревья и цветы
  "Ozols", "Liepa", "Priede", "Egle", "Osis", "Kastanis", "Magone", "Pienene",
  // Латышские символы и вещи
  "Namejs", "Sakta", "Kokle", "Vainags", "Dzintars", "Auseklis", "Laima",
  "Zvaigzne", "Staburags", "Akmens", "Gaisma", "Ausma", "Karogs", "Pastala",
];
function randomAlias(): string {
  const pick = (arr: string[]) => arr[Math.floor(Math.random() * arr.length)]!;
  return `${pick(ALIAS_PREFIX)}${pick(ALIAS_NOUN)}${Math.floor(Math.random() * 990) + 10}`;
}

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

  // Мобильный Telegram после подтверждения возвращает человека на КОРЕНЬ
  // домена виджета с фрагментом #tgAuthResult=… — а не на страницу-источник.
  // Голый API отвечал здесь 404, и вход обрывался. Отдаём переадресацию на
  // витрину: фрагмент по правилам HTTP переживает redirect, и SocialCatch
  // на витрине доведёт вход до конца.
  app.get("/", async (_req, reply) => reply.redirect(ctx.config.storefrontBaseUrl));

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
      // У Telegram нет OAuth-кода — виджет живёт на странице витрины в её
      // дизайне (/telegram), а сюда кнопка попадает только по старой памяти.
      const path = target.slice(ctx.config.storefrontBaseUrl.length) || "/account";
      return reply.redirect(`${ctx.config.storefrontBaseUrl}/telegram?next=${encodeURIComponent(path)}`);
    }
    return reply.code(501).send({ error: "provider_not_configured" });
  });

  /** Найти или создать аккаунт по профилю провайдера. `created` отличает
   *  первую регистрацию от повторного входа — аналитике (sign_up vs login)
   *  это разные события. */
  async function upsert(profile: SocialProfile): Promise<{ customer: typeof customers.$inferSelect; created: boolean }> {
    if (!profile.sub) throw new SocialAuthError("provider returned empty id");
    const idColumn =
      profile.provider === "google" ? customers.googleId
      : profile.provider === "facebook" ? customers.facebookId
      : customers.telegramId;

    const [byId] = await ctx.db.select().from(customers).where(eq(idColumn, profile.sub));
    if (byId && byId.erasedAt === null) return { customer: byId, created: false };

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
        // Привязка к существующему аккаунту — это вход, не регистрация.
        return { customer: updated!, created: false };
      }
    }

    // Новый аккаунт. Без адреса от провайдера — служебный, до «Pabeidz profilu».
    // Сегвардс — случайный и дружелюбный, а не огрызок вида telegram.224d.
    // Настоящее имя из соцсети в публичный сегвардс не попадает: его видят
    // все в истории ставок. Поменять можно в настройках в любой момент.
    const email = profile.email ?? `tg${profile.sub}@nav.izsoli.lv`;
    for (let attempt = 0; attempt < 6; attempt++) {
      const [row] = await ctx.db
        .insert(customers)
        .values({
          email,
          alias: randomAlias(),
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
      if (row) return { customer: row, created: true };
      // Пусто — конфликт: либо редкое совпадение сегварда (пробуем другой),
      // либо адрес уже занят — тогда и шестая попытка кончится тем же 409.
    }
    throw new SocialAuthError("account already exists for this address", 409);
  }

  async function finish(profile: SocialProfile, target: string, req: FastifyRequest, reply: FastifyReply) {
    const { customer, created } = await upsert(profile);
    const tokens = await deps.issueTokens(customer, req);
    // p/n — для аналитики на витрине: каким способом вошли и первая ли это
    // регистрация (sign_up) или повторный вход (login). Персональных данных
    // во фрагменте нет, и он не попадает ни в логи, ни в Referer.
    return reply.redirect(`${target}#a=${tokens.accessToken}&r=${tokens.refreshToken}&p=${profile.provider}&n=${created ? 1 : 0}`);
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
      return await finish(profile, unpackState(q.state), req, reply);
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
      return await finish(profile, unpackState(q.state), req, reply);
    } catch (err) {
      req.log.warn({ err }, "facebook oauth failed");
      return failure(reply, err);
    }
  });

  app.get("/api/public/auth/oauth/telegram/callback", async (req, reply) => {
    // redirect добавляет страница витрины (не Telegram) — поэтому он не входит
    // в подписанные поля и обязан быть вырезан до проверки HMAC. Чужой адрес
    // не пройдёт: принимаем только свою витрину.
    const { state, redirect, ...params } = req.query as Record<string, string>;
    try {
      const profile = telegramVerify(ctx.config, params, ctx.now().getTime());
      const target = redirect && redirect.startsWith(ctx.config.storefrontBaseUrl)
        ? redirect
        : unpackState(state);
      return await finish(profile, target, req, reply);
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
