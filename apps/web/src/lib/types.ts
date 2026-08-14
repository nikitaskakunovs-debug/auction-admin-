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
  /** Подтверждён ли адрес. Пока движок поля не отдаёт, считаем неподтверждённым
   *  только при явном false — иначе баннер висел бы у всех. */
  emailVerified?: boolean;
  /** Согласие на рассылку. Кабинет показывает состояние и даёт отозвать. */
  marketingOptIn?: boolean;
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
  handlingCents: number;
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
  /** Packing/handling fee that rides along with carrier delivery. */
  handlingCents: number;
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

/** Латвийский формат: 1 234,56 € — узкий неразрывный пробел между тысячами
 *  и обычный неразрывный перед знаком валюты, чтобы «€» не отрывался. */
export function formatEur(cents: number): string {
  const sign = cents < 0 ? "\u2212" : "";
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100).toLocaleString("lv-LV").replace(/\s/g, "\u202f");
  return `${sign}${whole},${(abs % 100).toString().padStart(2, "0")}\u00a0€`;
}

/** Рекламная карточка в ленте лотов. Место продаётся рекламодателю. */
export interface AdCard {
  id: string;
  title: string;
  body: string;
  ctaLabel: string;
  /** С «/» — раздел нашего сайта, с «https://» — сайт рекламодателя. */
  href: string;
  /** banner — картинка или цвет; carousel — несколько кадров; video — ролик. */
  kind: "banner" | "carousel" | "video";
  imageUrl: string | null;
  /** Кадры карусели; у видео первый кадр — постер. */
  images: string[];
  videoUrl: string | null;
  /** Пометка «Реклама». Для чужой оплаченной — всегда включена. */
  showLabel: boolean;
  theme: string;
  categoryCode: string | null;
  /** Через сколько карточек лотов вставлять эту. */
  everyN: number;
}
