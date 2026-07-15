import { expect, test, type Page } from "@playwright/test";
import { createFixedListing, uniq } from "./fixtures.js";

async function registerViaUi(page: Page, alias: string): Promise<void> {
  await page.goto("/register");
  await page.fill('input[type="email"]', `${alias}@e2e.test`);
  await page.fill('input[placeholder*="Alias"], input[placeholder*="Segvārds"]', alias);
  await page.fill('input[type="password"]', "Bidder123!");
  await page.click('button[type="submit"]');
  await expect(page.locator("text=/Mans konts|My account/")).toBeVisible();
}

test("fixed-price: browse → buy now → order appears on the account", async ({ page, request }) => {
  const { listingId, title } = await createFixedListing(request, { priceCents: 12_000 });

  // Signed out, the listing page invites sign-in instead of a buy button.
  await page.goto(`/listing/${listingId}`);
  await expect(page.locator("text=/Sign in to buy|Ienāciet, lai pirktu/")).toBeVisible();

  await registerViaUi(page, uniq("buyer"));
  await page.goto(`/listing/${listingId}`);
  await page.click("text=/Buy now|Pirkt tagad/");

  // Purchase redirects to the account, where the order shows awaiting payment.
  await expect(page).toHaveURL(/\/account$/);
  await expect(page.locator(`text=${title}`)).toBeVisible();
  await expect(page.locator("text=/Awaiting payment|Gaida apmaksu/")).toBeVisible();

  // The listing is now sold out for the next visitor.
  await page.goto(`/listing/${listingId}`);
  await expect(page.locator("text=/Sold out|Pārdots/")).toBeVisible();
});
