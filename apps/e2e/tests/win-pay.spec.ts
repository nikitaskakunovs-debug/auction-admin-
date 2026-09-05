import { expect, test, type Page } from "@playwright/test";
import { bidViaUi, createLiveAuction, markOrderPaid, uniq, verifyEmailDb } from "./fixtures.js";

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

test("full journey: register → bid → win → pay → track", async ({ page, request }) => {
  // A short auction with anti-snipe OFF so the scheduler actually closes it
  // during the test (a bid would otherwise extend the end by the snipe window).
  const { auctionId, title } = await createLiveAuction(request, { startPriceCents: 3_000, endsInSec: 8, antiSnipeSec: 0 });

  const alias = uniq("winner");
  await registerViaUi(page, alias);

  await page.goto(`/auction/${auctionId}`);
  const detail = await (await request.get(`http://localhost:4000/api/public/auctions/${auctionId}`)).json();
  await bidViaUi(page, (detail.minNextBidCents / 100).toFixed(2));
  await expect(page.locator("text=/You are leading|Jūs vadāt/").first()).toBeVisible();

  // Wait for the scheduler to close the auction and create the order, then
  // confirm it shows on the orders tab as awaiting payment. The overview only
  // aggregates ("to pay: 1"); the order card with the title lives under Orders.
  await expect
    .poll(
      async () => {
        await page.goto("/account?tab=pirkumi");
        // The orders arrive by an async fetch after hydration: an instant
        // count() right after goto samples the page before the data lands and
        // never sees it. Give each visit a moment for the list to render.
        const seen = await page
          .locator(`text=${title}`)
          .first()
          .waitFor({ state: "visible", timeout: 2_500 })
          .then(() => true, () => false);
        return seen ? await page.locator("text=/Awaiting payment|Gaida apmaksu/").count() : 0;
      },
      { timeout: 45_000, message: "won order did not appear on the account" },
    )
    .toBeGreaterThan(0);

  // Read the order ref off the order card and have Operations mark it paid.
  // The card joins the ref with the date ("A-1024 · 20.08.2026"), so match
  // inside the text rather than demanding the ref be the whole node.
  const refText = (await page.locator(".buy .ref").first().textContent()) ?? "";
  const ref = /A-\d+/.exec(refText)?.[0];
  expect(ref, `order ref in "${refText}"`).toBeTruthy();
  await markOrderPaid(request, ref!);

  // The bidder tracks the payment landing. The redesigned account does not
  // stop at the word "paid": a paid order moves to the pickup tab with the
  // code the warehouse will ask for, which is the thing the customer needs.
  await page.goto("/account?tab=iznemsana");
  await expect(page.locator("text=/Ready for warehouse pickup|Gatavs saņemšanai noliktavā/").first())
    .toBeVisible();
  await expect(page.locator("text=/Pickup code|Saņemšanas kods/").first()).toBeVisible();
});
