"use client";

import { PUBLIC_API_URL } from "./config";
import type { Bidder } from "./types";

/** Browser client for the public API with bidder-token refresh. */

const STORAGE_KEY = "auction_bidder_tokens";

interface Tokens {
  accessToken: string;
  refreshToken: string;
}

export class PublicApiError extends Error {
  constructor(
    public status: number,
    public body: Record<string, unknown>,
  ) {
    super(typeof body.error === "string" ? body.error : `HTTP ${status}`);
  }
}

class PublicApi {
  private tokens: Tokens | null = null;
  listeners = new Set<() => void>();

  constructor() {
    if (typeof window !== "undefined") {
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) this.tokens = JSON.parse(raw) as Tokens;
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
    if (typeof window !== "undefined") {
      if (t) localStorage.setItem(STORAGE_KEY, JSON.stringify(t));
      else localStorage.removeItem(STORAGE_KEY);
    }
    for (const fn of this.listeners) fn();
  }

  private async raw<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${PUBLIC_API_URL}${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...(this.tokens ? { authorization: `Bearer ${this.tokens.accessToken}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) throw new PublicApiError(res.status, json);
    return json as T;
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    try {
      return await this.raw<T>(method, path, body);
    } catch (err) {
      if (err instanceof PublicApiError && err.status === 401 && this.tokens) {
        try {
          const r = await this.raw<Tokens>("POST", "/api/public/auth/refresh", {
            refreshToken: this.tokens.refreshToken,
          });
          this.setTokens({ accessToken: r.accessToken, refreshToken: r.refreshToken });
          return await this.raw<T>(method, path, body);
        } catch {
          this.setTokens(null);
        }
      }
      throw err;
    }
  }

  get<T>(path: string): Promise<T> {
    return this.request<T>("GET", path);
  }
  post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("POST", path, body);
  }

  async register(input: { email: string; alias: string; password: string; country?: string }): Promise<Bidder> {
    const r = await this.raw<Tokens & { bidder: Bidder }>("POST", "/api/public/auth/register", input);
    this.setTokens({ accessToken: r.accessToken, refreshToken: r.refreshToken });
    return r.bidder;
  }

  async login(email: string, password: string): Promise<Bidder> {
    const r = await this.raw<Tokens & { bidder: Bidder }>("POST", "/api/public/auth/login", { email, password });
    this.setTokens({ accessToken: r.accessToken, refreshToken: r.refreshToken });
    return r.bidder;
  }

  logout(): void {
    this.setTokens(null);
  }
}

export const publicApi = new PublicApi();
