import { expect, test, type Page } from "@playwright/test";
import { createFixedListing, uniq, verifyEmailDb } from "./fixtures.js";

async function registerViaUi(page: Page, alias: string): Promise<void> {
  await page.fill('input[type="email"]', `${alias}@e2e.test`);
  await page.fill('input[placeholder*="Alias"], input[placeholder*="Segvārds"]', alias);
  await page.fill('input[type="password"]', "Bidder123!");
  await page.click('button[type="submit"]');
  // Почту подтверждаем в базе: без этого ставки и покупка закрыты.
  await verifyEmailDb(`${alias}@e2e.test`);
}

test("fixed-price: guest cart → register at checkout → order is born in the cart", async ({ page, request }) => {
  const { listingId, title } = await createFixedListing(request, { priceCents: 12_000 });

  // Путь покупки один для всех и начинается без входа: «Pirkt tagad» кладёт
  // лот в серверную корзину и открывает грозс.
  await page.goto(`/listing/${listingId}`);
  await page.click("text=/Buy now|Pirkt tagad/");
  await expect(page).toHaveURL(/\/grozs$/);
  await expect(page.locator(`text=${title}`)).toBeVisible();

  // Оформление спрашивает вход — с возвратом в этот же грозс.
  await page.click("text=/Proceed to checkout|Noformēt pasūtījumu/");
  await expect(page).toHaveURL(/\/login\?next=%2Fgrozs$/);

  // Регистрируемся; корзина ждёт на сервере.
  await page.goto("/register");
  await registerViaUi(page, uniq("buyer"));

  // После входа лот на месте (корзины слиты), единственная кнопка ведёт в
  // оплату: заказ рождается только на этом шаге.
  await page.goto("/grozs");
  await expect(page.locator(`text=${title}`)).toBeVisible();
  await page.click("text=/Pay |Apmaksāt /");
  await expect(page).toHaveURL(/\/apmaksa\/A-\d+/);

  // The listing is now sold out for the next visitor.
  await page.goto(`/listing/${listingId}`);
  await expect(page.locator("text=/Sold out|Pārdots/")).toBeVisible();
});
