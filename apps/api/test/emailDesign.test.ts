import { customers } from "@auction/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  LANGS,
  NOTIFICATION_TYPES,
  dispatchNotifications,
  enqueueNotification,
  langFor,
  renderNotification,
  sampleInput,
} from "../src/engine/notifications.js";
import { auth, createBidder, createWorld, loginAs, type TestWorld } from "./helpers.js";

/**
 * The designed emails. What matters here is not that the HTML is pretty —
 * nobody can assert that — but that it is complete, safe, and never the only
 * copy of the message: a client that refuses HTML must still learn the amount,
 * the deadline and the code.
 */
describe("designed emails", () => {
  let world: TestWorld;
  let superToken: string;

  beforeAll(async () => {
    world = await createWorld();
    superToken = await loginAs(world, "super@auction.test");
  });
  afterAll(async () => {
    if (world) await world.close();
  });
  beforeEach(() => {
    world.email.sent.length = 0;
  });

  it("renders every type in every language, with the button and the facts intact", async () => {
    for (const type of NOTIFICATION_TYPES) {
      for (const lang of LANGS) {
        const r = await renderNotification(world.ctx, type, lang, sampleInput(type));
        expect(r.subject.length, `${type}/${lang} subject`).toBeGreaterThan(5);
        expect(r.text.length, `${type}/${lang} text`).toBeGreaterThan(20);
        expect(r.html, `${type}/${lang} is a full document`).toContain("<!doctype html>");
        // Tables, not flexbox — Outlook renders one of those.
        expect(r.html).toContain("<table");
        expect(r.html, "no external stylesheet").not.toContain("<link");
        expect(r.html, "no script ever").not.toContain("<script");
        // The machine tag the outbox and tests key on survives in the text.
        expect(r.text, `${type} tag`).toContain(`[${type}]`);
      }
    }
  });

  it("puts the money and the deadline in both bodies, not just the pretty one", async () => {
    const r = await renderNotification(world.ctx, "won", "lv", sampleInput("won", { online: true }));
    expect(r.text).toContain("251,56"); // total, plain text
    expect(r.html).toContain("251,56"); // total, designed
    expect(r.html).toContain("A-1042"); // order ref
    expect(r.html).toContain("Apmaksāt"); // the button
  });

  it("only offers ways to pay that the site can actually take", async () => {
    // Providers off — as production has been all along. The button must not
    // promise a checkout that cannot be produced.
    const dark = { ...world.ctx, klix: null, inbank: null } as typeof world.ctx;
    const off = await renderNotification(dark, "won", "lv", { ...sampleInput("won"), payUrl: null });
    expect(off.html, "no Klix named while Klix is off").not.toContain("Klix");
    expect(off.html).toContain("Apmaksa pie letes");
    expect(off.html, "the button says what it actually does").toContain("Skatīt pasūtījumu");
    expect(off.html).not.toContain("Apmaksāt 251,56");

    // With a provider on and a live link, the button is the checkout itself.
    const on = await renderNotification(world.ctx, "won", "lv", {
      ...sampleInput("won", { online: true }),
    });
    expect(on.html).toContain("Apmaksāt 251,56");
    expect(on.html).toContain("Klix");
    expect(on.html).toContain("/api/public/pay/A-1042");
  });

  it("carries the collection code in the pickup emails", async () => {
    for (const lang of LANGS) {
      const r = await renderNotification(world.ctx, "pickup_ready", lang, sampleInput("pickup_ready"));
      expect(r.text).toContain("418209");
      expect(r.html).toContain("418209");
    }
  });

  it("escapes a lot title rather than letting it write markup", async () => {
    const r = await renderNotification(world.ctx, "won", "lv", {
      ...sampleInput("won"),
      lotTitle: '<img src=x onerror="alert(1)">Ļoti "īpaša" prece & co',
    });
    expect(r.html).not.toContain("<img src=x");
    expect(r.html).toContain("&lt;img src=x");
    expect(r.html).toContain("&amp; co");
  });

  it("renders a dead button rather than a live one for a link we would never send", async () => {
    const r = await renderNotification(world.ctx, "won", "lv", {
      ...sampleInput("won"),
      payUrl: "javascript:alert(1)",
    });
    expect(r.html).not.toContain("javascript:");
  });

  it("writes to a customer in their own language, falling back to the country", async () => {
    expect(langFor("ru", "LV")).toBe("ru");
    expect(langFor(null, "LV")).toBe("lv");
    expect(langFor(null, "EE")).toBe("en");
    expect(langFor("nonsense", "LV")).toBe("lv");

    const id = await createBidder(world, "email_ru", { email: "ru@design.test", country: "LV" });
    await world.ctx.db.update(customers).set({ lang: "ru" }).where(eq(customers.id, id));
    await enqueueNotification(world.ctx, world.ctx.db, {
      customerId: id,
      type: "pickup_ready",
      template: { alias: "", lotTitle: "Тестовый лот", orderRef: "A-9001", pickupCode: "123456", deadline: new Date() },
    });
    await dispatchNotifications(world.ctx);
    const mail = world.email.sent.find((m) => m.to === "ru@design.test");
    expect(mail, "the email went out").toBeTruthy();
    expect(mail!.subject).toContain("Готов к получению");
    expect(mail!.html, "designed body sent alongside the text").toBeTruthy();
    expect(mail!.text, "text body still sent").toContain("123456");
    expect(mail!.html!).toContain("123456");
  });

  it("previews any email in the panel, and sends the sample only to the signed-in admin", async () => {
    const preview = await world.server.app.inject({
      method: "GET",
      url: "/api/notifications/preview?type=pickup_ready&lang=lv",
      headers: auth(superToken),
    });
    expect(preview.statusCode).toBe(200);
    const body = preview.json() as { subject: string; html: string; text: string };
    expect(body.html).toContain("<!doctype html>");
    expect(body.subject).toContain("Gatavs saņemšanai");

    const sent = await world.server.app.inject({
      method: "POST",
      url: "/api/notifications/preview/send",
      headers: auth(superToken),
      payload: { type: "won", lang: "lv" },
    });
    expect(sent.statusCode).toBe(200);
    // The address is never taken from the request — it is whoever is logged in.
    expect((sent.json() as { to: string }).to).toBe("super@auction.test");
    const sample = world.email.sent.at(-1);
    expect(sample!.subject.startsWith("[PARAUGS]"), "samples are labelled").toBe(true);
    expect(sample!.to).toBe("super@auction.test");
  });

  it("keeps the preview behind settings permissions", async () => {
    const opsToken = await loginAs(world, "ops@auction.test");
    const res = await world.server.app.inject({
      method: "GET",
      url: "/api/notifications/preview?type=won&lang=lv",
      headers: auth(opsToken),
    });
    expect(res.statusCode).toBe(403);
  });

  it("refuses a type it does not have copy for", async () => {
    const res = await world.server.app.inject({
      method: "GET",
      url: "/api/notifications/preview?type=not_a_type&lang=lv",
      headers: auth(superToken),
    });
    expect(res.statusCode).toBe(400);
  });
});
