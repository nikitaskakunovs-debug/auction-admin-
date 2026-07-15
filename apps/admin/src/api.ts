/** Typed API client. All money fields are integer euro cents. */

export interface AdminUser {
  id: string;
  email: string;
  name: string;
  role: string;
  permissions: string[];
  totpEnabled: boolean;
}

/** Password step result: which second factor the account must complete. */
export interface LoginChallenge {
  challenge: "totp" | "enroll";
  challengeToken: string;
}

export interface TotpSetup {
  secret: string;
  otpauthUri: string;
}

export interface Market {
  code: string;
  name: string;
  currency: string;
  languages: string[];
  vatRateBp: number;
  buyerPremiumBp: number;
  antiSnipeSec: number;
  incrementTable: Array<{ fromCents: number; incrementCents: number }>;
  pickupDeadlineDays: number;
  restockFeeBp: number;
  omnivaPmPriceCents: number;
  dpdPmPriceCents: number;
  handlingFeeCents: number;
  active: boolean;
}

export interface Item {
  id: string;
  sku: string;
  title: string;
  description: string;
  condition: string;
  conditionNotes: string;
  category: string;
  location: string;
  locationId: string | null;
  weightGrams: number | null;
  photos: string[];
  status: string;
  marketCode: string;
  createdAt: string;
  updatedAt: string;
}

export interface Listing {
  id: string;
  itemId: string;
  type: "auction" | "fixed";
  title: string;
  description: string;
  marketCode: string;
  startPriceCents: number | null;
  reserveCents: number | null;
  priceCents: number | null;
  quantity: number;
  antiSnipeSec: number | null;
  status: string;
  createdAt: string;
  itemSku?: string;
  itemStatus?: string;
}

export interface Auction {
  id: string;
  listingId: string;
  status: string;
  startsAt: string;
  endsAt: string;
  currentPriceCents: number | null;
  leaderCustomerId: string | null;
  bidCount: number;
  extensions: number;
  reserveMet: boolean;
  closedAt: string | null;
  listingTitle?: string;
  listingType?: string;
  reserveCents?: number | null;
  startPriceCents?: number | null;
  itemSku?: string;
  leaderAlias?: string | null;
}

export interface BidRow {
  id: string;
  amountCents: number;
  auto: boolean;
  outbid: boolean;
  seq: number;
  voidedAt: string | null;
  voidReason: string | null;
  createdAt: string;
  customerId: string;
  alias: string;
}

export interface Order {
  id: string;
  ref: string;
  auctionId: string | null;
  listingId: string;
  itemId: string;
  customerId: string;
  customerAlias: string;
  customerEmail: string;
  marketCode: string;
  hammerCents: number;
  premiumCents: number;
  vatCents: number;
  vatRateBp: number;
  shippingCents: number;
  handlingCents: number;
  totalCents: number;
  reverseCharge: boolean;
  status: string;
  paymentDeadlineAt: string | null;
  paidAt: string | null;
  createdAt: string;
  /** pickup | omniva_pm — how the buyer receives the goods. */
  fulfilment: string;
  pickupCode: string | null;
  shippingTo: { provider: string; machineId: string; name: string; zip: string; country: string; address?: string } | null;
  recipientName: string | null;
  recipientPhone: string | null;
  itemSku?: string;
  itemStatus?: string;
}

export interface Customer {
  id: string;
  email: string;
  alias: string;
  name: string | null;
  country: string | null;
  marketCode: string | null;
  company: string | null;
  vatNo: string | null;
  vies: { valid: boolean; checkedAt: string; consult: string } | null;
  strikes: number;
  blocked: boolean;
  blockedReason: string | null;
  blockedAt: string | null;
  notes: string;
  erasedAt: string | null;
  createdAt: string;
}

export interface Invoice {
  id: string;
  number: string;
  series: string;
  orderId: string;
  orderRef: string;
  orderStatus: string;
  issuedAt: string;
  data: {
    totalCents: number;
    vatCents: number;
    reverseCharge: boolean;
    buyer: { alias: string; email: string; company: string | null };
    marketCode: string;
  };
}

export interface VatReport {
  from: string;
  to: string;
  basis: string;
  markets: Array<{
    marketCode: string;
    invoiceCount: number;
    netCents: number;
    vatCents: number;
    grossCents: number;
    reverseChargeNetCents: number;
    reverseChargeCount: number;
  }>;
}

export interface AuditEntry {
  id: string;
  actorLabel: string;
  type: string;
  action: string;
  target: string;
  detail: Record<string, unknown> | null;
  createdAt: string;
}

export interface DashboardStats {
  liveAuctions: number;
  endingSoon: number;
  scheduledAuctions: number;
  unpaidOrders: { count: number; totalCents: number };
  gmv30d: { count: number; totalCents: number };
  bids24h: number;
  itemsByStatus: Record<string, number>;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public body: Record<string, unknown>,
  ) {
    super(typeof body.error === "string" ? body.error : `HTTP ${status}`);
  }
}

type Session = { accessToken: string; user: AdminUser };

/**
 * The access token lives only in memory (never localStorage), so an XSS bug
 * can't read it from storage. The refresh token is an httpOnly cookie the
 * browser sends automatically; on a cold load we mint a fresh access token
 * from it via /api/auth/refresh. All requests include credentials so the
 * cookie rides along.
 */
export class ApiClient {
  private accessToken: string | null = null;
  onUnauthenticated: (() => void) | null = null;

  get hasSession(): boolean {
    return this.accessToken !== null;
  }

  /** Current bearer token for WebSocket URLs and authorized download links. */
  get token(): string | null {
    return this.accessToken;
  }

  private async raw<T>(method: string, url: string, body?: unknown): Promise<T> {
    // FormData bodies (photo uploads) set their own multipart boundary header.
    const isForm = typeof FormData !== "undefined" && body instanceof FormData;
    const res = await fetch(url, {
      method,
      credentials: "same-origin",
      headers: {
        ...(body !== undefined && !isForm ? { "content-type": "application/json" } : {}),
        ...(this.accessToken ? { authorization: `Bearer ${this.accessToken}` } : {}),
      },
      body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
    });
    if (res.status === 204) return undefined as T;
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) throw new ApiError(res.status, json);
    return json as T;
  }

  /** Request with a single transparent cookie-refresh-and-retry on 401. */
  async request<T>(method: string, url: string, body?: unknown): Promise<T> {
    try {
      return await this.raw<T>(method, url, body);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401 && this.accessToken) {
        try {
          const r = await this.raw<Session>("POST", "/api/auth/refresh");
          this.accessToken = r.accessToken;
          return await this.raw<T>(method, url, body);
        } catch {
          this.accessToken = null;
          this.onUnauthenticated?.();
        }
      }
      throw err;
    }
  }

  get<T>(url: string): Promise<T> {
    return this.request<T>("GET", url);
  }
  post<T>(url: string, body?: unknown): Promise<T> {
    return this.request<T>("POST", url, body);
  }
  patch<T>(url: string, body?: unknown): Promise<T> {
    return this.request<T>("PATCH", url, body);
  }
  put<T>(url: string, body?: unknown): Promise<T> {
    return this.request<T>("PUT", url, body);
  }
  delete<T>(url: string, body?: unknown): Promise<T> {
    return this.request<T>("DELETE", url, body);
  }
  postForm<T>(url: string, form: FormData): Promise<T> {
    return this.request<T>("POST", url, form);
  }

  // ── Login: password → second factor ─────────────────────────────────────────

  /** Step 1: submit the password, receive a 2FA challenge. */
  loginPassword(email: string, password: string): Promise<LoginChallenge> {
    return this.raw<LoginChallenge>("POST", "/api/auth/login", { email, password });
  }

  /** Step 2 (enrolled): complete with a TOTP or recovery code. */
  async completeTotp(challengeToken: string, code: string): Promise<AdminUser> {
    const r = await this.raw<Session>("POST", "/api/auth/login/2fa", { challengeToken, code });
    this.accessToken = r.accessToken;
    return r.user;
  }

  /** Step 2 (first login): begin TOTP enrollment. */
  setup2fa(challengeToken?: string): Promise<TotpSetup> {
    return this.accessToken
      ? this.post<TotpSetup>("/api/auth/2fa/setup", {})
      : this.raw<TotpSetup>("POST", "/api/auth/2fa/setup", { challengeToken });
  }

  /** Confirm the authenticator code, receive recovery codes (+ session if first login). */
  async enable2fa(code: string, challengeToken?: string): Promise<{ recoveryCodes: string[]; user?: AdminUser }> {
    if (this.accessToken) {
      return this.post<{ recoveryCodes: string[] }>("/api/auth/2fa/enable", { code });
    }
    const r = await this.raw<{ recoveryCodes: string[] } & Session>("POST", "/api/auth/2fa/enable", { challengeToken, code });
    this.accessToken = r.accessToken;
    return { recoveryCodes: r.recoveryCodes, user: r.user };
  }

  regenerateRecoveryCodes(password: string): Promise<{ recoveryCodes: string[] }> {
    return this.post<{ recoveryCodes: string[] }>("/api/auth/2fa/recovery-codes", { password });
  }

  changePassword(currentPassword: string, newPassword: string): Promise<Session> {
    return this.post<Session>("/api/auth/change-password", { currentPassword, newPassword }).then((s) => {
      this.accessToken = s.accessToken;
      return s;
    });
  }

  /** Cold-load session recovery from the refresh cookie. */
  async boot(): Promise<AdminUser | null> {
    try {
      const r = await this.raw<Session>("POST", "/api/auth/refresh");
      this.accessToken = r.accessToken;
      return r.user;
    } catch {
      this.accessToken = null;
      return null;
    }
  }

  async logout(): Promise<void> {
    await this.raw("POST", "/api/auth/logout").catch(() => undefined);
    this.accessToken = null;
  }
}

export const api = new ApiClient();
