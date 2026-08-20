import { expect, test } from "@playwright/test";

/**
 * Регрессии, найденные по записи экрана с реального iPhone (глава 17
 * хендбука). Все три раньше воспроизводились на живом izsoli.lv:
 *
 *  1. нижний док прятался при скролле и возвращался — 31 переключение
 *     за 125 секунд записи;
 *  2. верхняя панель складывалась, и через 360 мс скрипт переписывал
 *     `--chrome-h` — вся страница прыгала на 195 px;
 *  3. каждая карточка лота заводила свой `setInterval(…, 1000)`.
 *
 * Тест идёт на ширине 390 px — это iPhone, а телефоны дают 80 % трафика.
 */

const PHONE = { width: 390, height: 844 };

test.use({ viewport: PHONE, isMobile: true, hasTouch: true });

/** Открыть каталог и убрать баннер сікdatnes — он перекрывает низ экрана. */
async function openCatalogue(page: import("@playwright/test").Page): Promise<void> {
  await page.goto("/katalogs", { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".dock", { timeout: 20_000 });
  const accept = page.getByRole("button", { name: /Pieņemt visas/i });
  if (await accept.count()) await accept.first().click().catch(() => {});
  await page.waitForTimeout(200);
}

test("док остаётся на месте при любой прокрутке", async ({ page }) => {
  await openCatalogue(page);
  const dock = page.locator(".dock");
  await expect(dock).toBeVisible();

  const box0 = await dock.boundingBox();
  expect(box0).not.toBeNull();

  // Вниз, вверх, снова вниз — и дёргано, как палец на инерционной прокрутке.
  for (const y of [400, 900, 860, 1200, 1150, 600, 0]) {
    await page.evaluate((v) => window.scrollTo(0, v), y);
    await page.waitForTimeout(120);
    await expect(dock).toBeVisible();
    const box = await dock.boundingBox();
    expect(box).not.toBeNull();
    // Док фиксирован: его положение в окне не должно меняться вовсе.
    expect(Math.abs(box!.y - box0!.y)).toBeLessThanOrEqual(1);
  }
});

test("страница не сдвигается при прокрутке (высота шапки постоянна)", async ({ page }) => {
  await openCatalogue(page);

  const docY = async () =>
    page.evaluate(() => {
      const el = document.querySelector("h1");
      if (!el) return null;
      return Math.round(el.getBoundingClientRect().top + window.scrollY);
    });

  const seen: number[] = [];
  for (const y of [0, 200, 0, 600, 0]) {
    await page.evaluate((v) => window.scrollTo(0, v), y);
    // Ждём дольше, чем жил старый `setTimeout(measure, 360)`.
    await page.waitForTimeout(700);
    const v = await docY();
    expect(v).not.toBeNull();
    seen.push(v!);
  }
  expect(Math.max(...seen) - Math.min(...seen)).toBe(0);
});

test("все пять подписей дока видны", async ({ page }) => {
  await openCatalogue(page);
  const labels = page.locator(".dock .lbl");
  await expect(labels).toHaveCount(5);
  for (let i = 0; i < 5; i++) {
    await expect(labels.nth(i)).toBeVisible();
    expect(((await labels.nth(i).textContent()) ?? "").trim().length).toBeGreaterThan(0);
  }
});

test("таймер идёт на видимой карточке", async ({ page }) => {
  await openCatalogue(page);
  await page.waitForSelector(".lot", { timeout: 20_000 });
  const card = page.locator(".lot").first();
  await card.scrollIntoViewIfNeeded();
  const stamp = card.locator("time").first();
  await expect(stamp).toBeVisible();
  await page.waitForTimeout(600);

  const before = await stamp.textContent();
  await page.waitForTimeout(2600);
  expect(await stamp.textContent()).not.toBe(before);
});

test("карточка вне экрана не перерисовывается, но досчитывает при возврате", async ({ page }) => {
  await openCatalogue(page);
  await page.waitForSelector(".lot", { timeout: 20_000 });
  const card = page.locator(".lot").first();
  await card.scrollIntoViewIfNeeded();
  const stamp = card.locator("time").first();
  await page.waitForTimeout(600);

  // Уводим карточку далеко вверх за пределы окна.
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(400);
  const parked = await stamp.textContent();
  await page.waitForTimeout(3000);
  expect(await stamp.textContent()).toBe(parked); // не тикала — главный поток свободен

  // Вернули в поле зрения — время должно догнать реальное, а не продолжить
  // с того места, где остановилось.
  await card.scrollIntoViewIfNeeded();
  await page.waitForTimeout(1500);
  expect(await stamp.textContent()).not.toBe(parked);
});
