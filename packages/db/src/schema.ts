import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Schema shapes quarried from the Shhh admin's db/schema.sql (markets,
 * admin_roles/role_permissions/admin_users, orders + snapshot pattern,
 * append-only audit_log) and auction-ized per the V1.8_Green design doc.
 * All money columns are integer euro cents.
 */

// ── Per-country config (single source of truth) ─────────────────────────────

export const markets = pgTable("markets", {
  code: text("code").primaryKey(), // 'LV' | 'EE' | 'LT'
  name: text("name").notNull(),
  /** Legal entity printed on invoices for this market. */
  legalName: text("legal_name").notNull().default(""),
  currency: text("currency").notNull().default("EUR"),
  languages: jsonb("languages").$type<string[]>().notNull(),
  vatRateBp: integer("vat_rate_bp").notNull(),
  buyerPremiumBp: integer("buyer_premium_bp").notNull(),
  antiSnipeSec: integer("anti_snipe_sec").notNull().default(60),
  incrementTable: jsonb("increment_table")
    .$type<Array<{ fromCents: number; incrementCents: number }>>()
    .notNull(),
  /** Days after payment the client has to collect (pickup fulfilment). */
  pickupDeadlineDays: integer("pickup_deadline_days").notNull().default(14),
  /** No-show restock fee in basis points of the paid total (5% = 500). */
  restockFeeBp: integer("restock_fee_bp").notNull().default(500),
  active: boolean("active").notNull().default(true),
});

// ── Admin identity & RBAC ────────────────────────────────────────────────────

export const adminRoles = pgTable("admin_roles", {
  id: text("id").primaryKey(), // 'super_admin', 'listing_manager', …
  label: text("label").notNull(),
  description: text("description").notNull().default(""),
});

export const rolePermissions = pgTable(
  "role_permissions",
  {
    roleId: text("role_id")
      .notNull()
      .references(() => adminRoles.id, { onDelete: "cascade" }),
    permission: text("permission").notNull(),
  },
  (t) => [primaryKey({ columns: [t.roleId, t.permission] })],
);

export const adminUsers = pgTable(
  "admin_users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull(),
    name: text("name").notNull(),
    passwordHash: text("password_hash").notNull(),
    roleId: text("role_id")
      .notNull()
      .references(() => adminRoles.id),
    active: boolean("active").notNull().default(true),
    /** Base32 TOTP shared secret. Set at enrollment; kept while 2FA is on. */
    totpSecret: text("totp_secret"),
    /** Whether TOTP two-factor is active for this admin (enrollment complete). */
    totpEnabled: boolean("totp_enabled").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("admin_users_email_idx").on(t.email)],
);

/**
 * One-time recovery codes for admins who lose their authenticator. Stored as
 * SHA-256 hashes; a row is burned (used_at set) the first time it is redeemed.
 */
export const adminRecoveryCodes = pgTable(
  "admin_recovery_codes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => adminUsers.id, { onDelete: "cascade" }),
    codeHash: text("code_hash").notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("admin_recovery_codes_user_idx").on(t.userId)],
);

export const refreshTokens = pgTable(
  "refresh_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => adminUsers.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("refresh_tokens_user_idx").on(t.userId)],
);

export const customerRefreshTokens = pgTable(
  "customer_refresh_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("customer_refresh_tokens_customer_idx").on(t.customerId)],
);

// ── Bidders / customers ──────────────────────────────────────────────────────

export const customers = pgTable(
  "customers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull(),
    /** Public display name shown in bid ledgers. */
    alias: text("alias").notNull(),
    /** Full name — erasable for GDPR while orders keep their snapshots. */
    name: text("name"),
    country: text("country"),
    marketCode: text("market_code").references(() => markets.code),
    company: text("company"),
    vatNo: text("vat_no"),
    /** Latest VIES consultation: { valid, checkedAt, consult }. */
    vies: jsonb("vies").$type<{ valid: boolean; checkedAt: string; consult: string } | null>(),
    /** Set when the bidder registered on the storefront; null = admin-created record. */
    passwordHash: text("password_hash"),
    /** Unpaid-winner strikes per the design doc. */
    strikes: integer("strikes").notNull().default(0),
    blocked: boolean("blocked").notNull().default(false),
    notes: text("notes").notNull().default(""),
    erasedAt: timestamp("erased_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("customers_email_idx").on(t.email)],
);

// ── Warehouse ERP: structured locations + movement ledger ───────────────────

/** A physical slot: zone (FRONT/BACK/…) → aisle → rack → shelf. */
export const warehouseLocations = pgTable(
  "warehouse_locations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    zone: text("zone").notNull(), // 'FRONT' | 'BACK' | custom
    aisle: text("aisle").notNull().default(""),
    rack: text("rack").notNull().default(""),
    shelf: text("shelf").notNull().default(""),
    /** Human label, e.g. 'FRONT-A1-R2-S3' — printed on the shelf edge. */
    label: text("label").notNull(),
    notes: text("notes").notNull().default(""),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("warehouse_locations_label_idx").on(t.label)],
);

/**
 * Append-only movement ledger — every physical change of custody or place:
 * intake | putaway | move | pick | restock | handover | adjust.
 */
export const stockMovements = pgTable(
  "stock_movements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    itemId: uuid("item_id")
      .notNull()
      .references(() => items.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    fromLocationId: uuid("from_location_id").references(() => warehouseLocations.id),
    toLocationId: uuid("to_location_id").references(() => warehouseLocations.id),
    actorId: uuid("actor_id").references(() => adminUsers.id),
    /** Display snapshot ('System' for scheduler moves). */
    actorLabel: text("actor_label").notNull().default("System"),
    reason: text("reason").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("stock_movements_item_idx").on(t.itemId, t.createdAt)],
);

// ── Warehouse items ──────────────────────────────────────────────────────────

export const items = pgTable(
  "items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sku: text("sku").notNull(),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    condition: text("condition").notNull().default("good"),
    location: text("location").notNull().default(""),
    /** Structured bin; the free-text `location` stays as display fallback. */
    locationId: uuid("location_id").references(() => warehouseLocations.id),
    weightGrams: integer("weight_grams"),
    /** { l, w, h } in cm. */
    dims: jsonb("dims").$type<{ l: number; w: number; h: number } | null>(),
    photos: jsonb("photos").$type<string[]>().notNull().default([]),
    /** Warehouse lifecycle state (domain ItemStatus). */
    status: text("status").notNull().default("draft"),
    marketCode: text("market_code")
      .notNull()
      .references(() => markets.code),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("items_sku_idx").on(t.sku), index("items_status_idx").on(t.status)],
);

// ── Listings (auction or fixed-price) ────────────────────────────────────────

export const listings = pgTable(
  "listings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    itemId: uuid("item_id")
      .notNull()
      .references(() => items.id),
    type: text("type").notNull(), // 'auction' | 'fixed'
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    marketCode: text("market_code")
      .notNull()
      .references(() => markets.code),
    startPriceCents: integer("start_price_cents"),
    /** Hidden reserve — never exposed through public APIs. */
    reserveCents: integer("reserve_cents"),
    /** Fixed-price listings. */
    priceCents: integer("price_cents"),
    quantity: integer("quantity").notNull().default(1),
    /** Per-listing anti-snipe override; null = market default. */
    antiSnipeSec: integer("anti_snipe_sec"),
    status: text("status").notNull().default("draft"), // draft | published | archived
    createdBy: uuid("created_by").references(() => adminUsers.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("listings_status_idx").on(t.status), index("listings_item_idx").on(t.itemId)],
);

// ── Auctions (one run of an auction listing; relist = new row) ─────────────

export const auctions = pgTable(
  "auctions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    listingId: uuid("listing_id")
      .notNull()
      .references(() => listings.id),
    status: text("status").notNull().default("scheduled"), // domain AuctionStatus
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    /** Displayed price; null until the first bid. */
    currentPriceCents: integer("current_price_cents"),
    leaderCustomerId: uuid("leader_customer_id").references(() => customers.id),
    /** Leading proxy max — HIDDEN, never exposed publicly. */
    leaderMaxCents: integer("leader_max_cents"),
    leaderSeq: bigint("leader_seq", { mode: "number" }),
    bidCount: integer("bid_count").notNull().default(0),
    extensions: integer("extensions").notNull().default(0),
    reserveMet: boolean("reserve_met").notNull().default(false),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("auctions_status_ends_idx").on(t.status, t.endsAt),
    index("auctions_listing_idx").on(t.listingId),
  ],
);

// ── Bids — append-only ledger ────────────────────────────────────────────────

export const bids = pgTable(
  "bids",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    auctionId: uuid("auction_id")
      .notNull()
      .references(() => auctions.id),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id),
    /** Visible ledger amount. */
    amountCents: integer("amount_cents").notNull(),
    /** The bidder's hidden max at this moment (audit only). */
    maxCents: integer("max_cents").notNull(),
    /** Placed by the proxy system on the bidder's behalf. */
    auto: boolean("auto").notNull().default(false),
    outbid: boolean("outbid").notNull().default(false),
    /** Per-auction ordering (auction.bid_count at insert). */
    seq: integer("seq").notNull(),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    voidReason: text("void_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("bids_auction_idx").on(t.auctionId, t.seq)],
);

// ── Orders / refunds / invoices ──────────────────────────────────────────────

export const orders = pgTable(
  "orders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ref: text("ref").notNull(), // human ref, e.g. 'A-1042'
    auctionId: uuid("auction_id").references(() => auctions.id),
    listingId: uuid("listing_id")
      .notNull()
      .references(() => listings.id),
    itemId: uuid("item_id")
      .notNull()
      .references(() => items.id),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id),
    /** Snapshots surviving customer GDPR erasure (Shhh pattern). */
    customerAlias: text("customer_alias").notNull(),
    customerEmail: text("customer_email").notNull(),
    marketCode: text("market_code")
      .notNull()
      .references(() => markets.code),
    hammerCents: integer("hammer_cents").notNull(),
    premiumCents: integer("premium_cents").notNull(),
    vatCents: integer("vat_cents").notNull(),
    vatRateBp: integer("vat_rate_bp").notNull(),
    shippingCents: integer("shipping_cents").notNull().default(0),
    totalCents: integer("total_cents").notNull(),
    reverseCharge: boolean("reverse_charge").notNull().default(false),
    status: text("status").notNull().default("awaiting_payment"), // awaiting_payment | paid | cancelled | refunded
    paymentDeadlineAt: timestamp("payment_deadline_at", { withTimezone: true }),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    /** Why a cancelled order was cancelled: 'unpaid' | 'no_pickup' | manual text. */
    cancelReason: text("cancel_reason"),
    /** 6-digit collection credential, set at mark-paid (pickup fulfilment). */
    pickupCode: text("pickup_code"),
    pickupDeadlineAt: timestamp("pickup_deadline_at", { withTimezone: true }),
    /** Retained no-show restock fee (5% of total by default). */
    restockFeeCents: integer("restock_fee_cents"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("orders_ref_idx").on(t.ref), index("orders_status_idx").on(t.status)],
);

// ── Pickup tickets (one customer visit; drives the waiting-room boards) ─────

export const pickupTickets = pgTable(
  "pickup_tickets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Board number, 100–999, reset daily via the counters row lock. */
    number: integer("number").notNull(),
    dayKey: text("day_key").notNull(), // UTC date, e.g. '2026-07-14'
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id),
    status: text("status").notNull().default("waiting"), // domain TicketStatus
    checkedInVia: text("checked_in_via").notNull().default("desk"), // 'kiosk' | 'desk'
    claimedById: uuid("claimed_by_id").references(() => adminUsers.id),
    checkedInAt: timestamp("checked_in_at", { withTimezone: true }).notNull().defaultNow(),
    pickingStartedAt: timestamp("picking_started_at", { withTimezone: true }),
    deliveringAt: timestamp("delivering_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    cancelReason: text("cancel_reason"),
  },
  (t) => [
    uniqueIndex("pickup_tickets_day_number_idx").on(t.dayKey, t.number),
    index("pickup_tickets_status_idx").on(t.status, t.checkedInAt),
    index("pickup_tickets_customer_idx").on(t.customerId),
  ],
);

/** One line per item on the ticket (an order is exactly one item today). */
export const pickupTicketItems = pgTable(
  "pickup_ticket_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ticketId: uuid("ticket_id")
      .notNull()
      .references(() => pickupTickets.id, { onDelete: "cascade" }),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id),
    itemId: uuid("item_id")
      .notNull()
      .references(() => items.id),
    status: text("status").notNull().default("pending"), // domain PickLineStatus
    pickedAt: timestamp("picked_at", { withTimezone: true }),
    pickedById: uuid("picked_by_id").references(() => adminUsers.id),
  },
  (t) => [index("pickup_ticket_items_ticket_idx").on(t.ticketId)],
);

export const refunds = pgTable(
  "refunds",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    amountCents: integer("amount_cents").notNull(),
    reason: text("reason").notNull(),
    actorId: uuid("actor_id").references(() => adminUsers.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("refunds_order_idx").on(t.orderId)],
);

export const invoices = pgTable(
  "invoices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id),
    /** Sequential per series, e.g. 'LV-2026-00042'. */
    number: text("number").notNull(),
    series: text("series").notNull(),
    /** Full InvoiceBreakdown snapshot at issue time. */
    data: jsonb("data").notNull(),
    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("invoices_number_idx").on(t.number)],
);

/**
 * Restock-fee ledger. A no-pickup fee is deducted from the held funds and
 * lands here already `settled`; an unpaid-winner fee is a claim we hold no
 * money for, so it starts `outstanding` — and outstanding fees block the
 * customer from bidding/buying until settled (or waived, with a reason).
 */
export const customerFees = pgTable(
  "customer_fees",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id),
    /** Order ref snapshot for display after GDPR erasure of relations. */
    orderRef: text("order_ref").notNull(),
    type: text("type").notNull(), // 'unpaid_restock' | 'no_pickup_restock'
    amountCents: integer("amount_cents").notNull(),
    status: text("status").notNull().default("outstanding"), // outstanding | settled | waived
    note: text("note").notNull().default(""),
    settledById: uuid("settled_by_id").references(() => adminUsers.id),
    settledAt: timestamp("settled_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("customer_fees_customer_idx").on(t.customerId, t.status),
    index("customer_fees_order_idx").on(t.orderId),
  ],
);

/** Named counters (order refs, invoice series) — incremented under row lock. */
export const counters = pgTable("counters", {
  key: text("key").primaryKey(),
  value: bigint("value", { mode: "number" }).notNull().default(0),
});

// ── CMS pages (Shhh editor architecture, persistence in Postgres) ───────────

/** One localized string per storefront language; lv is the fallback. */
export type CmsLocalized = { lv: string; ru: string; en: string };

export type CmsBlock =
  | { type: "heading"; text: CmsLocalized }
  | { type: "text"; text: CmsLocalized }
  | { type: "image"; url: string; alt: CmsLocalized }
  | { type: "faq"; question: CmsLocalized; answer: CmsLocalized }
  | { type: "divider" };

export const cmsPages = pgTable(
  "cms_pages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** URL path segment, e.g. "about", "terms". */
    slug: text("slug").notNull(),
    title: jsonb("title").$type<CmsLocalized>().notNull(),
    blocks: jsonb("blocks").$type<CmsBlock[]>().notNull().default([]),
    /** Per-page SEO: meta title/description per language. */
    seo: jsonb("seo").$type<{ title: CmsLocalized; description: CmsLocalized }>(),
    status: text("status").notNull().default("draft"), // draft | published
    /** Show in the storefront footer navigation. */
    inFooter: boolean("in_footer").notNull().default(true),
    position: integer("position").notNull().default(0),
    updatedBy: uuid("updated_by").references(() => adminUsers.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("cms_pages_slug_idx").on(t.slug), index("cms_pages_status_idx").on(t.status)],
);

// ── Notifications outbox ─────────────────────────────────────────────────────

/**
 * Durable notification outbox. Rows are enqueued (often inside the triggering
 * transaction so they can't be lost) and drained by the dispatcher, which
 * hands each to the configured email adapter. The recipient email is
 * snapshotted at enqueue time so a later GDPR erase never re-mails anyone.
 */
export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    customerId: uuid("customer_id").references(() => customers.id, { onDelete: "set null" }),
    type: text("type").notNull(), // outbid | won | payment_reminder | order_paid
    channel: text("channel").notNull().default("email"),
    toEmail: text("to_email").notNull(),
    lang: text("lang").notNull().default("en"),
    subject: text("subject").notNull(),
    body: text("body").notNull(),
    /** Optional idempotency key — a partial unique index rejects duplicates. */
    dedupeKey: text("dedupe_key"),
    status: text("status").notNull().default("pending"), // pending | sent | failed
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("notifications_status_idx").on(t.status, t.createdAt),
    uniqueIndex("notifications_dedupe_idx").on(t.dedupeKey),
  ],
);

// ── Append-only audit log ────────────────────────────────────────────────────

export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    actorId: uuid("actor_id").references(() => adminUsers.id),
    /** Display snapshot surviving user deletion. */
    actorLabel: text("actor_label").notNull(),
    type: text("type").notNull(), // area: auction | listing | item | order | customer | settings | team | finance | content
    action: text("action").notNull(),
    target: text("target").notNull().default(""),
    detail: jsonb("detail"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("audit_log_type_idx").on(t.type, t.createdAt)],
);
