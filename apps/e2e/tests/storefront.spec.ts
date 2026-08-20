import { expect, test, type Page } from "@playwright/test";
import { bidViaUi, createLiveAuction, placeBidApi, registerBidderApi, uniq } from "./fixtures.js";

/** Register a bidder through the storefront UI (exercises the real flow). */
async function registerViaUi(page: Page, alias: string): Promise<void> {
  await page.goto("/register");
  await page.fill('input[type="email"]', `${alias}@e2e.test`);
  await page.fill('input[placeholder*="Alias"], input[placeholder*="Segvārds"]', alias);
  await page.fill('input[type="password"]', "Bidder123!");
  await page.click('button[type="submit"]');
  // Redirects home; header switches to the signed-in state.
  // После входа в шапке вместо кнопки «Mans konts» — аватар-меню (макет № 11).
  await expect(page.locator(".ava-btn")).toBeVisible();
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
  await bidViaUi(page, minEur);

  await expect(page.locator("text=/You are leading|Jūs vadāt/").first()).toBeVisible();
});

test("storefront: outbid updates live over WebSocket without reload", async ({ page, request }) => {
  const { auctionId } = await createLiveAuction(request, { startPriceCents: 1_000 });

  // Bidder A leads via the UI.
  await registerViaUi(page, uniq("wsA"));
  await page.goto(`/auction/${auctionId}`);
  const detail = await (await request.get(`http://localhost:4000/api/public/auctions/${auctionId}`)).json();
  await bidViaUi(page, (detail.minNextBidCents / 100).toFixed(2));
  await expect(page.locator("text=/You are leading|Jūs vadāt/").first()).toBeVisible();

  // Bidder B outbids via the API; A's open page must reflect the change live.
  const b = await registerBidderApi(request, uniq("wsB"));
  await placeBidApi(request, b.token, auctionId, 500_00); // €500 max — overtakes A

  // Over the WebSocket (no navigation): B's alias appears as the new leader on
  // A's still-open page — the live update arrived without a reload.
  await expect(page.locator(`text=${b.alias}`).first()).toBeVisible({ timeout: 15_000 });
});

test("storefront: sad paths — a below-minimum bid cannot be sent, and the minimum is shown", async ({ page, request }) => {
  const { auctionId } = await createLiveAuction(request, { startPriceCents: 5_000 });
  await registerViaUi(page, uniq("sad"));
  await page.goto(`/auction/${auctionId}`);

  // €0.01 is far below the start price. The redesign refuses it at the button
  // instead of sending it and reporting the server's rejection, so what we
  // check is that the bid cannot leave the page and that the sum it would have
  // to reach is written right underneath. (The server still refuses it too —
  // that rejection is covered by the API tests.)
  const box = page.locator(".bidbox");
  await box.locator("#amt").fill("0.01");
  await expect(box.getByRole("button", { name: /Solīt|Bid/ })).toBeDisabled();
  await expect(box.locator("text=/Next minimum|Nākamais minimums/")).toBeVisible();
});
