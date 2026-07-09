import { expect, test, type Page } from "@playwright/test";
import { createLiveAuction, markOrderPaid, uniq } from "./fixtures.js";

async function registerViaUi(page: Page, alias: string): Promise<void> {
  await page.goto("/register");
  await page.fill('input[type="email"]', `${alias}@e2e.test`);
  await page.fill('input[placeholder*="Alias"], input[placeholder*="Segvārds"]', alias);
  await page.fill('input[type="password"]', "Bidder123!");
  await page.click('button[type="submit"]');
  await expect(page.locator("text=/Mans konts|My account/")).toBeVisible();
}

test("full journey: register → bid → win → pay → track", async ({ page, request }) => {
  // A short auction with anti-snipe OFF so the scheduler actually closes it
  // during the test (a bid would otherwise extend the end by the snipe window).
  const { auctionId, title } = await createLiveAuction(request, { startPriceCents: 3_000, endsInSec: 8, antiSnipeSec: 0 });

  const alias = uniq("winner");
  await registerViaUi(page, alias);

  await page.goto(`/auction/${auctionId}`);
  const detail = await (await request.get(`http://localhost:4000/api/public/auctions/${auctionId}`)).json();
  await page.fill('input[inputmode="decimal"]', (detail.minNextBidCents / 100).toFixed(2));
  await page.click("text=/Place bid|Solīt/");
  await expect(page.locator("text=/You are leading|Jūs vadāt/").first()).toBeVisible();

  // Wait for the scheduler to close the auction and create the order, then
  // confirm it shows on the bidder's account as awaiting payment.
  await expect
    .poll(
      async () => {
        await page.goto("/account");
        return (await page.locator(`text=${title}`).count()) > 0
          ? await page.locator("text=/Awaiting payment|Gaida apmaksu/").count()
          : 0;
      },
      { timeout: 30_000, message: "won order did not appear on the account" },
    )
    .toBeGreaterThan(0);

  // Read the order ref off the account page and have Operations mark it paid.
  const refText = await page.locator("text=/^A-\\d+$/").first().textContent();
  expect(refText).toMatch(/A-\d+/);
  await markOrderPaid(request, refText!.trim());

  // The bidder tracks the status flipping to paid.
  await page.reload();
  await expect(page.locator("text=/Paid|Apmaksāts/")).toBeVisible();
});
