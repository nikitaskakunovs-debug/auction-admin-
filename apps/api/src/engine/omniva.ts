import type { ApiConfig } from "../config.js";

/**
 * Omniva OMX client (omniva.lv → business → API; verified against the
 * official omniva-baltic/omniva-api-lib). HTTP Basic auth with the customer
 * code as username. Endpoints used:
 *
 *   POST shipments/business-to-client   register → { savedShipments: [{ barcode }] }
 *   POST shipments/package-labels       labels   → { successAddressCards: [{ barcode, fileData: <base64 PDF> }] }
 *   GET  shipments/<barcode>            tracking events
 *
 * Parcel-machine delivery = mainService PARCEL + deliveryChannel
 * PARCEL_MACHINE + the machine's ZIP as the receiver's offloadPostcode.
 * The public machine list comes from omniva.ee/locations.json (TYPE 0 =
 * parcel machine), cached in Redis by the shipping routes.
 */

export interface OmnivaLocation {
  id: string;
  name: string;
  zip: string;
  country: string; // A0 code: LV | EE | LT
  county: string;
  city: string;
  address: string;
}

/** Provider-neutral shipment input — shared by the Omniva and DPD clients. */
export interface OmnivaShipmentInput {
  /** Our order ref — becomes partnerShipmentId / clientItemId. */
  reference: string;
  receiver: {
    name: string;
    phone: string;
    email: string;
    /** Destination machine/locker id (Omniva: ZIP; DPD: pudoId). */
    machineId: string;
    machineZip: string;
    country: string;
  };
  sender: ApiConfig["shipSender"];
  weightGrams: number | null;
  comment: string;
}

export interface OmnivaShipment {
  barcode: string;
  raw: Record<string, unknown>;
}

export interface OmnivaEvents {
  /** Raw carrier event list, newest first. */
  events: Array<{ code: string; at: string; description?: string | undefined; location?: string | undefined }>;
  raw: Record<string, unknown>;
}

export interface OmnivaClient {
  registerShipment(input: OmnivaShipmentInput): Promise<OmnivaShipment>;
  /** Base64-encoded A4/label PDF for the barcode. */
  getLabel(barcode: string): Promise<string>;
  getEvents(barcode: string): Promise<OmnivaEvents | null>;
  /** All parcel machines for a country (uncached — routes cache in Redis). */
  listLocations(country: string): Promise<OmnivaLocation[]>;
}

export class OmnivaError extends Error {
  constructor(
    message: string,
    public status?: number,
  ) {
    super(message);
  }
}

const LOCATIONS_URL = "https://www.omniva.ee/locations.json";

class LiveOmnivaClient implements OmnivaClient {
  constructor(
    private readonly apiUrl: string,
    private readonly username: string,
    private readonly password: string,
  ) {}

  private authHeader(): string {
    return `Basic ${Buffer.from(`${this.username}:${this.password}`).toString("base64")}`;
  }

  private async call(path: string, init: RequestInit): Promise<Record<string, unknown> | null> {
    const res = await fetch(`${this.apiUrl}/${path}`, {
      ...init,
      headers: {
        authorization: this.authHeader(),
        "content-type": "application/json;charset=utf-8",
        accept: "application/json",
        ...init.headers,
      },
    });
    const text = await res.text().catch(() => "");
    if (res.status === 404) return null;
    if (!res.ok) {
      // OMX returns structured errors on 400/403/5xx — surface the details.
      let detail = text.slice(0, 300);
      try {
        const err = JSON.parse(text) as { title?: string; details?: string; failedShipments?: Array<{ message?: string }> };
        detail =
          err.failedShipments?.map((f) => f.message).join("; ") ||
          [err.title, err.details].filter(Boolean).join(": ") ||
          detail;
      } catch {
        // non-JSON error body — keep the raw slice
      }
      throw new OmnivaError(`Omniva ${path} failed: ${res.status} ${detail}`, res.status);
    }
    return JSON.parse(text) as Record<string, unknown>;
  }

  async registerShipment(input: OmnivaShipmentInput): Promise<OmnivaShipment> {
    const body = {
      customerCode: this.username,
      shipments: [
        {
          mainService: "PARCEL",
          deliveryChannel: "PARCEL_MACHINE",
          partnerShipmentId: input.reference,
          shipmentComment: input.comment.slice(0, 128),
          returnAllowed: false,
          paidByReceiver: false,
          receiverAddressee: {
            personName: input.receiver.name,
            contactMobile: input.receiver.phone,
            contactEmail: input.receiver.email,
            address: {
              offloadPostcode: input.receiver.machineZip,
              country: input.receiver.country,
            },
          },
          senderAddressee: {
            companyName: input.sender.name,
            contactPhone: input.sender.phone,
            contactEmail: input.sender.email,
            address: {
              postcode: input.sender.postcode,
              deliverypoint: input.sender.city,
              street: input.sender.street,
              country: input.sender.country,
            },
          },
          ...(input.weightGrams
            ? { measurement: { weight: Math.max(0.01, input.weightGrams / 1000) } }
            : {}),
        },
      ],
    };
    const json = await this.call("shipments/business-to-client", { method: "POST", body: JSON.stringify(body) });
    if (!json) throw new OmnivaError("Omniva registration returned no response");
    const failed = (json.failedShipments as Array<{ message?: string }> | undefined) ?? [];
    if (failed.length > 0) {
      throw new OmnivaError(`Omniva rejected the shipment: ${failed.map((f) => f.message).join("; ")}`);
    }
    const saved = (json.savedShipments as Array<{ barcode?: string }> | undefined) ?? [];
    const barcode = saved[0]?.barcode;
    if (!barcode) throw new OmnivaError("Omniva returned no barcode");
    return { barcode, raw: json };
  }

  async getLabel(barcode: string): Promise<string> {
    const json = await this.call("shipments/package-labels", {
      method: "POST",
      body: JSON.stringify({ customerCode: this.username, barcodes: [barcode] }),
    });
    if (!json) throw new OmnivaError("Omniva label request returned no response");
    const cards = (json.successAddressCards as Array<{ barcode?: string; fileData?: string }> | undefined) ?? [];
    const fileData = cards.find((c) => c.barcode === barcode)?.fileData ?? cards[0]?.fileData;
    if (!fileData) {
      const failed = (json.failedAddressCards as Array<{ messageCode?: string }> | undefined) ?? [];
      throw new OmnivaError(`Omniva returned no label${failed.length ? `: ${failed.map((f) => f.messageCode).join("; ")}` : ""}`);
    }
    return fileData;
  }

  async getEvents(barcode: string): Promise<OmnivaEvents | null> {
    const json = await this.call(`shipments/${encodeURIComponent(barcode)}`, { method: "GET" });
    if (!json) return null;
    // Event list shape per the OMX manual ("possible events for event
    // request"): eventCode + eventDate (+ zip/name of the location).
    const rawEvents = (json.events as Array<Record<string, unknown>> | undefined) ?? [];
    const events = rawEvents
      .map((e) => ({
        code: String(e.eventCode ?? e.code ?? ""),
        at: String(e.eventDate ?? e.date ?? e.at ?? ""),
        description: typeof e.eventName === "string" ? e.eventName : typeof e.description === "string" ? e.description : undefined,
        location: typeof e.eventSourceName === "string" ? e.eventSourceName : typeof e.location === "string" ? e.location : undefined,
      }))
      .filter((e) => e.code);
    return { events, raw: json };
  }

  async listLocations(country: string): Promise<OmnivaLocation[]> {
    const res = await fetch(LOCATIONS_URL, { headers: { accept: "application/json" } });
    if (!res.ok) throw new OmnivaError(`locations.json failed: ${res.status}`, res.status);
    const all = (await res.json()) as Array<Record<string, unknown>>;
    return all
      .filter((l) => String(l.TYPE) === "0" && String(l.A0_NAME).toUpperCase() === country.toUpperCase())
      .map((l) => ({
        id: String(l.ZIP),
        name: String(l.NAME),
        zip: String(l.ZIP),
        country: String(l.A0_NAME).toUpperCase(),
        county: String(l.A1_NAME ?? ""),
        city: String(l.A2_NAME ?? ""),
        address: [l.A5_NAME, l.A7_NAME].filter(Boolean).join(" ") || String(l.A2_NAME ?? ""),
      }));
  }
}

/** In-memory driver for the test suite. */
export class SimulatedOmnivaClient implements OmnivaClient {
  private shipments = new Map<string, { input: OmnivaShipmentInput; events: OmnivaEvents["events"] }>();
  private seq = 0;

  static readonly LOCATIONS: OmnivaLocation[] = [
    { id: "9910", name: "Rīgas Origo T/C pakomāts", zip: "9910", country: "LV", county: "Rīga", city: "Rīga", address: "Stacijas laukums 2" },
    { id: "9920", name: "Ogres Rimi pakomāts", zip: "9920", country: "LV", county: "Ogres nov.", city: "Ogre", address: "Rīgas iela 23" },
    { id: "8800", name: "Tallinna Kristiine keskus", zip: "8800", country: "EE", county: "Harju", city: "Tallinn", address: "Endla 45" },
  ];

  async registerShipment(input: OmnivaShipmentInput): Promise<OmnivaShipment> {
    const barcode = `CE${String(++this.seq).padStart(9, "0")}LV`;
    this.shipments.set(barcode, {
      input,
      events: [{ code: "PACKET_REGISTERED", at: new Date(0).toISOString(), description: "Shipment registered" }],
    });
    return { barcode, raw: { savedShipments: [{ barcode, clientItemId: input.reference }] } };
  }

  async getLabel(barcode: string): Promise<string> {
    if (!this.shipments.has(barcode)) throw new OmnivaError(`no simulated shipment ${barcode}`, 404);
    // A minimal valid one-page PDF, base64-encoded — enough for the proxy
    // endpoint and admin print flow to be exercised end to end.
    const pdf = `%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 420]>>endobj\nxref\n0 4\ntrailer<</Size 4/Root 1 0 R>>\n%%EOF\nLABEL:${barcode}`;
    return Buffer.from(pdf).toString("base64");
  }

  async getEvents(barcode: string): Promise<OmnivaEvents | null> {
    const s = this.shipments.get(barcode);
    if (!s) return null;
    return { events: [...s.events].reverse(), raw: { barcode, events: s.events } };
  }

  async listLocations(country: string): Promise<OmnivaLocation[]> {
    return SimulatedOmnivaClient.LOCATIONS.filter((l) => l.country === country.toUpperCase());
  }

  /** Test hook: append a carrier event to a shipment. */
  addEvent(barcode: string, code: string, description?: string): void {
    const s = this.shipments.get(barcode);
    if (!s) throw new Error(`no simulated shipment ${barcode}`);
    s.events.push({ code, at: new Date(s.events.length * 1000).toISOString(), description });
  }

  inspect(barcode: string) {
    return this.shipments.get(barcode) ?? null;
  }
}

export function createOmnivaClient(config: ApiConfig): OmnivaClient | null {
  if (config.omnivaMode === "off" || !config.omniva) return null;
  if (config.omnivaMode === "simulate") return new SimulatedOmnivaClient();
  return new LiveOmnivaClient(config.omniva.apiUrl, config.omniva.username, config.omniva.password);
}

/** Map a carrier event code to our shipment lifecycle status. */
export function shipmentStatusFromEvents(events: OmnivaEvents["events"]): "registered" | "in_transit" | "delivered" {
  // Per Omniva's "possible events" spec: delivery to the customer is
  // PACKET_DELIVERED_TO_CLIENT / DELIVERED; anything beyond registration
  // means the parcel is moving.
  for (const e of events) {
    const c = e.code.toUpperCase();
    if (c.includes("DELIVERED_TO_CLIENT") || c === "DELIVERED" || c.includes("HANDED_OVER_TO_CLIENT")) return "delivered";
  }
  const moving = events.some((e) => !["PACKET_REGISTERED", "REGISTERED"].includes(e.code.toUpperCase()));
  return moving ? "in_transit" : "registered";
}
