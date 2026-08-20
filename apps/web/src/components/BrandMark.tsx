/** Официальный знак партнёра: банк, перевозчик, способ оплаты, карты.
 *
 *  Файлы живут в public/brands/<name>.svg и кладутся туда как есть из
 *  брендбука — правила в public/brands/README.md: не перекрашивать, не
 *  растягивать, не обводить; DPD минимум 60 px по ширине.
 *
 *  Пока официального файла нет, показываем нейтральный текстовый чип с
 *  названием — это честнее, чем перерисованный от руки чужой логотип,
 *  которого брендбук не разрешает. Как только SVG появится в папке,
 *  знак включится сам, без правок кода.
 */
const KNOWN: Record<string, { label: string; hasFile?: boolean }> = {
  swedbank: { label: "Swedbank" },
  seb: { label: "SEB" },
  citadele: { label: "Citadele" },
  luminor: { label: "Luminor" },
  revolut: { label: "Revolut" },
  klix: { label: "Klix" },
  inbank: { label: "Inbank" },
  applepay: { label: "Apple Pay" },
  googlepay: { label: "Google Pay" },
  visa: { label: "Visa" },
  mastercard: { label: "Mastercard" },
  omniva: { label: "Omniva" },
  dpd: { label: "DPD" },
  googlemaps: { label: "Google Maps" },
  applemaps: { label: "Apple Maps" },
  waze: { label: "Waze" },
  telegram: { label: "Telegram" },
  google: { label: "Google" },
  facebook: { label: "Facebook" },
};

/** Какие SVG реально лежат в public/brands. Список обновляется руками при
 *  добавлении файла — на сервере проверить файловую систему из компонента
 *  нельзя, а 404-картинка с пустой рамкой хуже текстового чипа. */
const FILES = new Set<string>([]);

export function BrandMark({ name, h = 20 }: { name: string; h?: number }) {
  const brand = KNOWN[name];
  if (!brand) return null;
  if (FILES.has(name)) {
    // eslint-disable-next-line @next/next/no-img-element
    return (
      <img
        src={`/brands/${name}.svg`}
        alt={brand.label}
        style={{ height: h, width: "auto", display: "inline-block", verticalAlign: "middle" }}
      />
    );
  }
  return <span className="brand-chip" style={{ height: h }}>{brand.label}</span>;
}
