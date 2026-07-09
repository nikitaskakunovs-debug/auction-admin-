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
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("admin_users_email_idx").on(t.email)],
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
    /** Unpaid-winner strikes per the design doc. */
    strikes: integer("strikes").notNull().default(0),
    blocked: boolean("blocked").notNull().default(false),
    notes: text("notes").notNull().default(""),
    erasedAt: timestamp("erased_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("customers_email_idx").on(t.email)],
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
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("orders_ref_idx").on(t.ref), index("orders_status_idx").on(t.status)],
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

/** Named counters (order refs, invoice series) — incremented under row lock. */
export const counters = pgTable("counters", {
  key: text("key").primaryKey(),
  value: bigint("value", { mode: "number" }).notNull().default(0),
});

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
