# 08 — Screen tour

Screenshots captured from the running stack with seeded demo data
(`docs/screenshots/`). Demo bidder aliases and lots are synthetic.

## Admin panel (`admin.izsoli.lv`)

### Sign-in — mandatory 2FA
Two-step: password → TOTP from an authenticator app, with "trust this
browser 30 days" and recovery-code fallback. LV/RU/EN.

![Login](../screenshots/admin-login.png)

### Dashboard
Live KPI tiles (live auctions, ending soon, awaiting payment, 30-day GMV,
24 h bids) + live-now table + warehouse pipeline; refreshes on WebSocket
events.

![Dashboard](../screenshots/admin-dashboard.png)

### Auctions & live monitor
List with status pills and countdowns; the monitor is the operator cockpit —
real-time bid ledger with proxy/outbid chips, extend, cancel, and per-bid
void, every action demanding an audited reason.

![Auctions](../screenshots/admin-auctions.png)
![Auction monitor](../screenshots/admin-auction-monitor.png)

### Listings · Inventory · Receiving
Power lists (saved views, filter chips, bulk bar, CSV/XLS/PDF export).
Listings holds the ready-to-list queue and pricing (reserve behind
`listings.set_pricing`). Inventory groups lots by lifecycle with a drawer for
photos, grading, chat + history, labels. Receiving covers consignments,
the grading-review queue and the bins browser.

![Listings](../screenshots/admin-listings.png)
![Inventory](../screenshots/admin-inventory.png)
![Receiving](../screenshots/admin-receiving.png)

### Orders · Pickup · Stats
Orders: power list + full-page detail (mark paid, refund, cancel+strike,
shipping label, invoice breakdown). Pickup: desk check-in, ticket claim,
pick-path list, code-verified handover. Stats: W3 per-worker productivity.

![Orders](../screenshots/admin-orders.png)
![Pickup](../screenshots/admin-pickup.png)
![Stats](../screenshots/admin-whstats.png)

### Bidders · Finance · Content
Bidders: strikes, suspensions, VIES checks, tags, restock fees, GDPR erase.
Finance: payments / invoice register (printable) / VAT report with CSV.
Content: multilingual CMS block editor.

![Bidders](../screenshots/admin-customers.png)
![Finance](../screenshots/admin-finance.png)
![Content](../screenshots/admin-content.png)

### Settings · Notifications · Activity · Security
Settings: markets (VAT/premium/increments/anti-snipe), team, the editable
7-role permission matrix, condition presets, tags. Notifications: the email
outbox. Activity: the audit trail + the Bugs tab (Jira-mirrored problem
reports with live IT chat). Security: own password + recovery codes.

![Settings](../screenshots/admin-settings.png)
![Notifications](../screenshots/admin-notifications.png)
![Activity](../screenshots/admin-activity.png)
![Security](../screenshots/admin-security.png)

## Warehouse phone mode (`wh.izsoli.lv` / `#/wh`)
Phone-first PWA for floor workers: scan/lookup, receive, putaway, pick
queue, bins, shift status, grading notices, camera QR scanning. Fully in
Latvian/Russian/English.

![Warehouse mode](../screenshots/warehouse-home.png)

## Waiting-room TV (`#/board`) — no login
PII-free picking-progress board polled every 3 s; a second view
(`#/board/delivering`) shows "NOW DELIVERING" ticket numbers.

![TV board](../screenshots/admin-tv-board.png)

## Storefront (`izsoli.lv`)

Home with search + category chips + live auctions + buy-now; the live lot
page (WebSocket price updates, proxy-bid box with exact minimum, sanitized
ledger); fixed-price lot; the public condition reference; bidder sign-in;
CMS pages.

![Home](../screenshots/web-home.png)
![Live auction](../screenshots/web-auction.png)
![Buy now](../screenshots/web-listing.png)
![Conditions](../screenshots/web-conditions.png)
![Login](../screenshots/web-login.png)
![CMS page](../screenshots/web-cms-about.png)

## Kiosk (`izsoli.lv/kiosk`)
Wall-tablet check-in: type or scan the 6-digit pickup code; prints nothing,
mints the day's 3-digit ticket the TV boards track.

![Kiosk](../screenshots/web-kiosk.png)
