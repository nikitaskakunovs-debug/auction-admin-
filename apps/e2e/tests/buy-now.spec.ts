import { expect, test, type Page } from "@playwright/test";
import { createFixedListing, uniq, verifyEmailDb } from "./fixtures.js";

async function registerViaUi(page: Page, alias: string): Promise<void> {
  await page.goto("/register");
  await page.fill('input[type="email"]', `${alias}@e2e.test`);
  await page.fill('input[placeholder*="Alias"], input[placeholder*="Segvārds"]', alias);
  await page.fill('input[type="password"]', "Bidder123!");
  await page.click('button[type="submit"]');
  // После входа в шапке вместо кнопки «Mans konts» — аватар-меню (макет № 11).
  await expect(page.locator(".ava-btn")).toBeVisible();
  // Почту подтверждаем в базе: без этого ставки и покупка закрыты.
  await verifyEmailDb(`${alias}@e2e.test`);
}

test("fixed-price: browse → buy now → order appears on the account", async ({ page, request }) => {
  const { listingId, title } = await createFixedListing(request, { priceCents: 12_000 });

  // Signed out, the listing page invites sign-in instead of a buy button.
  await page.goto(`/listing/${listingId}`);
  await expect(page.locator("text=/Sign in to buy|Ienāciet, lai pirktu/")).toBeVisible();

  await registerViaUi(page, uniq("buyer"));
  await page.goto(`/listing/${listingId}`);
  await page.click("text=/Buy now|Pirkt tagad/");

  // Spending money now takes two clicks: the button opens a dialog showing the
  // price and the VAT before anything is charged, and only the button inside it
  // buys. Worth the extra step, and worth the extra line here.
  await page.click("text=/Buy and go to payment|Pirkt un pāriet uz apmaksu/");

  // Purchase redirects straight to the orders tab, where the new order
  // shows awaiting payment (the overview has no card for it).
  await expect(page).toHaveURL(/\/account\?tab=pirkumi$/);
  await expect(page.locator(`text=${title}`)).toBeVisible();
  // The redesigned account says it twice — a section heading and a tag on the
  // card — so take the first rather than demanding there be only one.
  await expect(page.locator("text=/Awaiting payment|Gaida apmaksu/").first()).toBeVisible();

  // The listing is now sold out for the next visitor.
  await page.goto(`/listing/${listingId}`);
  await expect(page.locator("text=/Sold out|Pārdots/")).toBeVisible();
});
