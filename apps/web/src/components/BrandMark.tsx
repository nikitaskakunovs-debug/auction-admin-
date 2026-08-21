/** Знак партнёра: банк, перевозчик, платёжный метод, соцсеть.
 *
 *  Логотипы приходят из брендбуков и по условиям использования не
 *  перекрашиваются и не искажаются — компонент задаёт только высоту и
 *  охранное поле. Файлы лежат в public/brands, правила — в public/brands/README.md.
 */

const MARKS: Record<string, { file: string; alt: string; minW?: number }> = {
  // Банклинк
  swedbank: { file: "swedbank.svg", alt: "Swedbank" },
  seb: { file: "seb.svg", alt: "SEB" },
  citadele: { file: "citadele.svg", alt: "Citadele" },
  luminor: { file: "luminor.svg", alt: "Luminor" },
  revolut: { file: "revolut.svg", alt: "Revolut" },

  // Оплата
  klix: { file: "klix.svg", alt: "Klix by Citadele" },
  inbank: { file: "inbank.svg", alt: "Inbank" },
  applepay: { file: "applepay.svg", alt: "Apple Pay" },
  googlepay: { file: "googlepay.svg", alt: "Google Pay" },
  visa: { file: "visa.svg", alt: "Visa" },
  mastercard: { file: "mastercard.svg", alt: "Mastercard" },

  // Доставка
  omniva: { file: "omniva.svg", alt: "Omniva" },
  "omniva-black": { file: "omniva-black.svg", alt: "Omniva" },
  "omniva-white": { file: "omniva-white.svg", alt: "Omniva" },
  dpd: { file: "dpd.png", alt: "DPD", minW: 60 },
  "dpd-black": { file: "dpd-black.png", alt: "DPD", minW: 60 },
  "dpd-white": { file: "dpd-white.png", alt: "DPD", minW: 60 },
  "dpd-on-red": { file: "dpd-on-red.png", alt: "DPD", minW: 60 },
  "dpd-pickup": { file: "dpd-pickup.png", alt: "DPD Pickup", minW: 60 },
  "dpd-pickup-sticker": { file: "dpd-pickup-sticker.png", alt: "DPD Pickup" },
  "dpd-automat": { file: "dpd-automat-sticker.png", alt: "DPD Automat" },

  // Навигация до склада
  googlemaps: { file: "googlemaps.png", alt: "Google Maps" },
  applemaps: { file: "applemaps.png", alt: "Apple Maps" },
  waze: { file: "waze.svg", alt: "Waze" },

  // Вход и подвал
  google: { file: "google.svg", alt: "Google" },
  facebook: { file: "facebook.svg", alt: "Facebook" },
  telegram: { file: "telegram.svg", alt: "Telegram" },
  instagram: { file: "instagram.svg", alt: "Instagram" },
  "x-twitter": { file: "x-twitter.svg", alt: "X" },
  tiktok: { file: "tiktok.svg", alt: "TikTok" },
  gmail: { file: "gmail.svg", alt: "Gmail" },
};

export function BrandMark({ name, h = 24, className }: { name: string; h?: number; className?: string }) {
  const m = MARKS[name];
  if (!m) return null;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      className={["brandmark", className].filter(Boolean).join(" ")}
      src={`/brands/${m.file}`}
      alt={m.alt}
      style={{ height: h, width: "auto" }}
      loading="lazy"
      decoding="async"
    />
  );
}

/** Есть ли официальный знак — чтобы на экране показать либо логотип, либо текст. */
export function hasBrandMark(name: string): boolean {
  return name in MARKS;
}
