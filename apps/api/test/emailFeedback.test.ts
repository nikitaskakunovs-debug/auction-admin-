import { customers, notifications } from "@auction/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { clearBounce, parseEmailFeedback } from "../src/engine/emailFeedback.js";
import { dispatchNotifications } from "../src/engine/notifications.js";
import { loadConfig } from "../src/config.js";
import { scrubSecrets } from "../src/instrument.js";
import { createWorld, type TestWorld } from "./helpers.js";

/**
 * Обратная связь почты: отказы доставки и жалобы на спам.
 *
 * Проверяем не только «отметка поставилась», но и разницу между сигналами:
 * мёртвый ящик и переполненный — не одно и то же, и жалоба на спам не должна
 * отрезать человека от писем про его собственный заказ.
 */
describe("отказы почты и жалобы", () => {
  let world: TestWorld;
  const SECRET = "hook-secret-for-tests";

  const register = async (alias: string) => {
    const res = await world.server.app.inject({
      method: "POST",
      url: "/api/public/auth/register",
      payload: { email: `${alias}@bounce.test`, alias, password: "Bidder123!", country: "LV" },
    });
    expect(res.statusCode).toBe(200);
    return res.json() as { accessToken: string; bidder: { id: string } };
  };

  // async + await: inject() без await отдаёт цепочку, у которой нет statusCode.
  const hook = async (body: Record<string, unknown>, secret = SECRET) =>
    await world.server.app.inject({ method: "POST", url: `/api/public/email/hook/${secret}`, payload: body });

  const personOf = async (id: string) => {
    const [row] = await world.ctx.db.select().from(customers).where(eq(customers.id, id));
    return row!;
  };

  beforeAll(async () => {
    world = await createWorld();
    // Секрет живёт в конфиге; тестовый мир поднимается со своим.
    (world.ctx.config as { emailWebhookSecret: string | null }).emailWebhookSecret = SECRET;
  });
  afterAll(async () => {
    if (world) await world.close();
  });

  /* ── Разбор форматов ──────────────────────────────────────────────────── */

  it("понимает оба формата и отличает временный отказ от вечного", () => {
    expect(
      parseEmailFeedback({ type: "email.bounced", data: { to: ["a@x.lv"], bounce: { type: "Permanent" } } }),
    ).toEqual({ kind: "hard_bounce", recipients: ["a@x.lv"] });
    expect(
      parseEmailFeedback({ type: "email.bounced", data: { to: ["a@x.lv"], bounce: { type: "Transient" } } }),
    ).toEqual({ kind: "soft_bounce", recipients: ["a@x.lv"] });
    expect(parseEmailFeedback({ type: "email.complained", data: { to: ["a@x.lv"] } })).toEqual({
      kind: "complaint",
      recipients: ["a@x.lv"],
    });

    // SES приходит завёрнутым в SNS: полезное внутри строки Message.
    const ses = {
      Type: "Notification",
      Message: JSON.stringify({
        notificationType: "Bounce",
        bounce: { bounceType: "Permanent", bouncedRecipients: [{ emailAddress: "b@x.lv" }] },
      }),
    };
    expect(parseEmailFeedback(ses)).toEqual({ kind: "hard_bounce", recipients: ["b@x.lv"] });

    // Чужое событие не должно притворяться отказом.
    expect(parseEmailFeedback({ type: "email.delivered", data: { to: ["a@x.lv"] } })).toBeNull();
    expect(parseEmailFeedback({ hello: "world" })).toBeNull();
    expect(parseEmailFeedback(null)).toBeNull();
  });

  /* ── Применение ───────────────────────────────────────────────────────── */

  it("вечный отказ: адрес помечен, письма из очереди сняты", async () => {
    const person = await register("dead_box");
    // Кладём в очередь письмо, которое заведомо не дойдёт.
    await world.ctx.db.insert(notifications).values({
      customerId: person.bidder.id,
      type: "outbid",
      channel: "email",
      toEmail: "dead_box@bounce.test",
      subject: "test",
      body: "test",
      status: "pending",
    });

    const res = await hook({
      type: "email.bounced",
      data: { to: ["dead_box@bounce.test"], bounce: { type: "Permanent" } },
    });
    expect(res.statusCode).toBe(204);

    expect((await personOf(person.bidder.id)).emailBouncedAt).not.toBeNull();
    const queued = await world.ctx.db
      .select()
      .from(notifications)
      .where(and(eq(notifications.customerId, person.bidder.id), eq(notifications.status, "pending")));
    expect(queued).toHaveLength(0);
  });

  it("в мёртвый ящик не идут и служебные письма — ни завтра, ни через месяц", async () => {
    const person = await register("dead_forever");
    await hook({
      type: "email.bounced",
      data: { to: ["dead_forever@bounce.test"], bounce: { type: "Permanent" } },
    });

    // Назавтра движок ставит в очередь новое напоминание — как делал бы с
    // любым неоплаченным заказом. Раньше оно уходило: проверка стояла только
    // у рассылок.
    await world.ctx.db.insert(notifications).values({
      customerId: person.bidder.id,
      type: "payment_reminder",
      kind: "service",
      channel: "email",
      toEmail: "dead_forever@bounce.test",
      subject: "reminder",
      body: "reminder",
      status: "pending",
    });
    const before = world.email.sent.length;
    await dispatchNotifications(world.ctx);

    expect(world.email.sent.length).toBe(before);
    const [row] = await world.ctx.db
      .select()
      .from(notifications)
      .where(and(eq(notifications.customerId, person.bidder.id), eq(notifications.type, "payment_reminder")));
    expect(row!.status).toBe("failed");
    expect(row!.lastError).toBe("address bounced");

    // Человек исправил адрес — отметка снята, письма пошли снова.
    await clearBounce(world.ctx, person.bidder.id);
    await world.ctx.db
      .update(notifications)
      .set({ status: "pending" })
      .where(eq(notifications.id, row!.id));
    await dispatchNotifications(world.ctx);
    expect(world.email.sent.length).toBe(before + 1);
  });

  it("временный отказ ничего не ломает — ящик просто переполнен", async () => {
    const person = await register("full_box");
    const res = await hook({
      type: "email.bounced",
      data: { to: ["full_box@bounce.test"], bounce: { type: "Transient" } },
    });
    expect(res.statusCode).toBe(204);
    // Человек не виноват, что у него кончилось место: адрес остаётся живым.
    expect((await personOf(person.bidder.id)).emailBouncedAt).toBeNull();
  });

  it("жалоба на спам отписывает от рассылок, но адрес не хоронит", async () => {
    const person = await register("angry_one");
    await world.ctx.db
      .update(customers)
      .set({ marketingOptIn: true })
      .where(eq(customers.id, person.bidder.id));

    const res = await hook({ type: "email.complained", data: { to: ["angry_one@bounce.test"] } });
    expect(res.statusCode).toBe(204);

    const row = await personOf(person.bidder.id);
    expect(row.unsubscribedAt).not.toBeNull();
    expect(row.marketingOptIn).toBe(false);
    // Счёт и код выдачи ему по-прежнему нужны — адрес живой.
    expect(row.emailBouncedAt).toBeNull();
  });

  it("регистр адреса значения не имеет", async () => {
    const person = await register("mixedcase");
    const res = await hook({
      type: "email.bounced",
      data: { to: ["MixedCase@Bounce.Test"], bounce: { type: "Permanent" } },
    });
    expect(res.statusCode).toBe(204);
    expect((await personOf(person.bidder.id)).emailBouncedAt).not.toBeNull();
  });

  /* ── Доступ ───────────────────────────────────────────────────────────── */

  it("без верного секрета обработчика не существует", async () => {
    const person = await register("safe_one");
    const res = await hook(
      { type: "email.bounced", data: { to: ["safe_one@bounce.test"], bounce: { type: "Permanent" } } },
      "wrong-secret",
    );
    expect(res.statusCode).toBe(404);
    expect((await personOf(person.bidder.id)).emailBouncedAt).toBeNull();
  });

  it("ответ на письмо уходит в живой ящик, а не в noreply", () => {
    const base = {
      DATABASE_URL: "postgres://x/y", REDIS_URL: "redis://x", JWT_SECRET: "x".repeat(32),
      EMAIL_MODE: "smtp", SMTP_HOST: "smtp.example.com", EMAIL_FROM: "Izsoli.lv <noreply@izsoli.lv>",
    } as NodeJS.ProcessEnv;

    // По умолчанию — публичный адрес компании: он же стоит в счетах.
    expect(loadConfig({ ...base }).smtp?.replyTo).toBe("info@izsoli.lv");
    // Компанейский адрес переопределяет умолчание…
    expect(loadConfig({ ...base, COMPANY_EMAIL: "sveiki@izsoli.lv" }).smtp?.replyTo).toBe("sveiki@izsoli.lv");
    // …а отдельная настройка — всё остальное.
    expect(
      loadConfig({ ...base, COMPANY_EMAIL: "sveiki@izsoli.lv", EMAIL_REPLY_TO: "atbalsts@izsoli.lv" }).smtp?.replyTo,
    ).toBe("atbalsts@izsoli.lv");
  });

  it("секрет из адреса не уезжает в мониторинг", () => {
    const url = `https://api.izsoli.lv/api/public/email/hook/${SECRET}`;
    expect(scrubSecrets(url)).toBe("https://api.izsoli.lv/api/public/email/hook/[redacted]");
    expect(scrubSecrets(url)).not.toContain(SECRET);
    // Хвост запроса вырезание не съедает, а чужие адреса не трогает.
    expect(scrubSecrets(`${url}?retry=2`)).toBe(
      "https://api.izsoli.lv/api/public/email/hook/[redacted]?retry=2",
    );
    expect(scrubSecrets("https://api.izsoli.lv/api/public/listings")).toBe(
      "https://api.izsoli.lv/api/public/listings",
    );
  });

  it("незнакомый адрес — не ошибка: письма уходят и поставщикам", async () => {
    const res = await hook({
      type: "email.bounced",
      data: { to: ["nobody@example.com"], bounce: { type: "Permanent" } },
    });
    expect(res.statusCode).toBe(204);
  });
});
