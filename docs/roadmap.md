# Izsoli.lv — master roadmap

Merged from: the Shhh feature gap matrix, the approved Phase A design, and the
owner's operational backlog (2026-07-17, RU originals preserved in brackets).
Statuses verified against the codebase as of Phase A2 (177 passing tests).

Legend: ✅ live · 🔨 in progress · 🎯 planned (phase) · 💬 needs design/decision

## Owner backlog → mapping

| # | Item (RU original) | Status | Where it lands |
|---|---|---|---|
| 1 | Live "who is picking what" board [WH сейчас собирают — список кто, что] | ✅ | **W1** — admin Pickup screen: live tickets with claimer name, items, elapsed time |
| 2 | New-pick notification [нотификация на сборку] | ✅ | **W1** — bell + optional sound in admin & wh when a customer checks in |
| 3 | Receive / view / shelf / unshelf + broken-items shelf [раздел принять товар…полка сломанных вещей] | ✅ | Receive/putaway/view live since Ph14-15; **W1** added "pull from shelf" + the QUARANTINE zone for damaged goods |
| 4 | Grading/photo rework with accept flow + notification [переделать оценку, фото] | ✅ | **W2** — worker grades → item enters "review" queue → listing manager approves/edits/rejects with reason → worker notified (banner) |
| 5 | Per-item conversation [переписка по товару — кто что] | ✅ | **W2** — "Saruna" comments thread on the item card (wh + admin) alongside the "Vēsture" history timeline |
| 6 | Condition presets only — standardized reports [пресеты кондиций] | ✅ | **W2** — preset note chips per condition (LV/RU/EN, editable in Settings → Conditions); "Other…" free text tracked |
| 7 | Pick timer + stats + who-did-what [таймер на сборку] | ✅ + 🎯 | **W1** timers shipped + **W3** stats screen |
| 8 | Action log + statistics [лог после каждого действия] | ✅ + 🎯 | Audit + movements + per-item history all live. **W3** — productivity dashboards (picks/hr, receive counts, per-worker) |
| 9 | Slack chat mirroring per channel [переписка через slack] | 💬 | **S1** — events → Slack channels (#orders, #warehouse, #bugs). Needs a Slack app with bot token (like the CI webhook, but richer). Design first |
| 10 | Jira bug tracking with completion notification | 🎯 | **E** — account+project+token ready; design mockup next |
| 11 | Bug report everywhere + logs + screenshot + screen recording | 🎯 | **E** — auto console-log capture + screenshot attach; screen recording via the browser's MediaRecorder where supported |
| 12 | Task handoff between workers [перекидывать таски друг-другу] | 🎯 | **W1** — reassign/release a claimed pick ticket (with audit) |
| 13 | Connect-scanner CTA → phone settings | 🎯 | **W1** (small) — first-run "Connect scanner" card linking the camera-Allow steps per platform |
| 14 | VPN-only access for all devices | 💬 | **SEC** — WireGuard/Tailscale + Caddy allowlist for admin.+wh. hosts. Decision needed: which devices, who manages profiles. Storefront stays public |
| 15 | Bin registration & tracking | ✅ + 🎯 | Bins CRUD + QR labels + movement ledger live. **W3 adds:** bin browser (contents per bin, capacity, last activity) |
| 16 | Collapsible left menu (mobile) | 🎯 | **B** — mobile admin (approved: text-only controls) |
| 17 | Google & Meta tags | 🎯 | **C** — OG/meta/social tags audit + consent-gated GA4 & Meta Pixel toggles (Shhh-style settings) |
| 18 | Front-desk flow design [продумать флоу фронт деск] | 💬 | **W4** — counter workstation: check-in by name/order (no code), handover, payments on the spot. Design session together |
| 19 | Return item flow | 🎯 | **F** — support inbox + return claims (restock fee logic exists) |
| 20 | Report item flow | 🎯 | **F** — customer reports a problem with a received lot → claim thread |

## Phase queue

| Phase | Contents | Gate |
|---|---|---|
| ✅ A1 | Tabs, split view, ⌘K search | shipped |
| ✅ A2 | Orders power screen (views/filters/export/bulk/detail) | shipped |
| 🎯 A3 | Power UI on Inventory/Listings/Bidders/Finance; bidder tags+segments; notifications pills | next unless reordered |
| ✅ W1 | Warehouse ops I: live pick board + notifications + timers + handoff + quarantine + unshelf + scanner CTA | shipped |
| ✅ W2 | Warehouse ops II: grading approval flow + condition preset notes + item chat + changelog tabs | shipped |
| 🎯 W3 | Warehouse ops III: productivity stats + bin browser | next unless reordered |
| 🎯 E | Report-a-problem + Jira (screenshot, recording, chat, status sync) | design page → approve |
| 🎯 B | Mobile-responsive admin + collapsible sidebar | design approved (Phase A artifact §5) |
| 💬 C | Storefront upgrade + Google/Meta tags + GA4/Pixel | waiting on owner's HTML file |
| 🎯 D | LV/RU/EN across all admin screens | any time |
| 🎯 F | Support inbox: returns/report-item claims with email threads | after C |
| 🎯 G | Analytics hub + P&L/receivables | later |
| 🎯 H | Dashboard widget upgrade | later |
| 🎯 I | Help center + guided walkthroughs | later |
| 🎯 J | Settings polish (email signature, notif prefs, store profile) | later |
| 💬 S1 | Slack event mirroring (#orders #warehouse #bugs) | needs Slack bot app |
| 💬 SEC | VPN-only access to admin/wh hosts | needs infra decision |
| 💬 W4 | Front-desk flow | design session |

Standing rule: every phase ships design-first (private mockup page → owner
approval → build → CI → owner runs the droplet update).
