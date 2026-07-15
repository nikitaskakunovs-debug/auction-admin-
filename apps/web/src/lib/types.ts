/** Public API shapes. All money is integer euro cents. */

export interface PublicAuction {
  id: string;
  title: string;
  description: string;
  sku: string;
  condition: string;
  conditionNotes: string;
  category: string;
  photos: string[];
  marketCode: string;
  status: string;
  startsAt: string;
  endsAt: string;
  startPriceCents: number | null;
  currentPriceCents: number | null;
  bidCount: number;
  leaderAlias: string | null;
  hasReserve: boolean;
  reserveMet: boolean;
}

export interface PublicBid {
  alias: string;
  amountCents: number;
  auto: boolean;
  outbid: boolean;
  seq: number;
  createdAt: string;
  isYou: boolean;
}

export interface AuctionDetail {
  auction: PublicAuction;
  minNextBidCents: number;
  /** Current price + buyer premium + VAT — what winning right now costs. */
  estimatedTotalCents: number;
  bids: PublicBid[];
}

export interface Bidder {
  id: string;
  email: string;
  alias: string;
}

export interface FixedListing {
  id: string;
  title: string;
  description: string;
  sku: string;
  condition: string;
  conditionNotes: string;
  category: string;
  photos: string[];
  marketCode: string;
  priceCents: number;
  quantity: number;
  soldOut?: boolean;
  /** Price + VAT — the checkout total (fixed-price buys carry no premium). */
  estimatedTotalCents?: number;
}

export interface MyOrder {
  ref: string;
  itemTitle: string;
  itemSku: string;
  hammerCents: number;
  premiumCents: number;
  vatCents: number;
  shippingCents: number;
  totalCents: number;
  status: string;
  paymentDeadlineAt: string | null;
  createdAt: string;
  /** pickup | omniva_pm */
  fulfilment: string;
  shippingTo: { provider: string; machineId: string; name: string; zip: string; country: string; address?: string } | null;
  shipment: { barcode: string; status: string } | null;
}

export interface ShippingOption {
  method: string;
  priceCents: number;
}

export interface ParcelLocation {
  id: string;
  name: string;
  zip: string;
  country: string;
  county: string;
  city: string;
  address: string;
}

export function formatEur(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}€${Math.floor(abs / 100).toLocaleString("en-US")}.${(abs % 100).toString().padStart(2, "0")}`;
}
