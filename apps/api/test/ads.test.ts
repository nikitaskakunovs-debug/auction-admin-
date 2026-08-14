import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auth, createWorld, loginAs, type TestWorld } from "./helpers.js";

/**
 * Реклама в ленте лотов.
 *
 * Место продаётся рекламодателю, поэтому важны три вещи: карточка показывается
 * только в свой срок, только в своей категории, и показы считаются на сервере —
 * верить в этом вопросе браузеру нельзя.
 */
describe("реклама в ленте", () => {
  let world: TestWorld;
  let token: string;

  beforeAll(async () => {
    world = await createWorld();
    token = await loginAs(world, "super@auction.test");
  });
  afterAll(async () => {
    if (world) await world.close();
  });

  const create = async (patch: Record<string, unknown>) => {
    const res = await world.server.app.inject({
      method: "POST",
      url: "/api/ads",
      headers: auth(token),
      payload: { title: "Реклама", href: "https://example.test", ...patch },
    });
    expect(res.statusCode, JSON.stringify(res.json())).toBe(200);
    return (res.json() as { ad: { id: string } }).ad;
  };

  const publicAds = async (category?: string) => {
    const res = await world.server.app.inject({
      method: "GET",
      url: `/api/public/ads${category ? `?category=${category}` : ""}`,
    });
    return (res.json() as { ads: Array<{ id: string; everyN: number }> }).ads;
  };

  it("не показывает выключенную карточку", async () => {
    const ad = await create({ title: "Выключенная", active: false });
    expect((await publicAds()).some((a) => a.id === ad.id)).toBe(false);
  });

  it("показывает включённую и отдаёт шаг показа", async () => {
    const ad = await create({ title: "Включённая", active: true, everyN: 7 });
    const found = (await publicAds()).find((a) => a.id === ad.id);
    expect(found, "карточка в выдаче").toBeTruthy();
    expect(found!.everyN).toBe(7);
  });

  it("держит карточку в своей категории и не пускает в чужую", async () => {
    const ad = await create({ title: "Только инструменты", active: true, categoryCode: "tools" });
    expect((await publicAds("tools")).some((a) => a.id === ad.id), "в своей — видна").toBe(true);
    expect((await publicAds("fashion")).some((a) => a.id === ad.id), "в чужой — нет").toBe(false);
  });

  it("карточку без категории показывает и в конкретной категории", async () => {
    const ad = await create({ title: "Везде", active: true, categoryCode: null });
    expect((await publicAds("fashion")).some((a) => a.id === ad.id)).toBe(true);
  });

  it("не показывает карточку до начала и после конца срока", async () => {
    const past = await create({
      title: "Срок вышел", active: true,
      startsAt: new Date(Date.now() - 90 * 86_400_000).toISOString(),
      endsAt: new Date(Date.now() - 60 * 86_400_000).toISOString(),
    });
    const future = await create({
      title: "Ещё не начали", active: true,
      startsAt: new Date(Date.now() + 60 * 86_400_000).toISOString(),
    });
    const live = await publicAds();
    expect(live.some((a) => a.id === past.id), "прошедшая скрыта").toBe(false);
    expect(live.some((a) => a.id === future.id), "будущая скрыта").toBe(false);
  });

  it("считает показы на сервере и не считает их выключенной карточке", async () => {
    const on = await create({ title: "Считаем", active: true });
    for (let i = 0; i < 3; i++) {
      const r = await world.server.app.inject({ method: "POST", url: `/api/public/ads/${on.id}/seen` });
      expect(r.statusCode).toBe(200);
    }
    const off = await create({ title: "Не считаем", active: false });
    const r = await world.server.app.inject({ method: "POST", url: `/api/public/ads/${off.id}/seen` });
    expect(r.statusCode, "выключенной карточке показ не засчитывается").toBe(404);

    const list = await world.server.app.inject({ method: "GET", url: "/api/ads", headers: auth(token) });
    const rows = (list.json() as { ads: Array<{ id: string; impressions: number }> }).ads;
    expect(rows.find((a) => a.id === on.id)!.impressions).toBe(3);
    expect(rows.find((a) => a.id === off.id)!.impressions).toBe(0);
  });

  it("не принимает бессмысленный шаг показа", async () => {
    for (const everyN of [0, 2, 500]) {
      const res = await world.server.app.inject({
        method: "POST", url: "/api/ads", headers: auth(token),
        payload: { title: "Плохой шаг", href: "https://example.test", everyN },
      });
      expect(res.statusCode, `everyN=${everyN}`).toBe(400);
    }
  });

  it("держит управление рекламой за правом на контент", async () => {
    const ops = await loginAs(world, "ops@auction.test");
    const res = await world.server.app.inject({
      method: "POST", url: "/api/ads", headers: auth(ops),
      payload: { title: "Чужими руками", href: "https://example.test" },
    });
    expect(res.statusCode).toBe(403);
  });
});
