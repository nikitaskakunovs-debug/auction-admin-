"use client";

import { PUBLIC_API_URL } from "./config";

/**
 * Клиент кабинета поставщика. Отдельный от покупательского намеренно:
 * это другая дверь с другим токеном, и смешивать их хранилища нельзя —
 * иначе вход поставщика на общем компьютере утащил бы чужую сессию.
 */

const STORAGE_KEY = "izsoli_supplier_token";

export class SupplierApiError extends Error {
  constructor(
    public status: number,
    public body: Record<string, unknown>,
  ) {
    super(typeof body.error === "string" ? body.error : `HTTP ${status}`);
  }
}

class SupplierApi {
  private token: string | null = null;

  constructor() {
    if (typeof window !== "undefined") {
      try {
        this.token = localStorage.getItem(STORAGE_KEY);
      } catch {
        this.token = null;
      }
    }
  }

  get hasSession(): boolean {
    return this.token !== null;
  }

  setToken(token: string | null): void {
    this.token = token;
    try {
      if (token) localStorage.setItem(STORAGE_KEY, token);
      else localStorage.removeItem(STORAGE_KEY);
    } catch {
      // Приватный режим браузера: сессия проживёт до перезагрузки страницы.
    }
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${PUBLIC_API_URL}${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      // Токен кабинета живёт долго, но не вечно: истёк — возвращаем ко входу.
      if (res.status === 401) this.setToken(null);
      throw new SupplierApiError(res.status, json);
    }
    return json as T;
  }

  get = <T,>(path: string): Promise<T> => this.request<T>("GET", path);
  post = <T,>(path: string, body?: unknown): Promise<T> => this.request<T>("POST", path, body);
  patch = <T,>(path: string, body?: unknown): Promise<T> => this.request<T>("PATCH", path, body);
}

export const supplierApi = new SupplierApi();

// ── Формы ответов кабинета ──────────────────────────────────────────────────

export interface SupplierSummary {
  supplier: { name: string; model: string; commissionPercent: number; paymentTermsDays: number; lang: string };
  deliveries: { announced: number; open: number; awaitingReply: number };
  stock: { inStock: number; sold: number };
  money: { outstandingCents: number; nextDueDate: string | null };
}

export interface SupplierDelivery {
  id: string;
  ref: string;
  status: string;
  expectedCount: number;
  receivedCount: number;
  plannedAt: string | null;
  createdAt: string;
  closedAt: string | null;
  discrepancyStatus: string;
  discrepancyNote: string | null;
  discrepancyDueAt: string | null;
  discrepancyReply: string | null;
}

export interface SupplierSales {
  period: { from: string; to: string };
  lots: Array<{ title: string; sku: string; priceCents: number; paidAt: string | null; consignmentRef: string }>;
  totals: {
    soldCount: number;
    grossCents: number;
    commissionCents: number;
    payoutCents: number;
    inStock: number;
    sellThroughPercent: number;
  };
}

export interface SupplierInvoices {
  invoices: Array<{
    id: string;
    number: string;
    invoiceDate: string;
    dueDate: string;
    amountCents: number;
    paidCents: number;
    status: string;
    approvalStatus: string;
    rejectedReason: string | null;
    consignmentRef: string | null;
  }>;
  payments: Array<{ id: string; amountCents: number; paidAt: string; method: string; invoiceNumber: string }>;
}

export interface SupplierProfile {
  profile: {
    name: string;
    regNo: string;
    vatNo: string;
    email: string;
    phone: string;
    address: string;
    contactName: string;
    lang: string;
    bankAccount: string;
    pendingBankAccount: string | null;
    model: string;
    commissionPercent: number;
    paymentTermsDays: number;
  };
}
