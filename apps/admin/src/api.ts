/** Typed API client. All money fields are integer euro cents. */

export interface AdminUser {
  id: string;
  email: string;
  name: string;
  role: string;
  permissions: string[];
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
  active: boolean;
}

export interface Item {
  id: string;
  sku: string;
  title: string;
  description: string;
  condition: string;
  location: string;
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
  totalCents: number;
  reverseCharge: boolean;
  status: string;
  paymentDeadlineAt: string | null;
  paidAt: string | null;
  createdAt: string;
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

type Tokens = { accessToken: string; refreshToken: string };

const STORAGE_KEY = "auction_admin_tokens";

export class ApiClient {
  private tokens: Tokens | null = null;
  onUnauthenticated: (() => void) | null = null;

  constructor() {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      try {
        this.tokens = JSON.parse(raw) as Tokens;
      } catch {
        this.tokens = null;
      }
    }
  }

  get accessToken(): string | null {
    return this.tokens?.accessToken ?? null;
  }

  get hasSession(): boolean {
    return this.tokens !== null;
  }

  private setTokens(t: Tokens | null): void {
    this.tokens = t;
    if (t) localStorage.setItem(STORAGE_KEY, JSON.stringify(t));
    else localStorage.removeItem(STORAGE_KEY);
  }

  private async raw<T>(method: string, url: string, body?: unknown): Promise<T> {
    const res = await fetch(url, {
      method,
      headers: {
        // content-type only when a body is present — Fastify 400s on an
        // empty JSON body otherwise.
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...(this.tokens ? { authorization: `Bearer ${this.tokens.accessToken}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 204) return undefined as T;
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) throw new ApiError(res.status, json);
    return json as T;
  }

  /** Request with a single transparent refresh-and-retry on 401. */
  async request<T>(method: string, url: string, body?: unknown): Promise<T> {
    try {
      return await this.raw<T>(method, url, body);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401 && this.tokens) {
        try {
          const r = await this.raw<Tokens & { user: AdminUser }>("POST", "/api/auth/refresh", {
            refreshToken: this.tokens.refreshToken,
          });
          this.setTokens({ accessToken: r.accessToken, refreshToken: r.refreshToken });
          return await this.raw<T>(method, url, body);
        } catch {
          this.setTokens(null);
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
  delete<T>(url: string): Promise<T> {
    return this.request<T>("DELETE", url);
  }

  async login(email: string, password: string): Promise<AdminUser> {
    const r = await this.raw<Tokens & { user: AdminUser }>("POST", "/api/auth/login", { email, password });
    this.setTokens({ accessToken: r.accessToken, refreshToken: r.refreshToken });
    return r.user;
  }

  async me(): Promise<AdminUser | null> {
    if (!this.tokens) return null;
    try {
      const r = await this.request<{ user: AdminUser }>("GET", "/api/auth/me");
      return r.user;
    } catch {
      return null;
    }
  }

  async logout(): Promise<void> {
    if (this.tokens) {
      await this.raw("POST", "/api/auth/logout", { refreshToken: this.tokens.refreshToken }).catch(() => undefined);
    }
    this.setTokens(null);
  }
}

export const api = new ApiClient();
