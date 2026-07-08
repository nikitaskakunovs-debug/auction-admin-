import type { BasisPoints } from "./money.js";
import { DEFAULT_INCREMENT_TABLE, type IncrementTable } from "./increments.js";

/**
 * Per-country configuration — the single source of truth the design doc
 * mandates. Adding a country = adding an entry; changing VAT = one edit.
 * Klix credentials and carrier config get real shapes in their own phases;
 * the fields are reserved here so the schema doesn't churn.
 */

export type MarketCode = "LV" | "EE" | "LT";

export interface MarketConfig {
  code: MarketCode;
  name: string;
  currency: "EUR";
  /** national + Russian + English, per the design doc. */
  languages: readonly string[];
  /** Standard VAT rate in basis points. CONFIRM WITH ACCOUNTANT before launch. */
  vatRateBp: BasisPoints;
  /** Buyer's premium in basis points (10% default per doc). */
  buyerPremiumBp: BasisPoints;
  /** Anti-snipe window in seconds (listing can override). */
  antiSnipeSec: number;
  incrementTable: IncrementTable;
  /** Reserved for later phases. */
  klix: null;
  carriers: null;
}

export const DEFAULT_MARKETS: readonly MarketConfig[] = [
  {
    code: "LV",
    name: "Latvia",
    currency: "EUR",
    languages: ["lv", "ru", "en"],
    vatRateBp: 2100,
    buyerPremiumBp: 1000,
    antiSnipeSec: 60,
    incrementTable: DEFAULT_INCREMENT_TABLE,
    klix: null,
    carriers: null,
  },
  {
    code: "EE",
    name: "Estonia",
    currency: "EUR",
    languages: ["et", "ru", "en"],
    // 24% since 2025-07-01 — verify with the accountant per the design doc.
    vatRateBp: 2400,
    buyerPremiumBp: 1000,
    antiSnipeSec: 60,
    incrementTable: DEFAULT_INCREMENT_TABLE,
    klix: null,
    carriers: null,
  },
  {
    code: "LT",
    name: "Lithuania",
    currency: "EUR",
    languages: ["lt", "ru", "en"],
    vatRateBp: 2100,
    buyerPremiumBp: 1000,
    antiSnipeSec: 60,
    incrementTable: DEFAULT_INCREMENT_TABLE,
    klix: null,
    carriers: null,
  },
];

// ── Admin roles — the 7 roles from the design doc, with action-level grants ──

export const ROLE_IDS = [
  "super_admin",
  "listing_manager",
  "sales_manager",
  "operations",
  "content_editor",
  "support",
  "finance",
] as const;
export type RoleId = (typeof ROLE_IDS)[number];

export const PERMISSIONS = [
  // Items / warehouse
  "items.view", "items.create", "items.edit", "items.delete", "items.transition",
  // Listings & auctions
  "listings.view", "listings.create", "listings.edit", "listings.publish",
  "listings.set_pricing", // start price, reserve, increments — commercial
  "auctions.view", "auctions.monitor", "auctions.extend", "auctions.cancel", "auctions.void_bid", "auctions.relist",
  // Orders & fulfilment
  "orders.view", "orders.mark_paid", "orders.fulfil", "orders.refund", "orders.cancel_unpaid",
  // Customers / bidders
  "customers.view", "customers.edit", "customers.strike", "customers.erase",
  // Content
  "content.view", "content.edit",
  // Finance
  "finance.view", "invoices.view", "invoices.issue",
  // Reports
  "reports.view",
  // Administration
  "settings.view", "settings.edit", "team.view", "team.manage", "roles.manage",
  "markets.view", "markets.edit", "audit.view",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const ALL: readonly Permission[] = PERMISSIONS;

/**
 * Default permission sets per the design doc's role table. Super Admin can
 * edit this matrix at runtime (stored in role_permissions); these are seeds.
 */
export const DEFAULT_ROLE_PERMISSIONS: Readonly<Record<RoleId, readonly Permission[]>> = {
  super_admin: ALL,
  // Operational: item data, warehouse, publishing
  listing_manager: [
    "items.view", "items.create", "items.edit", "items.delete", "items.transition",
    "listings.view", "listings.create", "listings.edit", "listings.publish",
    "auctions.view", "auctions.monitor", "auctions.relist",
    "reports.view", "audit.view",
  ],
  // Commercial: pricing, reserves, promotions, analytics
  sales_manager: [
    "items.view",
    "listings.view", "listings.edit", "listings.set_pricing",
    "auctions.view", "auctions.monitor", "auctions.extend",
    "customers.view",
    "reports.view", "finance.view", "audit.view",
  ],
  // Orders, payments, pick/pack, labels, refunds
  operations: [
    "items.view", "items.transition",
    "auctions.view",
    "orders.view", "orders.mark_paid", "orders.fulfil", "orders.refund", "orders.cancel_unpaid",
    "customers.view", "customers.strike",
    "reports.view", "audit.view",
  ],
  // CMS pages only
  content_editor: [
    "content.view", "content.edit",
  ],
  // View users/orders, buyer queries, limited refunds
  support: [
    "items.view", "listings.view", "auctions.view",
    "orders.view", "orders.refund",
    "customers.view", "customers.edit",
    "audit.view",
  ],
  // Invoices, VAT reports, reconciliation — read-only elsewhere
  finance: [
    "items.view", "listings.view", "auctions.view", "orders.view", "customers.view",
    "finance.view", "invoices.view", "invoices.issue", "reports.view", "audit.view",
  ],
};

export const ROLE_LABELS: Readonly<Record<RoleId, string>> = {
  super_admin: "Super Admin",
  listing_manager: "Listing Manager",
  sales_manager: "Sales Manager",
  operations: "Operations",
  content_editor: "Content Editor",
  support: "Support",
  finance: "Finance",
};
