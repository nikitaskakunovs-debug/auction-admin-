import type { ApiConfig } from "../config.js";
import { OmnivaError, type OmnivaClient, type OmnivaEvents, type OmnivaLocation, type OmnivaShipment, type OmnivaShipmentInput } from "./omniva.js";

/**
 * DPD Baltic client ("Amber" API — dpd.com Baltic API documentation,
 * verified against the community dpd-api-lib that wraps it). Bearer-token
 * auth. Per-country hosts: eserviss.dpd.lv (LV), esiunta.dpd.lt (LT),
 * telli.dpd.ee (EE), each with a sandbox- prefixed test twin.
 *
 *   POST /shipments          [{senderAddress, receiverAddress{..pudoId},
 *                              service{serviceAlias}, parcels:[{weight}]}]
 *                            → saved shipments with uuid + parcel numbers
 *   POST /shipments/labels   {shipmentIds, labelFormat: application/pdf,
 *                              paperSize, downloadLabel} → label PDF
 *   GET  /lockers            locker list (id/pudoId, name, address, city)
 *   GET  /status/tracking    parcel events
 *
 * Locker delivery = receiverAddress.pudoId + the locker service alias
 * (DPD_SERVICE_ALIAS, default "DPD PUDO" — confirm the exact alias with
 * GET /services during onboarding; it depends on the contract).
 *
 * Implements the same client shape as OmnivaClient, so the shipping routes,
 * fulfilment engine, and scheduler poll treat both carriers identically.
 */

export class DpdError extends OmnivaError {}

interface RawRecord {
  [k: string]: unknown;
}

class LiveDpdClient implements OmnivaClient {
  constructor(
    private readonly apiUrl: string,
    private readonly apiToken: string,
    private readonly serviceAlias: string,
    private readonly sender: ApiConfig["shipSender"],
  ) {}

  private async call(path: string, init: RequestInit & { rawBody?: boolean } = {}): Promise<unknown> {
    const res = await fetch(`${this.apiUrl}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${this.apiToken}`,
        "content-type": "application/json",
        accept: "application/json",
        ...init.headers,
      },
    });
    if (res.status === 404) return null;
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new DpdError(`DPD ${path} failed: ${res.status} ${text.slice(0, 300)}`, res.status);
    }
    return res.json();
  }

  async registerShipment(input: OmnivaShipmentInput): Promise<OmnivaShipment> {
    const body = [
      {
        senderAddress: {
          name: input.sender.name,
          phone: input.sender.phone,
          email: input.sender.email,
          street: input.sender.street,
          city: input.sender.city,
          postalCode: input.sender.postcode,
          country: input.sender.country,
        },
        receiverAddress: {
          name: input.receiver.name,
          phone: input.receiver.phone,
          email: input.receiver.email,
          country: input.receiver.country,
          // Locker delivery: the destination is the PUDO id, not a street.
          pudoId: input.receiver.machineId,
        },
        service: { serviceAlias: this.serviceAlias },
        parcels: [{ weight: input.weightGrams ? Math.max(0.01, input.weightGrams / 1000) : 1 }],
        contentDescription: input.comment.slice(0, 128),
        reference: input.reference,
      },
    ];
    const json = (await this.call("/shipments", { method: "POST", body: JSON.stringify(body) })) as RawRecord | RawRecord[] | null;
    if (!json) throw new DpdError("DPD /shipments returned no response");
    // The saved-shipment envelope varies slightly between environments —
    // hunt for the first parcel number / uuid, keep the full raw response.
    const first = (Array.isArray(json) ? json[0] : ((json.shipments as RawRecord[] | undefined)?.[0] ?? json)) as RawRecord;
    const parcels = (first?.parcels as Array<RawRecord> | undefined) ?? [];
    const barcode = String(
      parcels[0]?.parcelNumber ?? first?.parcelNumber ?? (Array.isArray(first?.parcelNumbers) ? (first.parcelNumbers as string[])[0] : "") ?? "",
    );
    const uuid = typeof first?.uuid === "string" ? first.uuid : typeof first?.id === "string" ? first.id : null;
    if (!barcode && !uuid) throw new DpdError("DPD returned neither a parcel number nor a shipment uuid");
    return { barcode: barcode || uuid!, raw: { response: json, shipmentUuid: uuid } as Record<string, unknown> };
  }

  async getLabel(barcode: string): Promise<string> {
    const res = await fetch(`${this.apiUrl}/shipments/labels`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.apiToken}`,
        "content-type": "application/json",
        accept: "application/pdf, application/json",
      },
      body: JSON.stringify({
        parcelNumbers: [barcode],
        labelFormat: "application/pdf",
        paperSize: "A6",
        downloadLabel: true,
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new DpdError(`DPD /shipments/labels failed: ${res.status} ${text.slice(0, 300)}`, res.status);
    }
    const contentType = res.headers.get("content-type") ?? "";
    if (contentType.includes("pdf")) {
      // Binary PDF straight back — normalize to base64 like Omniva.
      return Buffer.from(await res.arrayBuffer()).toString("base64");
    }
    const json = (await res.json()) as RawRecord;
    const base64 =
      (typeof json.label === "string" && json.label) ||
      (typeof json.fileData === "string" && json.fileData) ||
      (typeof json.pdf === "string" && json.pdf);
    if (!base64) throw new DpdError("DPD returned no label data");
    return base64;
  }

  async getEvents(barcode: string): Promise<OmnivaEvents | null> {
    const json = (await this.call(`/status/tracking?parcelNumbers=${encodeURIComponent(barcode)}`)) as RawRecord | null;
    if (!json) return null;
    const list =
      (json.parcels as RawRecord[] | undefined)?.[0] ??
      (Array.isArray(json) ? (json as RawRecord[])[0] : json);
    const rawEvents = ((list?.events ?? list?.statuses ?? json.events) as RawRecord[] | undefined) ?? [];
    const events = rawEvents
      .map((e) => ({
        code: String(e.status ?? e.statusCode ?? e.code ?? ""),
        at: String(e.date ?? e.eventDate ?? e.at ?? ""),
        description: typeof e.description === "string" ? e.description : typeof e.statusText === "string" ? e.statusText : undefined,
        location: typeof e.depot === "string" ? e.depot : typeof e.location === "string" ? e.location : undefined,
      }))
      .filter((e) => e.code)
      .reverse();
    return { events, raw: json as Record<string, unknown> };
  }

  async listLocations(country: string): Promise<OmnivaLocation[]> {
    const json = (await this.call(`/lockers?countryCode=${encodeURIComponent(country.toUpperCase())}`)) as
      | RawRecord[]
      | RawRecord
      | null;
    if (!json) return [];
    const list = (Array.isArray(json) ? json : ((json.lockers ?? json.items) as RawRecord[] | undefined)) ?? [];
    return list.map((l) => ({
      id: String(l.pudoId ?? l.id ?? l.lockerId ?? ""),
      name: String(l.name ?? ""),
      zip: String(l.postalCode ?? l.zip ?? ""),
      country: country.toUpperCase(),
      county: String(l.county ?? l.region ?? ""),
      city: String(l.city ?? ""),
      address: [l.street, l.streetNo].filter(Boolean).join(" ") || String(l.address ?? ""),
    })).filter((l) => l.id);
  }
}

/** In-memory driver for the test suite — mirrors SimulatedOmnivaClient. */
export class SimulatedDpdClient implements OmnivaClient {
  private shipments = new Map<string, { input: OmnivaShipmentInput; events: OmnivaEvents["events"] }>();
  private seq = 0;

  static readonly LOCKERS: OmnivaLocation[] = [
    { id: "LV90005", name: "DPD skapis Sky Mežciems", zip: "1063", country: "LV", county: "Rīga", city: "Rīga", address: "Sergeja Eizenšteina 79" },
    { id: "LV90012", name: "DPD skapis Valmieras Maxima", zip: "4201", country: "LV", county: "Valmiera", city: "Valmiera", address: "Rīgas iela 4" },
  ];

  async registerShipment(input: OmnivaShipmentInput): Promise<OmnivaShipment> {
    const barcode = `0580802280${String(++this.seq).padStart(4, "0")}`;
    this.shipments.set(barcode, {
      input,
      events: [{ code: "PICKUP_ORDERED", at: new Date(0).toISOString(), description: "Shipment data received" }],
    });
    return { barcode, raw: { shipments: [{ uuid: `dpd-${this.seq}`, parcels: [{ parcelNumber: barcode }] }] } };
  }

  async getLabel(barcode: string): Promise<string> {
    if (!this.shipments.has(barcode)) throw new DpdError(`no simulated shipment ${barcode}`, 404);
    const pdf = `%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\ntrailer<</Size 4/Root 1 0 R>>\n%%EOF\nDPDLABEL:${barcode}`;
    return Buffer.from(pdf).toString("base64");
  }

  async getEvents(barcode: string): Promise<OmnivaEvents | null> {
    const s = this.shipments.get(barcode);
    if (!s) return null;
    return { events: [...s.events].reverse(), raw: { barcode, events: s.events } };
  }

  async listLocations(country: string): Promise<OmnivaLocation[]> {
    return SimulatedDpdClient.LOCKERS.filter((l) => l.country === country.toUpperCase());
  }

  addEvent(barcode: string, code: string, description?: string): void {
    const s = this.shipments.get(barcode);
    if (!s) throw new Error(`no simulated dpd shipment ${barcode}`);
    s.events.push({ code, at: new Date(s.events.length * 1000).toISOString(), description });
  }

  inspect(barcode: string) {
    return this.shipments.get(barcode) ?? null;
  }
}

export function createDpdClient(config: ApiConfig): OmnivaClient | null {
  if (config.dpdMode === "off" || !config.dpd) return null;
  if (config.dpdMode === "simulate") return new SimulatedDpdClient();
  return new LiveDpdClient(config.dpd.apiUrl, config.dpd.apiToken, config.dpd.serviceAlias, config.shipSender);
}

/** DPD delivery-to-client event codes (per the Baltic tracking web service). */
export function dpdStatusFromEvents(events: OmnivaEvents["events"]): "registered" | "in_transit" | "delivered" {
  for (const e of events) {
    const c = e.code.toUpperCase();
    if (c.includes("DELIVERED") || c === "DEL") return "delivered";
  }
  const moving = events.some((e) => !["PICKUP_ORDERED", "REGISTERED", "DATA_RECEIVED"].includes(e.code.toUpperCase()));
  return moving ? "in_transit" : "registered";
}
