import type { ApiConfig } from "../config.js";

/**
 * Klix hosted-checkout client (https://portal.klix.app/api/v1).
 *
 * Flow (developers.klix.app/api): create a purchase → redirect the customer to
 * its `checkout_url` → Klix calls our success_callback server-to-server →
 * we re-fetch the purchase by id and only then treat it as paid. The docs are
 * explicit: "consider purchase as successfully paid only after callback is
 * received and purchase status is checked" — callback payloads are never
 * trusted on their own.
 */

export interface KlixPurchaseInput {
  /** Total in integer cents (Klix product price unit). */
  amountCents: number;
  /** Line label shown on the checkout page (order ref + lot title). */
  name: string;
  /** Our order ref, stored by Klix as `reference`. */
  reference: string;
  clientEmail: string;
  /** Checkout page language: lv | ru | en | et | lt. */
  language: string;
  successCallback: string;
  successRedirect: string;
  failureRedirect: string;
  cancelRedirect: string;
  /**
   * Hard checkout expiry (the order's payment deadline). With due_strict the
   * purchase stops being payable past this moment — a stale checkout link
   * can't collect money for an order the admin has since cancelled.
   */
  dueAt?: Date | null;
}

export interface KlixPurchase {
  id: string;
  /** Raw Klix purchase status; "paid" is the only success value. */
  status: string;
  checkoutUrl: string | null;
}

export interface KlixClient {
  createPurchase(input: KlixPurchaseInput): Promise<KlixPurchase>;
  getPurchase(id: string): Promise<KlixPurchase | null>;
  /**
   * Return money to the customer (POST /purchases/<id>/refund/). Omitting
   * amountCents refunds the full remaining amount; passing it refunds
   * partially. Throws KlixError when the provider rejects (not paid, amount
   * exceeds the refundable remainder, already fully refunded…).
   */
  refundPurchase(id: string, amountCents?: number): Promise<KlixPurchase>;
  /**
   * Kill an unpaid checkout (POST /purchases/<id>/cancel/) so its link can
   * never collect money again. Used when a fresh checkout supersedes a stale
   * one — the double-payment guard.
   */
  cancelPurchase(id: string): Promise<KlixPurchase>;
}

export class KlixError extends Error {
  constructor(
    message: string,
    public status?: number,
  ) {
    super(message);
  }
}

class LiveKlixClient implements KlixClient {
  constructor(
    private readonly apiUrl: string,
    private readonly brandId: string,
    private readonly secretKey: string,
    private readonly methods: string[],
  ) {}

  private async call(path: string, init: RequestInit): Promise<Record<string, unknown> | null> {
    const res = await fetch(`${this.apiUrl}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${this.secretKey}`,
        "content-type": "application/json",
        ...init.headers,
      },
    });
    if (res.status === 404) return null;
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new KlixError(`Klix ${path} failed: ${res.status} ${body.slice(0, 300)}`, res.status);
    }
    return (await res.json()) as Record<string, unknown>;
  }

  async createPurchase(input: KlixPurchaseInput): Promise<KlixPurchase> {
    const body: Record<string, unknown> = {
      brand_id: this.brandId,
      reference: input.reference,
      client: { email: input.clientEmail },
      purchase: {
        language: input.language,
        products: [{ name: input.name, price: input.amountCents }],
        ...(input.dueAt ? { due_strict: true } : {}),
      },
      ...(input.dueAt ? { due: Math.floor(input.dueAt.getTime() / 1000) } : {}),
      success_callback: input.successCallback,
      success_redirect: input.successRedirect,
      failure_redirect: input.failureRedirect,
      cancel_redirect: input.cancelRedirect,
    };
    // Empty whitelist = every method enabled on the brand (cards, BNPL,
    // banklinks) selectable on the Klix checkout page.
    if (this.methods.length > 0) body.payment_method_whitelist = this.methods;
    const json = await this.call("/purchases/", { method: "POST", body: JSON.stringify(body) });
    if (!json) throw new KlixError("Klix /purchases/ returned 404");
    return toPurchase(json);
  }

  async getPurchase(id: string): Promise<KlixPurchase | null> {
    const json = await this.call(`/purchases/${id}/`, { method: "GET" });
    return json ? toPurchase(json) : null;
  }

  async refundPurchase(id: string, amountCents?: number): Promise<KlixPurchase> {
    const json = await this.call(`/purchases/${id}/refund/`, {
      method: "POST",
      body: JSON.stringify(amountCents !== undefined ? { amount: amountCents } : {}),
    });
    if (!json) throw new KlixError(`Klix /purchases/${id}/refund/ returned 404`, 404);
    return toPurchase(json);
  }

  async cancelPurchase(id: string): Promise<KlixPurchase> {
    const json = await this.call(`/purchases/${id}/cancel/`, { method: "POST", body: "{}" });
    if (!json) throw new KlixError(`Klix /purchases/${id}/cancel/ returned 404`, 404);
    return toPurchase(json);
  }
}

function toPurchase(json: Record<string, unknown>): KlixPurchase {
  return {
    id: String(json.id),
    status: String(json.status ?? ""),
    checkoutUrl: typeof json.checkout_url === "string" ? json.checkout_url : null,
  };
}

/**
 * Test driver: purchases live in memory; the suite flips a purchase to any
 * provider status via `setStatus` and then exercises the callback exactly the
 * way Klix would (hit the endpoint → handler re-fetches → settles).
 */
interface SimulatedPurchase extends KlixPurchase {
  reference: string;
  amountCents: number;
  refundedCents: number;
  /** The full creation input, kept so tests can assert on due/redirects. */
  input: KlixPurchaseInput;
}

export class SimulatedKlixClient implements KlixClient {
  private purchases = new Map<string, SimulatedPurchase>();
  private seq = 0;

  async createPurchase(input: KlixPurchaseInput): Promise<KlixPurchase> {
    const id = `sim-${++this.seq}-${input.reference}`;
    const purchase: SimulatedPurchase = {
      id,
      status: "created",
      checkoutUrl: `https://klix.simulated/checkout/${id}`,
      reference: input.reference,
      amountCents: input.amountCents,
      refundedCents: 0,
      input,
    };
    this.purchases.set(id, purchase);
    return purchase;
  }

  async getPurchase(id: string): Promise<KlixPurchase | null> {
    return this.purchases.get(id) ?? null;
  }

  async refundPurchase(id: string, amountCents?: number): Promise<KlixPurchase> {
    const p = this.purchases.get(id);
    if (!p) throw new KlixError(`no simulated purchase ${id}`, 404);
    // Mirror the provider's rules: only money that was actually collected
    // (and not yet returned) can go back.
    if (p.status !== "paid" && p.status !== "refunded") {
      throw new KlixError(`purchase ${id} is not refundable (status ${p.status})`, 400);
    }
    const remaining = p.amountCents - p.refundedCents;
    const amount = amountCents ?? remaining;
    if (amount <= 0 || amount > remaining) {
      throw new KlixError(`refund amount ${amount} exceeds refundable remainder ${remaining}`, 400);
    }
    p.refundedCents += amount;
    if (p.refundedCents >= p.amountCents) p.status = "refunded";
    return p;
  }

  async cancelPurchase(id: string): Promise<KlixPurchase> {
    const p = this.purchases.get(id);
    if (!p) throw new KlixError(`no simulated purchase ${id}`, 404);
    if (p.status === "paid" || p.status === "refunded") {
      throw new KlixError(`purchase ${id} already ${p.status} — cannot cancel`, 400);
    }
    p.status = "cancelled";
    return p;
  }

  /** Inspect a purchase with simulator-only fields (refund totals, input). */
  inspect(id: string): SimulatedPurchase | null {
    return this.purchases.get(id) ?? null;
  }

  setStatus(id: string, status: string): void {
    const p = this.purchases.get(id);
    if (!p) throw new Error(`no simulated purchase ${id}`);
    p.status = status;
  }
}

export function createKlixClient(config: ApiConfig): KlixClient | null {
  if (config.klixMode === "off" || !config.klix) return null;
  if (config.klixMode === "simulate") return new SimulatedKlixClient();
  return new LiveKlixClient(config.klix.apiUrl, config.klix.brandId, config.klix.secretKey, config.klix.methods);
}
