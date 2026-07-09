import { expect, test, type Page } from "@playwright/test";
import { createLiveAuction, placeBidApi, registerBidderApi, uniq } from "./fixtures.js";

/** Register a bidder through the storefront UI (exercises the real flow). */
async function registerViaUi(page: Page, alias: string): Promise<void> {
  await page.goto("/register");
  await page.fill('input[type="email"]', `${alias}@e2e.test`);
  await page.fill('input[placeholder*="Alias"], input[placeholder*="Segvārds"]', alias);
  await page.fill('input[type="password"]', "Bidder123!");
  await page.click('button[type="submit"]');
  // Redirects home; header switches to the signed-in state.
  await expect(page.locator("text=/Mans konts|My account|Мой счёт/")).toBeVisible();
}

test("storefront: register, bid, and take the lead", async ({ page, request }) => {
  const { auctionId } = await createLiveAuction(request, { startPriceCents: 1_000 });

  // Signed out, the auction page invites sign-in rather than showing a bid box.
  await page.goto(`/auction/${auctionId}`);
  await expect(page.locator("text=/Sign in to bid|Ienāciet, lai solītu|Войдите/")).toBeVisible();

  await registerViaUi(page, uniq("lead"));
  await page.goto(`/auction/${auctionId}`);

  // Bid the exact minimum the API advertises (+ nothing) and expect the lead.
  const detail = await (await request.get(`http://localhost:4000/api/public/auctions/${auctionId}`)).json();
  const minEur = (detail.minNextBidCents / 100).toFixed(2);
  await page.fill('input[inputmode="decimal"]', minEur);
  await page.click("text=/Place bid|Solīt|ставку/");

  await expect(page.locator("text=/You are leading|Jūs vadāt/").first()).toBeVisible();
});

test("storefront: outbid updates live over WebSocket without reload", async ({ page, request }) => {
  const { auctionId } = await createLiveAuction(request, { startPriceCents: 1_000 });

  // Bidder A leads via the UI.
  await registerViaUi(page, uniq("wsA"));
  await page.goto(`/auction/${auctionId}`);
  const detail = await (await request.get(`http://localhost:4000/api/public/auctions/${auctionId}`)).json();
  await page.fill('input[inputmode="decimal"]', (detail.minNextBidCents / 100).toFixed(2));
  await page.click("text=/Place bid|Solīt/");
  await expect(page.locator("text=/You are leading|Jūs vadāt/").first()).toBeVisible();

  // Bidder B outbids via the API; A's open page must reflect the change live.
  const b = await registerBidderApi(request, uniq("wsB"));
  await placeBidApi(request, b.token, auctionId, 500_00); // €500 max — overtakes A

  // Over the WebSocket (no navigation): B's alias appears as the new leader on
  // A's still-open page — the live update arrived without a reload.
  await expect(page.locator(`text=${b.alias}`).first()).toBeVisible({ timeout: 15_000 });
});

test("storefront: sad paths — below-minimum bid is rejected with the minimum shown", async ({ page, request }) => {
  const { auctionId } = await createLiveAuction(request, { startPriceCents: 5_000 });
  await registerViaUi(page, uniq("sad"));
  await page.goto(`/auction/${auctionId}`);

  // €0.01 is far below the start price → the UI surfaces the minimum bid.
  // The rejection notice includes a colon ("Minimum bid: €50.00"), which
  // distinguishes it from the field label above the input.
  await page.fill('input[inputmode="decimal"]', "0.01");
  await page.click("text=/Place bid|Solīt/");
  await expect(page.locator("text=/Minimum bid:|Minimālais solījums:/")).toBeVisible();
});
