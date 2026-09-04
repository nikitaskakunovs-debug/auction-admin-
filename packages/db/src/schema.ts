import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
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
  /** Omniva parcel-machine delivery price for this market (flat, €3.99). */
  omnivaPmPriceCents: integer("omniva_pm_price_cents").notNull().default(399),
  /** DPD parcel-locker delivery price for this market (flat, €3.99). */
  dpdPmPriceCents: integer("dpd_pm_price_cents").notNull().default(399),
  /** Courier delivery to a street address (flat, €6.90). */
  courierPriceCents: integer("courier_price_cents").notNull().default(690),
  /**
   * Declared-value cover the buyer may add at checkout: basis points of the
   * goods total, never below the floor. Insurance is NOT part of the buyer
   * premium and does not change the VAT already computed on the hammer.
   */
  insuranceBp: integer("insurance_bp").notNull().default(100),
  insuranceMinCents: integer("insurance_min_cents").notNull().default(100),
  /**
   * Packing/handling fee added on top of carrier delivery (flat, €2.00).
   * Like shipping, it is NEVER part of the 10% buyer premium — the premium
   * applies to the hammer price only.
   */
  handlingFeeCents: integer("handling_fee_cents").notNull().default(200),
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

/** Browsers where the admin completed 2FA and chose "trust this device":
 * while unexpired, the TOTP step is skipped on login (password still required). */
export const trustedDevices = pgTable(
  "trusted_devices",
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
  (t) => [index("trusted_devices_user_idx").on(t.userId), index("trusted_devices_token_idx").on(t.tokenHash)],
);

/** Small key-value store for business settings edited in the admin UI
 * (grading-review scope, pick targets, …) — not for secrets. */
export const appSettings = pgTable("app_settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").$type<unknown>().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Standardized condition-note presets per grade (W2): workers pick chips,
 * never type — so every lot's condition report reads the same way in all
 * three languages. Editable in admin Settings → Conditions. */
export const conditionPresets = pgTable(
  "condition_presets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Which condition grade this preset belongs to (domain condition code). */
    conditionCode: text("condition_code").notNull(),
    textLv: text("text_lv").notNull(),
    textRu: text("text_ru").notNull(),
    textEn: text("text_en").notNull(),
    position: integer("position").notNull().default(0),
    active: boolean("active").notNull().default(true),
  },
  (t) => [index("condition_presets_code_idx").on(t.conditionCode, t.position)],
);

/** Per-item conversation between warehouse and admin — the "who said what"
 * record; one thread per item, visible on both surfaces. */
export const itemComments = pgTable(
  "item_comments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    itemId: uuid("item_id")
      .notNull()
      .references(() => items.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => adminUsers.id),
    /** Display snapshot surviving user deletion. */
    authorLabel: text("author_label").notNull(),
    body: text("body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("item_comments_item_idx").on(t.itemId, t.createdAt)],
);

/** Per-user read cursor for item threads — drives the unread dots. */
export const itemCommentReads = pgTable(
  "item_comment_reads",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => adminUsers.id, { onDelete: "cascade" }),
    itemId: uuid("item_id")
      .notNull()
      .references(() => items.id, { onDelete: "cascade" }),
    lastReadAt: timestamp("last_read_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("item_comment_reads_pk").on(t.userId, t.itemId)],
);

/** Warehouse shift presence — one row per admin per day, updated in place.
 * Statuses: working | coffee | lunch | done. Set from the warehouse phone;
 * shown on the admin live board; every change is audited. */
export const workerStatus = pgTable(
  "worker_status",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => adminUsers.id, { onDelete: "cascade" }),
    dayKey: text("day_key").notNull(), // UTC date, e.g. '2026-07-29'
    status: text("status").notNull().default("working"),
    /** When the current status began (drives the break/lunch elapsed timer). */
    sinceAt: timestamp("since_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("worker_status_user_day_idx").on(t.userId, t.dayKey)],
);

/** Named filter presets ("saved views") per admin per screen — synced to the
 * account so a view saved on the laptop appears on the phone too. */
export const savedViews = pgTable(
  "saved_views",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => adminUsers.id, { onDelete: "cascade" }),
    /** Which list screen the view belongs to: 'orders' | 'inventory' | … */
    screen: text("screen").notNull(),
    name: text("name").notNull(),
    /** The complete filter state, opaque to the server. */
    filters: jsonb("filters").$type<Record<string, unknown>>().notNull(),
    position: integer("position").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("saved_views_user_screen_idx").on(t.userId, t.screen)],
);

/** Single-use, short-lived password-reset tokens for admins AND customers
 * (exactly one of user_id / customer_id is set). Only the hash is stored. */
export const passwordResets = pgTable(
  "password_resets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").references(() => adminUsers.id, { onDelete: "cascade" }),
    customerId: uuid("customer_id").references(() => customers.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("password_resets_token_idx").on(t.tokenHash)],
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
    /** Экран «Drošība»: устройство, адрес и последняя активность сессии. */
    ua: text("ua"),
    ip: text("ip"),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("customer_refresh_tokens_customer_idx").on(t.customerId)],
);

// ── Bidders / customers ──────────────────────────────────────────────────────

/** A3: managed bidder-tag vocabulary (Settings → Tags). Colors are palette
 * keys (gold|green|blue|red|orange|grey) the admin maps to chip styles. */
export const customerTagDefs = pgTable(
  "customer_tag_defs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    color: text("color").notNull().default("grey"),
    position: integer("position").notNull().default(0),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("customer_tag_defs_name_idx").on(t.name)],
);

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
    /** Preferred email language (lv | ru | en), captured from the storefront
     * the customer registered on. Null falls back to the country: Latvia is
     * written to in Latvian, everyone else in English. Latvia has a large
     * Russian-speaking population, and country alone cannot tell us. */
    lang: text("lang"),
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
    /** Why the account is disabled (zero-tolerance / fraud / GDPR erase …). */
    blockedReason: text("blocked_reason"),
    blockedAt: timestamp("blocked_at", { withTimezone: true }),
    /** A3: customer_tag_defs ids (order irrelevant; defs carry position). */
    tags: jsonb("tags").$type<string[]>().notNull().default([]),
    notes: text("notes").notNull().default(""),
    /* ── Согласие на маркетинг ──────────────────────────────────────────
     * Отдельно от cookie: cookie — про сайт, это — про право написать
     * человеку письмо. По GDPR (ст. 7 п. 1) согласие нужно уметь доказать,
     * поэтому хранится не только флаг, но и когда и откуда он взялся.
     * Отсутствие согласия — это false, а не null: молчание согласием не
     * является. */
    marketingOptIn: boolean("marketing_opt_in").notNull().default(false),
    marketingOptInAt: timestamp("marketing_opt_in_at", { withTimezone: true }),
    /** Где человек согласился: register | account | checkout | admin | import. */
    marketingSource: text("marketing_source"),
    /** Когда согласие отозвали. Строку не чистим — отзыв тоже надо доказывать. */
    marketingOptOutAt: timestamp("marketing_opt_out_at", { withTimezone: true }),
    /** Отписка по ссылке из письма (List-Unsubscribe или подвал). Отдельно от
     * marketingOptOut: то — решение в кабинете, это — из самого письма, и
     * почтовики требуют, чтобы оно срабатывало без входа в аккаунт. */
    unsubscribedAt: timestamp("unsubscribed_at", { withTimezone: true }),
    /** Адрес отбился навсегда — больше не пишем никогда, ни маркетинг, ни
     * сервис: продолжать бить в мёртвый ящик значит терять репутацию домена. */
    emailBouncedAt: timestamp("email_bounced_at", { withTimezone: true }),
    /** Подтверждение почты. У существующих клиентов заполняется миграцией —
     * они уже торговали, запирать их задним числом нельзя. Null = новый
     * аккаунт, письму ещё не поверили: ставки и покупки закрыты. */
    emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),
    emailVerifyTokenHash: text("email_verify_token_hash"),
    emailVerifySentAt: timestamp("email_verify_sent_at", { withTimezone: true }),
    /** Соцвход (№ 50/52–54): id у провайдера. Пароль может отсутствовать —
     * тогда вход только через соцсеть, пока человек не создаст пароль. */
    googleId: text("google_id"),
    facebookId: text("facebook_id"),
    telegramId: text("telegram_id"),
    /** Откуда человек пришёл ВПЕРВЫЕ: utm-метки и реферер первого визита.
     * Пишется один раз и больше не меняется — это «кто его привёл», и цена
     * привлечения считается по нему. Не персональные данные: только метки. */
    attribution: jsonb("attribution").$type<{
      source?: string; medium?: string; campaign?: string; content?: string;
      term?: string; referrer?: string; landing?: string; at?: string;
    }>(),
    /** Откуда пришёл В ПОСЛЕДНИЙ раз. Обновляется на каждом визите с меткой.
     * Первого касания одного мало: человек однажды пришёл из поиска, а купил
     * по письму — без последнего касания вся заслуга письма невидима, и
     * рассылка с ретаргетингом выглядят бесполезными. */
    attributionLast: jsonb("attribution_last").$type<{
      source?: string; medium?: string; campaign?: string; content?: string;
      term?: string; referrer?: string; landing?: string; at?: string;
    }>(),
    /** Сколько раз приходил по метке — отличает случайный клик от того, кого
     * реклама вела к покупке несколько недель. */
    attributionTouches: integer("attribution_touches").notNull().default(0),
    /** Партнёр (affiliate), чья ссылка привела к регистрации, — first-touch,
     * как и attribution: пишется один раз, комиссия считается по нему. */
    affiliateId: uuid("affiliate_id"),
    /** Идентификатор браузера из плашки cookie. Связывает решения, принятые
     * ДО регистрации, с уже появившимся аккаунтом: иначе согласие анонимного
     * гостя навсегда остаётся отдельной строкой, которую не с кем сопоставить. */
    visitorId: text("visitor_id"),
    /** Как человек входит на самом деле: password | google | facebook |
     * telegram. Наличие googleId говорит лишь, что связка есть; это — чем
     * пользовались в последний раз. */
    lastLoginMethod: text("last_login_method"),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    erasedAt: timestamp("erased_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("customers_email_idx").on(t.email), index("customers_visitor_idx").on(t.visitorId)],
);

/**
 * Рекламная карточка в ленте лотов.
 *
 * Показывается среди обычных карточек каталога: человек листает лоты и
 * встречает рекламу. Место продаётся рекламодателю, поэтому у карточки есть
 * и его имя, и срок показа.
 *
 * `categoryCode` пустой означает «во всех категориях». `everyN` — через
 * сколько карточек лотов вставлять эту: так плотность рекламы задаётся
 * отдельно для каждой категории, а не одна на весь сайт.
 */
export const adCards = pgTable(
  "ad_cards",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Кто купил место — для отчёта рекламодателю и для счёта. */
    advertiser: text("advertiser").notNull().default(""),
    title: text("title").notNull(),
    body: text("body").notNull().default(""),
    ctaLabel: text("cta_label").notNull().default(""),
    href: text("href").notNull(),
    /** banner — одна картинка или цвет темы; carousel — несколько кадров;
     *  video — ролик с финальной ссылкой. */
    kind: text("kind").notNull().default("banner"),
    imageUrl: text("image_url"),
    /** Кадры карусели по порядку. У видео первый кадр — постер до запуска. */
    images: jsonb("images").$type<string[]>().notNull().default([]),
    videoUrl: text("video_url"),
    /** Пометка «Реклама». Для оплаченной чужой рекламы обязана быть включена —
     *  закон о рекламе требует, чтобы её было видно. Снимать её честно только
     *  на собственных промо-карточках, ведущих внутрь сайта. */
    showLabel: boolean("show_label").notNull().default(true),
    /** Оформление из палитры макета: green | blue | pink | yellow. */
    theme: text("theme").notNull().default("green"),
    /** Пусто — во всех категориях. Иначе код категории из домена. */
    categoryCode: text("category_code"),
    /** Через сколько карточек лотов вставлять эту. Меньше — чаще. */
    everyN: integer("every_n").notNull().default(12),
    active: boolean("active").notNull().default(false),
    startsAt: timestamp("starts_at", { withTimezone: true }),
    endsAt: timestamp("ends_at", { withTimezone: true }),
    /** Сколько раз карточку показали — рекламодателю это и продаётся. */
    impressions: integer("impressions").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("ad_cards_active_idx").on(t.active, t.categoryCode)],
);

/**
 * Журнал согласий на cookie.
 *
 * До этого выбор человека записывался только в его собственный браузер и не
 * читался вообще ничем: доказать согласие было нечем, увидеть его в панели —
 * негде, а при заходе с другого устройства плашка спрашивала заново.
 *
 * Строки не переписываются: каждое решение — новая запись, последняя по
 * времени и есть действующая. Так видно и историю: согласился, потом отозвал.
 */
export const cookieConsents = pgTable(
  "cookie_consents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Заполнен, если человек был в кабинете, — тогда согласие переезжает с ним. */
    customerId: uuid("customer_id").references(() => customers.id),
    /** Случайный идентификатор браузера: связывает решения анонимного гостя. */
    visitorId: text("visitor_id").notNull(),
    /** accept | reject | custom */
    mode: text("mode").notNull(),
    analytics: boolean("analytics").notNull().default(false),
    marketing: boolean("marketing").notNull().default(false),
    /** Редакция текста, на которую соглашались: без неё согласие не доказать. */
    policyVersion: text("policy_version").notNull(),
    /** Домен: .lv, .ee и .lt спрашивают отдельно. */
    host: text("host").notNull().default(""),
    ip: text("ip"),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("cookie_consents_visitor_idx").on(t.visitorId, t.createdAt),
    index("cookie_consents_customer_idx").on(t.customerId, t.createdAt),
  ],
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
    /** W3 optional item limit; null = no capacity tracking (neutral bar). */
    capacity: integer("capacity"),
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

// ── Receiving (consignments / deliveries) ────────────────────────────────────

/**
 * R1 — who we buy from. Until now the supplier was free text retyped on every
 * delivery, so "Nordic Trade OÜ" and "nordic trade" were different suppliers
 * and "what do we owe them?" had no answer.
 *
 * Payment terms and bank details are commercial: the API only accepts them
 * from finance.view holders, and strips them for everyone else.
 */
export const suppliers = pgTable(
  "suppliers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    regNo: text("reg_no").notNull().default(""),
    vatNo: text("vat_no").notNull().default(""),
    email: text("email").notNull().default(""),
    phone: text("phone").notNull().default(""),
    address: text("address").notNull().default(""),
    /** Кому адресованы письма: контактное лицо поставщика. */
    contactName: text("contact_name").notNull().default(""),
    /** Язык переписки с поставщиком: lv | ru | en. */
    lang: text("lang").notNull().default("lv"),
    /** Модель работы (решение владельца — поддерживаем обе):
     *  buyout — мы выкупаем поставку и платим по счёту поставщика;
     *  commission — товар остаётся его, мы продаём и платим за вычетом
     *  комиссии (self-billing отчёт вместо его счёта). */
    model: text("model").notNull().default("buyout"),
    /** Наша комиссия при модели commission, б.п. (2500 = 25%). */
    commissionBp: integer("commission_bp").notNull().default(0),
    /** IBAN — finance-only, like every other money field. */
    bankAccount: text("bank_account").notNull().default(""),
    /** ── Кабинет поставщика ──────────────────────────────────────────────
     * Вход только по приглашению: пароля нет, пока человек не пришёл по
     * одноразовой ссылке из письма S1. */
    passwordHash: text("password_hash"),
    inviteTokenHash: text("invite_token_hash"),
    inviteExpiresAt: timestamp("invite_expires_at", { withTimezone: true }),
    portalLastLoginAt: timestamp("portal_last_login_at", { withTimezone: true }),
    /** Смена банковского счёта — классическая мошенническая атака на
     * закупки, поэтому новый IBAN сначала лежит здесь: платить по нему
     * нельзя, пока менеджер не подтвердил смену в админке. */
    pendingBankAccount: text("pending_bank_account"),
    pendingBankRequestedAt: timestamp("pending_bank_requested_at", { withTimezone: true }),
    /** Days from invoice date to due date; the default this supplier bills on. */
    paymentTermsDays: integer("payment_terms_days").notNull().default(14),
    /** Vendor auto-mapping (10.2): один раз пометил — дальше счета этого
     *  поставщика приходят с уже проставленными отделом/категорией/юрлицом. */
    defaultDepartment: text("default_department"),
    defaultCategory: text("default_category"),
    defaultLegalEntity: text("default_legal_entity"),
    notes: text("notes").notNull().default(""),
    active: boolean("active").notNull().default(true),
    createdById: uuid("created_by_id").references(() => adminUsers.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("suppliers_name_idx").on(sql`lower(${t.name})`), index("suppliers_active_idx").on(t.active)],
);

/** One inbound delivery (pallet, supplier lot, buy-out). Items are received
 * against it one by one at the intake station, each writing an `intake`
 * stock movement. */
export const consignments = pgTable(
  "consignments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Human ref (CON-0042) from the counters row lock. */
    ref: text("ref").notNull(),
    /** Display snapshot of the supplier's name, kept alongside supplierId so
     * old deliveries still read correctly if a supplier is later renamed. */
    supplier: text("supplier").notNull(),
    supplierId: uuid("supplier_id").references(() => suppliers.id),
    notes: text("notes").notNull().default(""),
    marketCode: text("market_code")
      .notNull()
      .references(() => markets.code),
    /** announced (поставщик заявил, склад ещё не принимает) | open (идёт
     *  приёмка) | closed. Заявка из кабинета приходит announced, склад
     *  переводит её в open, когда машина реально приехала. */
    status: text("status").notNull().default("open"),
    /** Когда поставщик обещает привезти (заявка из кабинета). */
    plannedAt: timestamp("planned_at", { withTimezone: true }),
    /** Units the paperwork promises; 0 = unknown. */
    expectedCount: integer("expected_count").notNull().default(0),
    /** W6 — delivery-level extra costs (transport, cleaning…), spread
     * pro-rata across the units at report time. Null = none recorded. */
    extraCostCents: integer("extra_cost_cents"),
    /** ── Расхождение при приёмке (письмо S4) ──
     * none — всё сошлось; open — ждём ответ поставщика до discrepancyDueAt;
     * accepted — согласился (или промолчал в срок); disputed — оспорил. */
    discrepancyStatus: text("discrepancy_status").notNull().default("none"),
    discrepancyNote: text("discrepancy_note"),
    discrepancyDueAt: timestamp("discrepancy_due_at", { withTimezone: true }),
    discrepancyReply: text("discrepancy_reply"),
    discrepancyRepliedAt: timestamp("discrepancy_replied_at", { withTimezone: true }),
    createdById: uuid("created_by_id").references(() => adminUsers.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("consignments_ref_idx").on(t.ref), index("consignments_status_idx").on(t.status)],
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
    /** Required for "(SEE NOTES)" condition grades — describes the issue. */
    conditionNotes: text("condition_notes").notNull().default(""),
    /** W2 preset-based grading: selected condition_presets ids (+ optional
     * "other" text stays in conditionNotes; pre-W2 notes read as legacy). */
    conditionPresetIds: jsonb("condition_preset_ids").$type<string[]>().notNull().default([]),
    /** Grading review flow: none (ungraded/legacy) | pending_review |
     * approved | rejected. Clean grades auto-approve unless the
     * grading.reviewAll setting is on. */
    gradeStatus: text("grade_status").notNull().default("none"),
    gradedById: uuid("graded_by_id").references(() => adminUsers.id),
    gradedAt: timestamp("graded_at", { withTimezone: true }),
    reviewedById: uuid("reviewed_by_id").references(() => adminUsers.id),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    /** Preset reject reason shown to the worker; cleared on re-grade. */
    gradeRejectReason: text("grade_reject_reason"),
    /** Set when a reviewer edited or rejected and the worker hasn't seen it. */
    gradeNoticePending: boolean("grade_notice_pending").notNull().default(false),
    /** Domain category code (storefront browse filter); "other" = unsorted. */
    category: text("category").notNull().default("other"),
    location: text("location").notNull().default(""),
    /** Structured bin; the free-text `location` stays as display fallback. */
    locationId: uuid("location_id").references(() => warehouseLocations.id),
    weightGrams: integer("weight_grams"),
    /** { l, w, h } in cm. */
    dims: jsonb("dims").$type<{ l: number; w: number; h: number } | null>(),
    photos: jsonb("photos").$type<string[]>().notNull().default([]),
    /** Inbound delivery this item arrived with (null for pre-receiving rows). */
    consignmentId: uuid("consignment_id").references(() => consignments.id),
    /** W6 — what the unit cost us (purchase price). Null = unknown; old
     * stock stays blank rather than assumed zero. Visible only to
     * finance.view — the API strips it for everyone else. */
    costCents: integer("cost_cents"),
    /** Warehouse lifecycle state (domain ItemStatus). */
    status: text("status").notNull().default("draft"),
    marketCode: text("market_code")
      .notNull()
      .references(() => markets.code),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("items_sku_idx").on(t.sku),
    index("items_status_idx").on(t.status),
    /** W5 stock-taking: the diff pulls every item in the scoped bins. */
    index("items_location_idx").on(t.locationId),
    /** W6 cost/margin: the finance reports group and join on the delivery. */
    index("items_consignment_idx").on(t.consignmentId),
  ],
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
    /** Packing/handling fee for carrier orders (flat; no buyer premium). */
    handlingCents: integer("handling_cents").notNull().default(0),
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
    /** How the buyer receives the goods: warehouse pickup or a carrier.
     * courier = door delivery to a street address; freight = oversized goods
     * carried by a separate haulier after a written quote. */
    fulfilment: text("fulfilment").notNull().default("pickup"), // pickup | omniva_pm | dpd_pm | courier | freight
    /** Destination snapshot for carrier fulfilment: a parcel machine keeps
     * machineId, courier and freight keep the street address instead. */
    shippingTo: jsonb("shipping_to").$type<{
      provider: string;
      machineId: string;
      name: string;
      zip: string;
      country: string;
      address?: string;
      city?: string;
      /** Floor / lift / doorway notes the driver needs for bulky goods. */
      accessNote?: string;
    } | null>(),
    /** Recipient contact for the carrier (required for locker delivery). */
    recipientName: text("recipient_name"),
    recipientPhone: text("recipient_phone"),
    /** Somebody else collects at the warehouse: name shown to the counter
     * along with the pickup code. Empty when the buyer comes personally. */
    pickupProxyName: text("pickup_proxy_name").notNull().default(""),
    /** Optional declared-value cover bought at checkout, in cents. */
    insuranceCents: integer("insurance_cents").notNull().default(0),
    /** Retained no-show restock fee (5% of total by default). */
    restockFeeCents: integer("restock_fee_cents"),
    /** Кому выставлен счёт: профиль реквизитов и его снимок на момент
     * выписки — правка профиля не меняет уже выданный счёт (макет № 42). */
    billingProfileId: uuid("billing_profile_id"),
    billingSnapshot: jsonb("billing_snapshot").$type<{
      kind: string;
      name: string;
      regNo: string;
      vatNo: string;
      address: string;
      city: string;
      zip: string;
      country: string;
      invoiceEmail: string;
    } | null>(),
    /** Аванс, зачтённый в этот заказ: провайдеру ушла сумма за вычетом его. */
    creditAppliedCents: integer("credit_applied_cents").notNull().default(0),
    /** Баллы лояльности, зачтённые в заказ (в центах) — как аванс, но со
     * своим журналом и потолком в долях от итога (marketing_settings). */
    pointsAppliedCents: integer("points_applied_cents").notNull().default(0),
    /** Применённый промокод и удержанная им скидка. Итог заказа уже СО
     * скидкой; поля хранят след для отчёта и повторной проверки лимитов. */
    promoCodeId: uuid("promo_code_id"),
    promoDiscountCents: integer("promo_discount_cents").notNull().default(0),
    /** Снимок ПЕРВОГО касания клиента на момент заказа — кто его когда-то
     * привёл. Остаётся даже после удаления аккаунта: отчёт по кампаниям не
     * должен обнуляться от того, что человек ушёл. */
    attribution: jsonb("attribution").$type<{
      source?: string; medium?: string; campaign?: string; content?: string;
      term?: string; referrer?: string; landing?: string; at?: string;
    }>(),
    /** Снимок ПОСЛЕДНЕГО касания — что привело человека именно к этой покупке.
     * По нему считается отдача письма и ретаргетинга, которых в модели
     * первого касания не видно вовсе. */
    attributionLast: jsonb("attribution_last").$type<{
      source?: string; medium?: string; campaign?: string; content?: string;
      term?: string; referrer?: string; landing?: string; at?: string;
    }>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("orders_ref_idx").on(t.ref),
    index("orders_status_idx").on(t.status),
    index("orders_customer_idx").on(t.customerId, t.createdAt),
  ],
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
    /** Pending direct handoff: set by "pass to colleague", cleared on accept. */
    passToId: uuid("pass_to_id").references(() => adminUsers.id),
    passReason: text("pass_reason"),
    passAt: timestamp("pass_at", { withTimezone: true }),
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
    /** ── Refund Pending поток (5.2): сторно ТОЛЬКО после «выплачено» ──
     * card (авто через провайдера) → сразу paid; bank/cash — цепочка
     * requested → awaiting_manual → paid → closed. Старые строки — closed. */
    status: text("status").notNull().default("closed"),
    /** card | bank | cash */
    method: text("method").notNull().default("card"),
    paidBy: text("paid_by"),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    actorId: uuid("actor_id").references(() => adminUsers.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("refunds_order_idx").on(t.orderId), index("refunds_status_idx").on(t.status)],
);

/**
 * Online payment attempts (Klix hosted checkout). One order may accumulate
 * several rows — abandoned checkouts stay `created`/`expired`; exactly one
 * `paid` row settles the order. The provider purchase is the source of truth:
 * a row flips to `paid` only after re-fetching the purchase from the provider
 * (callbacks are never trusted on their own).
 */
export const payments = pgTable(
  "payments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    provider: text("provider").notNull().default("klix"),
    /** Where the checkout was started: storefront button or an email pay link. */
    channel: text("channel").notNull().default("web"), // web | email
    /** Provider-side purchase id (Klix purchase UUID). */
    providerId: text("provider_id"),
    status: text("status").notNull().default("created"), // created | paid | failed | expired
    amountCents: integer("amount_cents").notNull(),
    /** Hosted checkout URL the customer was redirected to. */
    checkoutUrl: text("checkout_url"),
    /**
     * Один платёж за несколько лотов (макеты № 47 и 48): здесь лежат ОСТАЛЬНЫЕ
     * заказы, которые закрывает этот же платёж. Сами заказы остаются
     * отдельными — у каждого свой счёт, доставка и выдача; общей становится
     * только оплата. Пусто — обычный платёж за один заказ.
     */
    groupOrderIds: jsonb("group_order_ids").$type<string[]>().notNull().default([]),
    /** Last raw provider status observed (diagnostics). */
    providerStatus: text("provider_status"),
    /**
     * Payment method the customer actually used, as the provider reports it
     * (e.g. klix_pay_later, swedbank_lv_pis, klix card) — how an admin tells
     * a BNPL payment from a banklink from a card.
     */
    method: text("method"),
    /**
     * Full last provider response (purchase/session object). Everything the
     * provider knows — BNPL terms, contract ids, timestamps — stays visible
     * in admin even for fields the integration doesn't model explicitly.
     */
    raw: jsonb("raw"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("payments_order_idx").on(t.orderId, t.createdAt),
    index("payments_provider_id_idx").on(t.providerId),
  ],
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
    /**
     * Set when a corrected invoice replaced this one (e.g. shipping added to
     * an unpaid order after issue). Voided numbers stay in the sequence for
     * audit; the replacement gets the next number.
     */
    voidedAt: timestamp("voided_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("invoices_number_idx").on(t.number)],
);

// ── Carrier shipments (Omniva parcel machines; DPD next) ────────────────────

export const shipments = pgTable(
  "shipments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    provider: text("provider").notNull().default("omniva"),
    /** Carrier tracking barcode returned at registration. */
    barcode: text("barcode").notNull(),
    /** Our lifecycle: registered | in_transit | at_point | delivered |
     * unclaimed | returned | cancelled | error. `unclaimed` is the carrier
     * hold expiring; `returned` is the parcel physically back with us — from
     * there the buyer either pays a reshipment or takes the refund. */
    status: text("status").notNull().default("registered"),
    /** Last carrier event code observed (e.g. PACKET_DELIVERED_TO_CLIENT). */
    providerStatus: text("provider_status"),
    /** Full carrier event history, newest first. */
    events: jsonb("events")
      .$type<Array<{ code: string; at: string; description?: string | undefined; location?: string | undefined }>>()
      .notNull()
      .default([]),
    /** Last raw carrier response (diagnostics; nothing hidden from admin). */
    raw: jsonb("raw"),
    labelPrintedAt: timestamp("label_printed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("shipments_order_idx").on(t.orderId), index("shipments_barcode_idx").on(t.barcode), index("shipments_status_idx").on(t.status)],
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
    type: text("type").notNull(), // 'unpaid_restock' | 'no_pickup_restock' | 'storage' | 'reship'
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

// ── W5: stock-taking (inventarizācija) ──────────────────────────────────────

/**
 * One reviewed line of a count, as snapshotted at approval time. Structurally
 * identical to the API's `DiffLine` (apps/api/src/routes/stockCounts.ts), which
 * stays the source of truth — this mirror only exists so the jsonb column is
 * typed without the db package depending on the api package.
 */
export type StockCountResultLine = {
  outcome: "match" | "wrong_bin" | "missing" | "moved_during" | "unknown_label";
  itemId: string | null;
  sku: string | null;
  title: string | null;
  expectedLocationId: string | null;
  expectedLabel: string | null;
  foundLocationId: string | null;
  foundLabel: string | null;
  code: string | null;
  /** The same item/code turned up in more than one bin during the session. */
  multipleBins: boolean;
};

/** One counting session. The shelf keeps working during a count — the diff
 * uses stock_movements after startedAt to tell "legitimately left" apart
 * from "missing". Nothing changes stock until a manager approves. */
export const stockCounts = pgTable(
  "stock_counts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    /** Scope: whole warehouse when both empty. */
    zones: jsonb("zones").$type<string[]>().notNull().default([]),
    locationIds: jsonb("location_ids").$type<string[]>().notNull().default([]),
    /** Bins the counters marked finished — "missing" only applies to these. */
    doneLocationIds: jsonb("done_location_ids").$type<string[]>().notNull().default([]),
    /** open | approved | cancelled. */
    status: text("status").notNull().default("open"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    createdById: uuid("created_by_id").references(() => adminUsers.id),
    approvedById: uuid("approved_by_id").references(() => adminUsers.id),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    /**
     * Snapshot of the diff as it stood when the manager approved. Recomputing
     * after approval would answer against corrected data (missing items now
     * have no bin, wrong-bin items now match) and the review screen would go
     * blank — so the record of what was actually corrected is frozen here.
     * Null while the session is open.
     */
    result: jsonb("result").$type<{
      tally: Record<string, number>;
      lines: StockCountResultLine[];
      moved: number;
      missing: number;
    }>(),
  },
  (t) => [index("stock_counts_status_idx").on(t.status)],
);

/** One QR/SKU read during a session — who scanned what, where, when. Blind
 * by design: the phone never shows what the bin is supposed to hold. */
export const stockCountScans = pgTable(
  "stock_count_scans",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    countId: uuid("count_id")
      .notNull()
      .references(() => stockCounts.id, { onDelete: "cascade" }),
    /** Raw code as scanned (kept for unknown-label review). */
    code: text("code").notNull(),
    /** Resolved item; null = label the system doesn't know. A scan must never
     * outlive its item — every other item-child table cascades, and without it
     * DELETE /api/items/:id fails forever on this FK. */
    itemId: uuid("item_id").references(() => items.id, { onDelete: "cascade" }),
    /** The bin being counted when this was scanned. */
    locationId: uuid("location_id")
      .notNull()
      .references(() => warehouseLocations.id),
    scannedById: uuid("scanned_by_id").references(() => adminUsers.id),
    scannedByLabel: text("scanned_by_label").notNull().default(""),
    scannedAt: timestamp("scanned_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("stock_count_scans_count_idx").on(t.countId)],
);

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
    /** Письмо поставщику (S1…S10): вместо клиента адресат — поставщик.
     *  Ровно один из customerId/supplierId заполнен; всё остальное —
     *  очередь, повторы, лог в админке, правки текстов — общее. */
    supplierId: uuid("supplier_id"),
    type: text("type").notNull(), // outbid | won | payment_reminder | order_paid
    channel: text("channel").notNull().default("email"),
    toEmail: text("to_email").notNull(),
    lang: text("lang").notNull().default("en"),
    subject: text("subject").notNull(),
    body: text("body").notNull(),
    /** Designed body, rendered at enqueue. Null for rows written before
     * HTML emails existed — those still send as plain text. */
    html: text("html"),
    /** Optional idempotency key — a partial unique index rejects duplicates. */
    dedupeKey: text("dedupe_key"),
    /** service — про заказ, ставку, выдачу: идёт всегда и вне лимитов.
     * marketing — дайджесты, подборки, возвращение: только с согласием,
     * с частотным лимитом и не ночью. */
    kind: text("kind").notNull().default("service"),
    /** Маркетинговое письмо, отложенное до конца тишины. Отправка ждёт
     * этого момента; null — отправлять при первой же выемке. */
    scheduledFor: timestamp("scheduled_for", { withTimezone: true }),
    status: text("status").notNull().default("pending"), // pending | sent | failed
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    /** Кампания-источник (для статистики по кампаниям и A/B-вариантам). */
    campaignId: uuid("campaign_id"),
    /** A/B-вариант письма: "a" | "b"; null — письмо вне эксперимента. */
    variant: text("variant"),
    /** Первое открытие (пиксель) и первый клик — только маркетинговые письма. */
    openedAt: timestamp("opened_at", { withTimezone: true }),
    clickedAt: timestamp("clicked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("notifications_status_idx").on(t.status, t.createdAt),
    uniqueIndex("notifications_dedupe_idx").on(t.dedupeKey),
    index("notifications_campaign_idx").on(t.campaignId),
  ],
);

// ── Append-only audit log ────────────────────────────────────────────────────

// ── Phase E: report-a-problem + Jira sync ────────────────────────────────────

/** One in-app problem report; mirrors a Jira issue once the token is set. */
export const bugReports = pgTable(
  "bug_reports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    reporterId: uuid("reporter_id").references(() => adminUsers.id),
    /** Display snapshot surviving user deletion. */
    reporterLabel: text("reporter_label").notNull(),
    /** Where it was filed: screen id + optional record ref. */
    screen: text("screen").notNull().default(""),
    /** Auto-captured context: role, market, viewport, version, url hash. */
    context: jsonb("context").$type<Record<string, string>>().notNull().default({}),
    body: text("body").notNull(),
    steps: text("steps").notNull().default(""),
    type: text("type").notNull().default("bug"), // bug | visual | data | slow | idea
    severity: text("severity").notNull().default("normal"), // low | normal | high | blocker
    /** Uploaded screenshot/recording URLs (existing storage driver). */
    attachments: jsonb("attachments").$type<string[]>().notNull().default([]),
    /** Ring-buffer snapshot: last console lines + failed API calls. */
    consoleLog: jsonb("console_log").$type<string[]>().notNull().default([]),
    jiraKey: text("jira_key"),
    /** open (no Jira yet) | sent | in_progress | done | dismissed. */
    status: text("status").notNull().default("open"),
    /** IT's closing comment, shown in the green "Fixed" box. */
    resolutionNote: text("resolution_note"),
    /** Set on done until the reporter acknowledges the fixed-banner. */
    noticePending: boolean("notice_pending").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("bug_reports_reporter_idx").on(t.reporterId, t.createdAt), index("bug_reports_status_idx").on(t.status)],
);

/** Chat with IT — mirrors the Jira issue's comment thread both ways. */
export const bugReportComments = pgTable(
  "bug_report_comments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    reportId: uuid("report_id")
      .notNull()
      .references(() => bugReports.id, { onDelete: "cascade" }),
    authorId: uuid("author_id").references(() => adminUsers.id),
    authorLabel: text("author_label").notNull(),
    /** 'panel' = written here (reporter or IT-on-duty); 'it' = from Jira. */
    side: text("side").notNull(),
    /** Jira comment id (ours after posting, theirs on sync) — the dedupe key. */
    jiraCommentId: text("jira_comment_id"),
    body: text("body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("bug_report_comments_report_idx").on(t.reportId, t.createdAt)],
);

/** Per-admin read cursor per report (same pattern as item_comment_reads). */
export const bugReportReads = pgTable(
  "bug_report_reads",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => adminUsers.id, { onDelete: "cascade" }),
    reportId: uuid("report_id")
      .notNull()
      .references(() => bugReports.id, { onDelete: "cascade" }),
    lastReadAt: timestamp("last_read_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("bug_report_reads_pk").on(t.userId, t.reportId)],
);

/**
 * R1 — a bill FROM a supplier. Everything else called "invoice" in this schema
 * is buyer-side and hangs off an order; this is the other direction, and hangs
 * off a delivery.
 *
 * `status` is derived from the payments below and stored so the overdue list
 * is one indexed read: unpaid | partly_paid | paid | cancelled.
 */
export const supplierInvoices = pgTable(
  "supplier_invoices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    supplierId: uuid("supplier_id")
      .notNull()
      .references(() => suppliers.id),
    /** Usually one bill per delivery, but a bill can arrive without one. */
    consignmentId: uuid("consignment_id").references(() => consignments.id),
    /** The supplier's own number, as printed — not ours to generate. */
    number: text("number").notNull(),
    invoiceDate: timestamp("invoice_date", { withTimezone: true }).notNull(),
    dueDate: timestamp("due_date", { withTimezone: true }).notNull(),
    amountCents: integer("amount_cents").notNull(),
    status: text("status").notNull().default("unpaid"),
    note: text("note").notNull().default(""),
    /** ── Approval-слой (10.3) ── */
    department: text("department"),
    category: text("category"),
    legalEntity: text("legal_entity").notNull().default("LV"),
    /** Ключ PDF в хранилище (загрузка счёта в карточку). */
    fileKey: text("file_key"),
    /** pending | auto | approved | rejected. Старые строки — approved. */
    approvalStatus: text("approval_status").notNull().default("approved"),
    /** По какому правилу маршрутизирован (audit: правила меняются, история — нет). */
    approvalRuleNote: text("approval_rule_note"),
    approvedBy: text("approved_by"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    /** Второй апрув (двойной, €5000+): бухгалтер до оплаты. */
    secondApprovedBy: text("second_approved_by"),
    secondApprovedAt: timestamp("second_approved_at", { withTimezone: true }),
    rejectedReason: text("rejected_reason"),
    createdById: uuid("created_by_id").references(() => adminUsers.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("supplier_invoices_status_idx").on(t.status, t.dueDate),
    index("supplier_invoices_approval_idx").on(t.approvalStatus),
    index("supplier_invoices_supplier_idx").on(t.supplierId),
    index("supplier_invoices_consignment_idx").on(t.consignmentId),
  ],
);

/** Money actually sent. Several per invoice — part payments are normal. */
export const supplierPayments = pgTable(
  "supplier_payments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    invoiceId: uuid("invoice_id")
      .notNull()
      .references(() => supplierInvoices.id, { onDelete: "cascade" }),
    amountCents: integer("amount_cents").notNull(),
    paidAt: timestamp("paid_at", { withTimezone: true }).notNull(),
    /** bank_transfer | cash | card | other */
    method: text("method").notNull().default("bank_transfer"),
    note: text("note").notNull().default(""),
    actorId: uuid("actor_id").references(() => adminUsers.id),
    actorLabel: text("actor_label").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("supplier_payments_invoice_idx").on(t.invoiceId)],
);

/**
 * R2 — a buyer brought something back. Refunds already existed as a money
 * ledger; this is the case around one: why it came back, who decided what,
 * where the goods went, and whether it was inside the 14-day window.
 *
 * The money still moves through `refunds` — this table never duplicates it.
 */
export const returnCases = pgTable(
  "return_cases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Human ref (RET-0042) from the counters row lock. */
    ref: text("ref").notNull(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id),
    /** Snapshot: the order ref survives even if the order is ever reshaped. */
    orderRef: text("order_ref").notNull(),
    itemId: uuid("item_id").references(() => items.id, { onDelete: "set null" }),
    customerId: uuid("customer_id").references(() => customers.id),
    customerAlias: text("customer_alias").notNull().default(""),
    /** not_as_described | damaged | changed_mind | other */
    reason: text("reason").notNull(),
    note: text("note").notNull().default(""),
    photos: jsonb("photos").$type<string[]>().notNull().default([]),
    /** open | resolved */
    status: text("status").notNull().default("open"),
    /** refund_full | refund_partial | rejected — set when resolved. */
    decision: text("decision"),
    refundCents: integer("refund_cents").notNull().default(0),
    /** quarantine | stock | write_off | kept_by_buyer */
    destination: text("destination"),
    /** How the money went back: cash, card_terminal, klix, inbank_portal, none. */
    refundMethod: text("refund_method"),
    /** False when opened after the 14-day claims window; the reason is then
     * required and audited — staff may still accommodate a good customer. */
    withinWindow: boolean("within_window").notNull().default(true),
    overrideReason: text("override_reason").notNull().default(""),
    openedById: uuid("opened_by_id").references(() => adminUsers.id),
    openedByLabel: text("opened_by_label").notNull(),
    resolvedById: uuid("resolved_by_id").references(() => adminUsers.id),
    resolvedByLabel: text("resolved_by_label"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("return_cases_ref_idx").on(t.ref),
    index("return_cases_status_idx").on(t.status, t.createdAt),
    index("return_cases_customer_idx").on(t.customerId),
    index("return_cases_order_idx").on(t.orderId),
  ],
);

// ── Billing profiles (кому выставлять счёт: себе или своей фирме) ──────────

/**
 * Реквизиты покупателя для счёта. Одному аккаунту можно держать несколько:
 * частное лицо и одна-две фирмы (макеты № 42–45 и 81). Заказ хранит и ссылку
 * на профиль, и его снимок — правка профиля не переписывает выданный счёт.
 */
export const billingProfiles = pgTable(
  "billing_profiles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    /** person | company — от этого зависит набор обязательных полей. */
    kind: text("kind").notNull().default("person"),
    /** ФИО частного лица либо название фирмы — то, что печатается в счёте. */
    name: text("name").notNull(),
    /** Регистрационный номер фирмы; у частного лица пусто. */
    regNo: text("reg_no").notNull().default(""),
    vatNo: text("vat_no").notNull().default(""),
    /** Юридический адрес одной строкой плюс город и индекс отдельно. */
    address: text("address").notNull().default(""),
    city: text("city").notNull().default(""),
    zip: text("zip").notNull().default(""),
    country: text("country").notNull().default("LV"),
    /** Куда слать счета, если отличается от почты аккаунта. */
    invoiceEmail: text("invoice_email").notNull().default(""),
    /** Кэш проверки VIES — тот же формат, что у customers.vies. */
    vies: jsonb("vies").$type<{ valid: boolean; checkedAt: string; consult?: string } | null>(),
    isDefault: boolean("is_default").notNull().default(false),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("billing_profiles_customer_idx").on(t.customerId, t.archivedAt),
  ],
);

// ── Сохранённые поиски (макет № 80) ────────────────────────────────────────

/**
 * Запрос, который покупатель сохранил, чтобы не набирать его каждый раз, и
 * при желании получать письмо, когда под него появляются новые лоты.
 * Храним сам запрос, а не результаты: каталог живёт своей жизнью.
 */
/**
 * Список желаний (Vēlmes).
 *
 * Жил в localStorage браузера: на втором устройстве его не было, а движок не
 * знал, за какими лотами человек следит, — и не мог написать «твой лот скоро
 * закроется». Теперь список на сервере; в браузере остаётся только копия для
 * гостя, которая при входе вливается сюда.
 */
export const watchlist = pgTable(
  "watchlist",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    /** Отслеживать можно и торги, и лот «купить сразу» — на витрине это одна
     *  и та же кнопка-сердце, поэтому строка хранит ровно одну из двух ссылок. */
    auctionId: uuid("auction_id").references(() => auctions.id, { onDelete: "cascade" }),
    listingId: uuid("listing_id").references(() => listings.id, { onDelete: "cascade" }),
    /** Письмо «скоро закроется» уходит один раз на лот — здесь отметка. */
    endingNotifiedAt: timestamp("ending_notified_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // NULL в уникальном индексе не конфликтует сам с собой, поэтому одна пара
    // на торги и одна на лот считаются независимо — ровно то, что нужно.
    uniqueIndex("watchlist_pair_idx").on(t.customerId, t.auctionId),
    uniqueIndex("watchlist_listing_pair_idx").on(t.customerId, t.listingId),
    index("watchlist_auction_idx").on(t.auctionId),
    check("watchlist_one_target", sql`(${t.auctionId} is not null) <> (${t.listingId} is not null)`),
  ],
);

/**
 * Журнал отправок в Meta Conversions API.
 *
 * Нужен не ради статистики: без него на вопрос «дошло ли событие и почему
 * Meta считает конверсии иначе» ответить нечем — рекламный кабинет своих
 * ошибок не показывает, а поддержка Meta просит trace id. Здесь лежит ровно
 * технический результат: что послали, когда, чем ответили. Персональных
 * данных и токена в журнале нет и быть не может — в Meta они уходят
 * захешированными, а сюда не попадают вовсе.
 */
export const metaEvents = pgTable(
  "meta_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Тот же идентификатор, что ушёл в браузерный пиксель: по нему Meta
     *  склеивает две копии события в одну конверсию. */
    eventId: text("event_id").notNull(),
    eventName: text("event_name").notNull(),
    /** Кто именно — для разбора обращений; при удалении аккаунта обнуляется. */
    customerId: uuid("customer_id").references(() => customers.id, { onDelete: "set null" }),
    /** pending | sent | failed | skipped — skipped значит «нет согласия». */
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    httpStatus: integer("http_status"),
    /** fbtrace_id из ответа Meta — с ним обращаются в поддержку. */
    traceId: text("trace_id"),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("meta_events_event_idx").on(t.eventId),
    index("meta_events_status_idx").on(t.status, t.createdAt),
  ],
);

export const savedSearches = pgTable(
  "saved_searches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    /** Название, которое дал покупатель, либо собранное из фильтров. */
    name: text("name").notNull(),
    /** Снимок фильтров каталога — тот же набор, что в строке адреса. */
    query: jsonb("query")
      .$type<{
        q?: string | undefined;
        category?: string | undefined;
        market?: string | undefined;
        priceMinCents?: number | undefined;
        priceMaxCents?: number | undefined;
        condition?: string | undefined;
        noReserve?: boolean | undefined;
      }>()
      .notNull()
      .default({}),
    /** Присылать письмо о новых лотах под этот запрос. */
    alertEmail: boolean("alert_email").notNull().default(false),
    /** Когда рассылка в последний раз проверяла этот запрос. */
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("saved_searches_customer_idx").on(t.customerId, t.createdAt)],
);

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


/**
 * Аванс клиента: переплаты и возвраты, оставленные «на счету». Одна строка
 * на клиента; каждое движение — отдельная запись в credit_entries, баланс
 * меняется только вместе с записью.
 */
export const credits = pgTable(
  "credits",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    balanceCents: integer("balance_cents").notNull().default(0),
    /** Неиспользованный аванс возвращаем автоматически после этого срока. */
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("credits_customer_idx").on(t.customerId)],
);

export const creditEntries = pgTable(
  "credit_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    creditId: uuid("credit_id")
      .notNull()
      .references(() => credits.id, { onDelete: "cascade" }),
    /** overpay | refund_to_credit | used_for_order | withdrawn | expired | grant */
    kind: text("kind").notNull(),
    /** Плюс — пополнение, минус — списание. */
    amountCents: integer("amount_cents").notNull(),
    orderRef: text("order_ref"),
    note: text("note").notNull().default(""),
    actorLabel: text("actor_label"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("credit_entries_credit_idx").on(t.creditId)],
);

/**
 * Матрица уведомлений «событие × канал». Строк нет — действует умолчание
 * движка; юридически обязательные письма (won, invoice, payment) каналом
 * e-mail не отключаются вовсе и в таблицу не пишутся.
 */
export const notificationPrefs = pgTable(
  "notification_prefs",
  {
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    /** outbid | ending | watchlist | marketing */
    event: text("event").notNull(),
    email: boolean("email").notNull().default(true),
    push: boolean("push").notNull().default(false),
    telegram: boolean("telegram").notNull().default(false),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("notification_prefs_pk").on(t.customerId, t.event)],
);

/* ═══════════════════ Маркетинг и сегментация (план v15) ═══════════════════ */

/**
 * Настройки маркетинга — числа, зашитые раньше в тексты: проценты скидок,
 * сроки действия, баллы. Правятся из админки без деплоя (MD §9). Значение —
 * jsonb: число, строка или объект. Ключи и умолчания — в engine/settings.ts.
 */
export const marketingSettings = pgTable("marketing_settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  updatedBy: text("updated_by"),
});

/**
 * Правки текстов писем из админки. Строка = один шаблон на одном языке;
 * пустое поле (null) означает «взять из кода». Плейсхолдеры {alias},
 * {orderRef}, {amount}… — те же, что в кодовых шаблонах.
 */
export const emailTemplateOverrides = pgTable(
  "email_template_overrides",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Тип письма (verify_email, won, …) — включая новые lifecycle-типы. */
    type: text("type").notNull(),
    lang: text("lang").notNull(),
    subject: text("subject"),
    /** Абзацы письма, разделитель — пустая строка. */
    body: text("body"),
    /** Необязательный сырой HTML контент-блока вместо собранного из body. */
    html: text("html"),
    /** Правка CTA-кнопки: текст и ссылка (поддерживают плейсхолдеры,
     *  {payUrl}/{actionUrl}/{siteUrl}…). Null — кнопка из кода. */
    ctaLabel: text("cta_label"),
    ctaUrl: text("cta_url"),
    enabled: boolean("enabled").notNull().default(true),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    updatedBy: text("updated_by"),
  },
  (t) => [uniqueIndex("email_tpl_override_pk").on(t.type, t.lang)],
);

/**
 * Правки строк интерфейса витрины. Ключ — тот же, что в lib/strings.ts
 * (например «cart.add»); витрина накладывает правки поверх кода. Позволяет
 * менять ЛЮБОЙ видимый текст сайта из админки без деплоя.
 */
export const uiStringOverrides = pgTable(
  "ui_string_overrides",
  {
    key: text("key").notNull(),
    lang: text("lang").notNull(),
    text: text("text").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    updatedBy: text("updated_by"),
  },
  (t) => [uniqueIndex("ui_string_overrides_pk").on(t.key, t.lang)],
);

/** Журнал событий поведения до покупки (MD §1.1). Только запись; читает его
 *  один ночной пересчёт статистики, интерфейсы — никогда. */
export const userEvents = pgTable(
  "user_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    /** view_lot | add_wishlist | place_bid | lost_bid | won_bid | abandon_checkout | viewed_category */
    eventType: text("event_type").notNull(),
    category: text("category"),
    listingId: uuid("listing_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("user_events_customer_idx").on(t.customerId, t.createdAt)],
);

/** Ночная сводка интересов по категориям (MD §1.2). */
export const userCategoryStats = pgTable(
  "user_category_stats",
  {
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    category: text("category").notNull(),
    purchaseCount: integer("purchase_count").notNull().default(0),
    totalSpentCents: integer("total_spent_cents").notNull().default(0),
    lastPurchaseAt: timestamp("last_purchase_at", { withTimezone: true }),
    viewCount: integer("view_count").notNull().default(0),
    wishlistCount: integer("wishlist_count").notNull().default(0),
    lostBidCount: integer("lost_bid_count").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("user_category_stats_pk").on(t.customerId, t.category)],
);

/** RFM-оценка клиента, пересчитывается ночью (MD §1.2). */
export const userRfm = pgTable("user_rfm", {
  customerId: uuid("customer_id")
    .primaryKey()
    .references(() => customers.id, { onDelete: "cascade" }),
  recencyDays: integer("recency_days"),
  frequency: integer("frequency").notNull().default(0),
  monetaryCents: integer("monetary_cents").notNull().default(0),
  /** 1–5 по каждой оси, квинтили. */
  rScore: integer("r_score"),
  fScore: integer("f_score"),
  mScore: integer("m_score"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Сегменты — правило в JSON, участники материализуются ночью (MD §1.3, §2). */
export const segments = pgTable("segments", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  rule: jsonb("rule").$type<{
    match: "all" | "any";
    conditions: Array<{ field: string; op: string; value: number; category?: string | undefined }>;
  }>().notNull(),
  isActive: boolean("is_active").notNull().default(true),
  createdBy: text("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const segmentMembers = pgTable(
  "segment_members",
  {
    segmentId: uuid("segment_id")
      .notNull()
      .references(() => segments.id, { onDelete: "cascade" }),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("segment_members_pk").on(t.segmentId, t.customerId)],
);

/** Кампании: ручная рассылка на сегмент или авто по событию (MD §1.4, §7.3). */
export const campaigns = pgTable("campaigns", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  /** Пока реализован только email; поле — на вырост. */
  channel: text("channel").notNull().default("email"),
  segmentId: uuid("segment_id").references(() => segments.id, { onDelete: "set null" }),
  /** subject + body с плейсхолдерами, на трёх языках. */
  content: jsonb("content").$type<Record<string, { subject: string; body: string }>>().notNull(),
  /** Вариант B для A/B-теста (та же форма, что content). Null — теста нет;
   * при наличии получатели делятся пополам по хэшу customer_id. */
  contentB: jsonb("content_b").$type<Record<string, { subject: string; body: string }> | null>(),
  status: text("status").notNull().default("draft"), // draft | scheduled | sending | sent | archived
  scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  stats: jsonb("stats").$type<{ queued?: number; skipped?: number }>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Промокоды (MD §1.5): ручные и автоматические (welcome / referral / winback). */
export const promoCodes = pgTable(
  "promo_codes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    code: text("code").notNull(),
    /** percent | fixed | free_shipping */
    type: text("type").notNull(),
    /** percent: 0–100; fixed: центы. */
    value: integer("value").notNull(),
    minOrderCents: integer("min_order_cents"),
    category: text("category"),
    segmentId: uuid("segment_id").references(() => segments.id, { onDelete: "set null" }),
    usageLimitTotal: integer("usage_limit_total"),
    usageLimitPerUser: integer("usage_limit_per_user"),
    usedCount: integer("used_count").notNull().default(0),
    validFrom: timestamp("valid_from", { withTimezone: true }),
    validTo: timestamp("valid_to", { withTimezone: true }),
    isActive: boolean("is_active").notNull().default(true),
    /** manual | welcome_auto | referral_referred | winback */
    source: text("source").notNull().default("manual"),
    /** Личный код: применим только этим аккаунтом. */
    customerId: uuid("customer_id").references(() => customers.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("promo_codes_code_idx").on(t.code), index("promo_codes_customer_idx").on(t.customerId)],
);

/** Использования промокодов — для лимитов per-user и статистики. */
export const promoRedemptions = pgTable(
  "promo_redemptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    promoId: uuid("promo_id")
      .notNull()
      .references(() => promoCodes.id, { onDelete: "cascade" }),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    orderRef: text("order_ref").notNull(),
    discountCents: integer("discount_cents").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("promo_redemptions_promo_idx").on(t.promoId), index("promo_redemptions_customer_idx").on(t.customerId)],
);

/** Баллы лояльности: счёт + журнал, те же инварианты, что у аванса. */
export const loyaltyAccounts = pgTable(
  "loyalty_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    /** Баллы в центах (1 балл = 100), чтобы не плодить вторую арифметику. */
    balanceCents: integer("balance_cents").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("loyalty_accounts_customer_idx").on(t.customerId)],
);

export const loyaltyLedger = pgTable(
  "loyalty_ledger",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => loyaltyAccounts.id, { onDelete: "cascade" }),
    /** purchase | referral_signup | referral_order | manual | redemption */
    reason: text("reason").notNull(),
    /** Плюс — начисление, минус — списание. */
    amountCents: integer("amount_cents").notNull(),
    orderRef: text("order_ref"),
    referralId: uuid("referral_id"),
    note: text("note").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("loyalty_ledger_account_idx").on(t.accountId)],
);

/** Рефералы (MD §1.6.1): двухступенчатая награда, антифрод по IP. */
export const referrals = pgTable(
  "referrals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    referrerCustomerId: uuid("referrer_customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    referredCustomerId: uuid("referred_customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    /** pending | signup_rewarded | order_rewarded */
    status: text("status").notNull().default("pending"),
    signupRewardedAt: timestamp("signup_rewarded_at", { withTimezone: true }),
    orderRewardedAt: timestamp("order_rewarded_at", { withTimezone: true }),
    /** Совпал IP при регистрации — награды придерживаются до ручной проверки. */
    fraudFlag: boolean("fraud_flag").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("referrals_referred_idx").on(t.referredCustomerId),
    index("referrals_referrer_idx").on(t.referrerCustomerId),
  ],
);

/** Личный реферальный код клиента (короткий, для ссылки «Uzaicini draugu»). */
export const referralCodes = pgTable(
  "referral_codes",
  {
    customerId: uuid("customer_id")
      .primaryKey()
      .references(() => customers.id, { onDelete: "cascade" }),
    code: text("code").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("referral_codes_code_idx").on(t.code)],
);

/** Отметки lifecycle-писем: кто какое авто-письмо уже получил (dedupe). */
export const lifecycleMarks = pgTable(
  "lifecycle_marks",
  {
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    /** welcome_d3 | inactive_d14 | winback_YYYY-MM-DD | review:{orderRef} | … */
    mark: text("mark").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("lifecycle_marks_pk").on(t.customerId, t.mark)],
);

/* ═══════ Финансовый слой (fin-architecture 31.08.2026) ═══════ */

/**
 * Журнал проводок — мост между платформой и бухгалтерией (Horizon/Jumis).
 * Каждая денежная операция платформы порождает строки по схеме счетов
 * (раздел 11 архитектуры); бухгалтерия получает их экспорт-батчами.
 * Знак суммы: + увеличивает счёт в его природе (выручка/актив/liability).
 */
export const ledgerEntries = pgTable(
  "ledger_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Ключ счёта из FIN_ACCOUNTS (engine/ledger.ts). */
    account: text("account").notNull(),
    amountCents: integer("amount_cents").notNull(),
    /** Юрлицо: LV сейчас; EE/LT — при экспансии (раздел 8.3). */
    legalEntity: text("legal_entity").notNull().default("LV"),
    /** Отдел/cost center (раздел 10.1); null — не относится. */
    department: text("department"),
    /** klix_card | klix_bank | inbank | cash | card_pos — для комиссий/clearing. */
    paymentMethod: text("payment_method"),
    orderRef: text("order_ref"),
    /** Связка с источником: supplier_invoice | refund | consignment | manual … */
    refType: text("ref_type"),
    refId: text("ref_id"),
    memo: text("memo").notNull().default(""),
    /** Дата хозяйственной операции (не записи). */
    eventAt: timestamp("event_at", { withTimezone: true }).notNull(),
    /** Батч выгрузки в бухгалтерию; null — ещё не выгружено. */
    exportBatchId: uuid("export_batch_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("ledger_account_idx").on(t.account, t.eventAt),
    index("ledger_export_idx").on(t.exportBatchId),
    index("ledger_order_idx").on(t.orderRef),
  ],
);

/** Батч экспорта проводок (CSV/XML) — что и когда ушло бухгалтеру. */
export const exportBatches = pgTable("export_batches", {
  id: uuid("id").primaryKey().defaultRandom(),
  format: text("format").notNull().default("csv"), // csv | xml
  fromAt: timestamp("from_at", { withTimezone: true }).notNull(),
  toAt: timestamp("to_at", { withTimezone: true }).notNull(),
  entryCount: integer("entry_count").notNull().default(0),
  createdBy: text("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Единая очередь «Требует внимания» (раздел 0.2): все расхождения всех
 * потоков в одном месте. dedupeKey не даёт крону плодить один и тот же флаг.
 */
export const finFlags = pgTable(
  "fin_flags",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** bank_mismatch | refund_pending | partner_mismatch | clearing_overdue |
     *  carrier_mismatch | dual_approval_wait | eu_threshold */
    type: text("type").notNull(),
    title: text("title").notNull(),
    details: jsonb("details").$type<Record<string, unknown>>().notNull().default({}),
    amountCents: integer("amount_cents"),
    refType: text("ref_type"),
    refId: text("ref_id"),
    department: text("department"),
    status: text("status").notNull().default("open"), // open | resolved
    dedupeKey: text("dedupe_key"),
    resolutionNote: text("resolution_note"),
    resolvedBy: text("resolved_by"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("fin_flags_status_idx").on(t.status, t.createdAt),
    uniqueIndex("fin_flags_dedupe_idx").on(t.dedupeKey),
  ],
);

/**
 * Правила approval-порогов (раздел 10.3) — полностью редактируемы из админки:
 * диапазон суммы → кто апрувит, нужен ли двойной апрув. Никакого хардкода.
 */
export const approvalRules = pgTable("approval_rules", {
  id: uuid("id").primaryKey().defaultRandom(),
  minCents: integer("min_cents").notNull().default(0),
  /** null = без верхней границы. */
  maxCents: integer("max_cents"),
  /** auto | role:<roleId> | admin:<uuid> — кто апрувит первый уровень. */
  approver: text("approver").notNull().default("auto"),
  /** Двойной апрув (второй — бухгалтер) до оплаты (€5000+ по умолчанию). */
  dual: boolean("dual").notNull().default(false),
  position: integer("position").notNull().default(0),
  isActive: boolean("is_active").notNull().default(true),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  updatedBy: text("updated_by"),
});

/** Привязка апрувера к Telegram-чату (бот апрувов, раздел 10.3). */
export const approverTelegram = pgTable(
  "approver_telegram",
  {
    adminUserId: uuid("admin_user_id")
      .primaryKey()
      .references(() => adminUsers.id, { onDelete: "cascade" }),
    chatId: text("chat_id").notNull(),
    /** Одноразовый код привязки; null после успешного /start. */
    linkCode: text("link_code"),
    linkedAt: timestamp("linked_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("approver_tg_chat_idx").on(t.chatId)],
);

/* ═══════════ Надстройка v15: карты, партнёры, push (MD §6) ═══════════ */

/**
 * Подарочная карта (MD §3). Выдаётся из админки (продана на месте или
 * подарена сервисом); погашение зачисляет номинал в кредит клиента
 * (credits/credit_entries, reason gift_card) — дальше работает обычный
 * кредитный механизм оплаты.
 */
export const giftCards = pgTable(
  "gift_cards",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Человекочитаемый код DAVANA-XXXXXX (без 0/O/1/I). */
    code: text("code").notNull(),
    initialCents: integer("initial_cents").notNull(),
    /** 0 после погашения — карта одноразовая, остаток живёт в кредите. */
    balanceCents: integer("balance_cents").notNull(),
    /** Кто погасил (null — ещё не погашена). */
    customerId: uuid("customer_id").references(() => customers.id, { onDelete: "set null" }),
    redeemedAt: timestamp("redeemed_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    isActive: boolean("is_active").notNull().default(true),
    note: text("note"),
    issuedBy: text("issued_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("gift_cards_code_idx").on(t.code)],
);

/**
 * Партнёрская (affiliate) программа (MD §6.7): внешние партнёры со своей
 * ссылкой ?aff=CODE и комиссией с оплаченных заказов приведённых клиентов.
 * Выплаты — вручную по отчёту в админке; здесь только учёт.
 */
export const affiliates = pgTable(
  "affiliates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    /** Код в ссылке: https://izsoli.lv/?aff=CODE */
    code: text("code").notNull(),
    contact: text("contact"),
    /** Комиссия, базисные пункты от оплаченной товарной части (500 = 5%). */
    commissionBp: integer("commission_bp").notNull().default(500),
    isActive: boolean("is_active").notNull().default(true),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("affiliates_code_idx").on(t.code)],
);

/**
 * Браузерные push-подписки (Web Push, VAPID) — свой канал без внешних
 * сервисов. Ключи пары VAPID генерируются сервером и живут в
 * marketing_settings (vapid_keys) — в чат и код не попадают.
 */
export const pushSubscriptions = pgTable(
  "push_subscriptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    endpoint: text("endpoint").notNull(),
    p256dh: text("p256dh").notNull(),
    auth: text("auth").notNull(),
    userAgent: text("user_agent"),
    /** Подряд неудачных отправок; после 5 подписка удаляется (протухла). */
    failCount: integer("fail_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("push_subscriptions_endpoint_idx").on(t.endpoint),
    index("push_subscriptions_customer_idx").on(t.customerId),
  ],
);

/* ═══════ Догоняющие письма по товарам «Pērc uzreiz» (BN-1, BN-2) ═══════ */

/**
 * След корзины для писем «товар вас ждёт».
 *
 * Сама корзина живёт в Redis и должна там и остаться: она меняется на каждый
 * клик, переживает выход из аккаунта и не заслуживает записи в базу. Но крону
 * нужно знать, у кого корзина вообще есть и когда её трогали в последний раз —
 * читать для этого весь Redis нельзя. Здесь лежит ровно этот указатель: чья
 * корзина, когда наполнялась, сколько в ней позиций и какое письмо уже ушло.
 *
 * Строка появляется только у вошедшего человека: гостю писать некуда, и
 * анонимную корзину мы намеренно не связываем с личностью.
 */
export const cartReminders = pgTable(
  "cart_reminders",
  {
    customerId: uuid("customer_id")
      .primaryKey()
      .references(() => customers.id, { onDelete: "cascade" }),
    /** Последнее наполнение корзины — от него считаются 3 и 20 часов. */
    touchedAt: timestamp("touched_at", { withTimezone: true }).notNull(),
    /** Что положили последним — этот лот и показывает письмо. */
    listingId: uuid("listing_id").references(() => listings.id, { onDelete: "set null" }),
    /** Сколько позиций было в корзине на момент отметки. */
    itemCount: integer("item_count").notNull().default(0),
    /** 0 — ещё не писали, 1 — ушло первое письмо, 2 — второе (и последнее). */
    stage: integer("stage").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("cart_reminders_due_idx").on(t.stage, t.touchedAt)],
);

/**
 * Снижения цены на товар «Pērc uzreiz» — для письма тем, у кого он в списке
 * отслеживания.
 *
 * Письмо не уходит в момент правки: цену часто исправляют дважды подряд
 * (опечатка, потом верное число), и первый вариант ушёл бы людям навсегда.
 * Строка ждёт установленную задержку, крон берёт последнюю по лоту, сверяет
 * с живой ценой и только тогда пишет.
 */
export const listingPriceDrops = pgTable(
  "listing_price_drops",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    listingId: uuid("listing_id")
      .notNull()
      .references(() => listings.id, { onDelete: "cascade" }),
    oldPriceCents: integer("old_price_cents").notNull(),
    newPriceCents: integer("new_price_cents").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /** Проставляется после прохода крона — в том числе когда писать не стали. */
    notifiedAt: timestamp("notified_at", { withTimezone: true }),
    /** Скольким людям ушло письмо: видно в админке, зачем правка была нужна. */
    recipients: integer("recipients").notNull().default(0),
  },
  (t) => [index("listing_price_drops_pending_idx").on(t.notifiedAt, t.createdAt)],
);
