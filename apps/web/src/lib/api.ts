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
      this.tokens = this.readStored();
      // Вкладки делят одну сессию: вход, ротация токенов или выход в любой
      // из них немедленно доезжает до остальных. Без этого вторая вкладка
      // жила со старым refresh-токеном и случайно выбрасывала из аккаунта.
      window.addEventListener("storage", (e) => {
        if (e.key !== STORAGE_KEY) return;
        const next = this.readStored();
        const was = this.tokens !== null;
        this.tokens = next;
        if (was !== (next !== null)) {
          (window as unknown as { dataLayer?: Array<Record<string, unknown>> }).dataLayer
            ?.push({ event: "user_identity", user_id: next ? this.bidderId : null });
        }
        for (const fn of this.listeners) fn();
      });
    }
  }

  /** Свежая пара из localStorage — её могла обновить соседняя вкладка. */
  private readStored(): Tokens | null {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? (JSON.parse(raw) as Tokens) : null;
    } catch {
      return null;
    }
  }

  get accessToken(): string | null {
    return this.tokens?.accessToken ?? null;
  }
  get hasSession(): boolean {
    return this.tokens !== null;
  }

  /** Внутренний UUID аккаунта из токена сессии — для GA4 User-ID.
   *  Никаких персональных данных: только случайный идентификатор базы. */
  get bidderId(): string | null {
    const token = this.tokens?.accessToken;
    if (!token) return null;
    try {
      const payload = JSON.parse(atob(token.split(".")[1]!.replace(/-/g, "+").replace(/_/g, "/"))) as { sub?: string };
      return payload.sub ?? null;
    } catch {
      return null;
    }
  }

  private setTokens(t: Tokens | null): void {
    this.tokens = t;
    if (typeof window !== "undefined") {
      if (t) localStorage.setItem(STORAGE_KEY, JSON.stringify(t));
      else localStorage.removeItem(STORAGE_KEY);
      // GA4 User-ID: вход/выход мгновенно обновляет личность в dataLayer;
      // выход обязан явно прислать null, чтобы события гостя не клеились
      // к прошлому аккаунту.
      (window as unknown as { dataLayer?: Array<Record<string, unknown>> }).dataLayer
        ?.push({ event: "user_identity", user_id: t ? this.bidderId : null });
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

  /** Одно обновление на всех: параллельные 401 ждут общий результат,
   *  а не жгут одноразовый refresh-токен наперегонки. */
  private refreshing: Promise<boolean> | null = null;

  private refreshOnce(): Promise<boolean> {
    this.refreshing ??= this.doRefresh().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async doRefresh(): Promise<boolean> {
    const mine = this.tokens;
    if (!mine) return false;
    // Соседняя вкладка уже успела обновить пару — берём её, не тратя токен.
    const stored = this.readStored();
    if (stored && stored.accessToken !== mine.accessToken) {
      this.setTokens(stored);
      return true;
    }
    try {
      const r = await this.raw<Tokens>("POST", "/api/public/auth/refresh", {
        refreshToken: mine.refreshToken,
      });
      this.setTokens({ accessToken: r.accessToken, refreshToken: r.refreshToken });
      return true;
    } catch (err) {
      // Хоронить сессию можно только по слову сервера. Оборванная сеть или
      // 500 — не повод разлогинивать: запрос упадёт, человек останется в
      // аккаунте, следующий запрос попробует снова.
      if (!(err instanceof PublicApiError) || err.status !== 401) return false;
      const latest = this.readStored();
      if (latest && latest.accessToken !== mine.accessToken) {
        this.setTokens(latest);
        return true;
      }
      this.setTokens(null);
      return false;
    }
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    try {
      return await this.raw<T>(method, path, body);
    } catch (err) {
      if (err instanceof PublicApiError && err.status === 401 && this.tokens) {
        if (await this.refreshOnce()) return await this.raw<T>(method, path, body);
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

  async register(input: { email: string; alias: string; password: string; country?: string; marketingOptIn?: boolean }): Promise<Bidder> {
    const r = await this.raw<Tokens & { bidder: Bidder }>("POST", "/api/public/auth/register", input);
    this.setTokens({ accessToken: r.accessToken, refreshToken: r.refreshToken });
    return r.bidder;
  }

  async login(email: string, password: string): Promise<Bidder> {
    const r = await this.raw<Tokens & { bidder: Bidder }>("POST", "/api/public/auth/login", { email, password });
    this.setTokens({ accessToken: r.accessToken, refreshToken: r.refreshToken });
    return r.bidder;
  }

  /** Ask for a password-reset email. Always resolves ok (no account signal). */
  forgotPassword(email: string): Promise<{ ok: true }> {
    return this.raw<{ ok: true }>("POST", "/api/public/auth/forgot-password", { email });
  }

  /** Set a new password using the token from the emailed link. */
  resetPassword(token: string, newPassword: string): Promise<{ ok: true }> {
    return this.raw<{ ok: true }>("POST", "/api/public/auth/reset-password", { token, newPassword });
  }

  /** Подтверждение адреса по токену из письма. */
  verifyEmail(token: string): Promise<{ ok: true }> {
    return this.raw<{ ok: true }>("POST", "/api/public/auth/verify-email", { token });
  }

  /** Выслать письмо повторно. Без сессии — по адресу, с сессией — себе. */
  resendVerification(email?: string): Promise<{ ok: true }> {
    return this.request<{ ok: true }>("POST", "/api/public/auth/verify-email/resend",
      email ? { email } : {});
  }

  /** Токены после соцвхода: сервер отдаёт их фрагментом ссылки (#a=…&r=…),
   *  SocialCatch подбирает и кладёт сюда — дальше всё как при обычном входе. */
  adoptTokens(accessToken: string, refreshToken: string): void {
    this.setTokens({ accessToken, refreshToken });
  }

  logout(): void {
    const t = this.tokens;
    this.setTokens(null);
    // Токен гаснет и на сервере — стереть его только из браузера мало.
    // Молча и в фоне: выходу не мешает даже упавшая сеть.
    if (t) {
      void this.raw("POST", "/api/public/auth/logout", { refreshToken: t.refreshToken }).catch(() => {});
    }
    // Следы оформления принадлежат человеку, а не браузеру: следующий, кто
    // сядет за этот экран, начинает свой checkout с чистого листа.
    // (Вишлист чистит watch.ts по тому же сигналу listeners.)
    try {
      sessionStorage.removeItem("izsoli_checkout_v1");
      for (const k of Object.keys(localStorage)) {
        if (k.startsWith("izsoli_ga_bc_")) localStorage.removeItem(k);
      }
    } catch {
      // приватный режим без storage — выходу это не мешает
    }
  }
}

export const publicApi = new PublicApi();
