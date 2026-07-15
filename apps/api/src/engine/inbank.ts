import type { ApiConfig } from "../config.js";

/**
 * Inbank e-POS client (docs.inbank.eu → e-POS flow). BNPL / hire-purchase
 * through Inbank's HOSTED environment:
 *
 *   POST /shops/<shopUuid>/pos-sessions → { uuid, status, redirectUrl }
 *   → redirect the customer to redirectUrl (Inbank runs the whole credit
 *     application there) → Inbank calls our callback URL server-to-server on
 *     status changes → GET /shops/<shopUuid>/pos-sessions/<uuid> to verify.
 *
 * Trust model matches Klix: callbacks are hints, never proof — the order is
 * settled only when a direct GET shows the session `completed` (the docs are
 * explicit that ONLY `completed` means the order is paid; `granted` is just
 * credit approval and may still require contract signing/activation).
 *
 * NOTE for onboarding: request-body field names below follow the e-POS docs
 * as published; docs.inbank.eu blocks automated retrieval, so verify the
 * exact casing against the partner documentation (or one demo-api call) when
 * the credentials arrive — the mapping is centralized in createSession().
 */

export interface InbankSessionInput {
  /** Total in integer cents; Inbank speaks decimal euros — converted here. */
  amountCents: number;
  /** Our order ref, carried as the session reference. */
  reference: string;
  redirectUrl: string;
  cancelUrl: string;
  callbackUrl: string;
}

export interface InbankSession {
  id: string;
  /** Raw Inbank session status; "completed" is the only paid-equivalent. */
  status: string;
  redirectUrl: string | null;
}

export interface InbankClient {
  createSession(input: InbankSessionInput): Promise<InbankSession>;
  getSession(id: string): Promise<InbankSession | null>;
}

export class InbankError extends Error {
  constructor(
    message: string,
    public status?: number,
  ) {
    super(message);
  }
}

class LiveInbankClient implements InbankClient {
  constructor(
    private readonly apiUrl: string,
    private readonly shopUuid: string,
    private readonly apiKey: string,
    private readonly productCode: string | null,
  ) {}

  private async call(path: string, init: RequestInit): Promise<Record<string, unknown> | null> {
    const res = await fetch(`${this.apiUrl}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/json",
        accept: "application/json",
        ...init.headers,
      },
    });
    if (res.status === 404) return null;
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new InbankError(`Inbank ${path} failed: ${res.status} ${body.slice(0, 300)}`, res.status);
    }
    return (await res.json()) as Record<string, unknown>;
  }

  async createSession(input: InbankSessionInput): Promise<InbankSession> {
    const body: Record<string, unknown> = {
      amount: (input.amountCents / 100).toFixed(2),
      currency: "EUR",
      reference: input.reference,
      redirectUrl: input.redirectUrl,
      cancelUrl: input.cancelUrl,
      callbackUrl: input.callbackUrl,
    };
    if (this.productCode) body.productCode = this.productCode;
    const json = await this.call(`/shops/${this.shopUuid}/pos-sessions`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    if (!json) throw new InbankError("Inbank pos-sessions returned 404");
    return toSession(json);
  }

  async getSession(id: string): Promise<InbankSession | null> {
    const json = await this.call(`/shops/${this.shopUuid}/pos-sessions/${id}`, { method: "GET" });
    return json ? toSession(json) : null;
  }
}

function toSession(json: Record<string, unknown>): InbankSession {
  return {
    id: String(json.uuid ?? json.id),
    status: String(json.status ?? ""),
    redirectUrl:
      typeof json.redirectUrl === "string" ? json.redirectUrl : typeof json.redirect_url === "string" ? json.redirect_url : null,
  };
}

/** In-memory driver for the test suite — mirrors SimulatedKlixClient. */
export class SimulatedInbankClient implements InbankClient {
  private sessions = new Map<string, InbankSession & { reference: string; amountCents: number; input: InbankSessionInput }>();
  private seq = 0;

  async createSession(input: InbankSessionInput): Promise<InbankSession> {
    const id = `inb-${++this.seq}-${input.reference}`;
    const session = {
      id,
      status: "pending",
      redirectUrl: `https://inbank.simulated/session/${id}`,
      reference: input.reference,
      amountCents: input.amountCents,
      input,
    };
    this.sessions.set(id, session);
    return session;
  }

  async getSession(id: string): Promise<InbankSession | null> {
    return this.sessions.get(id) ?? null;
  }

  setStatus(id: string, status: string): void {
    const s = this.sessions.get(id);
    if (!s) throw new Error(`no simulated inbank session ${id}`);
    s.status = status;
  }

  inspect(id: string) {
    return this.sessions.get(id) ?? null;
  }
}

export function createInbankClient(config: ApiConfig): InbankClient | null {
  if (config.inbankMode === "off" || !config.inbank) return null;
  if (config.inbankMode === "simulate") return new SimulatedInbankClient();
  return new LiveInbankClient(config.inbank.apiUrl, config.inbank.shopUuid, config.inbank.apiKey, config.inbank.productCode);
}
