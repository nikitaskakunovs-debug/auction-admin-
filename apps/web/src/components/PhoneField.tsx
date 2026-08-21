"use client";

/** Телефон с выбором страны и маской — макет № 50 и шаг получателя в оплате.
 *
 *  Никаких примеров вида «8 cipari» на экране: подсказку даёт сама маска.
 *  Наружу отдаём номер в E.164 (+37120123456) — так его принимают и
 *  перевозчики, и SMS-шлюз. Внутри держим только цифры без кода страны.
 */

import { useMemo, useState } from "react";

interface Country {
  /** ISO-код: он же ключ списка и значение <select>. */
  iso: string;
  dial: string;
  /** Группы цифр национального номера — по ним строится маска. */
  groups: number[];
}

/** Страны, откуда к нам реально приходят покупатели, плюс остальная Европа.
 *  Порядок: Балтия и соседи сверху, дальше по алфавиту названия. */
export const PHONE_COUNTRIES: Country[] = [
  { iso: "LV", dial: "+371", groups: [2, 3, 3] },
  { iso: "LT", dial: "+370", groups: [3, 2, 3] },
  { iso: "EE", dial: "+372", groups: [4, 4] },
  { iso: "FI", dial: "+358", groups: [2, 3, 4] },
  { iso: "SE", dial: "+46", groups: [2, 3, 2, 2] },
  { iso: "NO", dial: "+47", groups: [3, 2, 3] },
  { iso: "DK", dial: "+45", groups: [2, 2, 2, 2] },
  { iso: "PL", dial: "+48", groups: [3, 3, 3] },
  { iso: "DE", dial: "+49", groups: [3, 4, 4] },
  { iso: "AT", dial: "+43", groups: [3, 3, 4] },
  { iso: "BE", dial: "+32", groups: [3, 2, 2, 2] },
  { iso: "BG", dial: "+359", groups: [2, 3, 4] },
  { iso: "CH", dial: "+41", groups: [2, 3, 2, 2] },
  { iso: "CY", dial: "+357", groups: [2, 6] },
  { iso: "CZ", dial: "+420", groups: [3, 3, 3] },
  { iso: "ES", dial: "+34", groups: [3, 3, 3] },
  { iso: "FR", dial: "+33", groups: [1, 2, 2, 2, 2] },
  { iso: "GB", dial: "+44", groups: [4, 6] },
  { iso: "GR", dial: "+30", groups: [3, 3, 4] },
  { iso: "HR", dial: "+385", groups: [2, 3, 4] },
  { iso: "HU", dial: "+36", groups: [2, 3, 4] },
  { iso: "IE", dial: "+353", groups: [2, 3, 4] },
  { iso: "IS", dial: "+354", groups: [3, 4] },
  { iso: "IT", dial: "+39", groups: [3, 3, 4] },
  { iso: "LU", dial: "+352", groups: [3, 3, 3] },
  { iso: "MT", dial: "+356", groups: [4, 4] },
  { iso: "NL", dial: "+31", groups: [1, 4, 4] },
  { iso: "PT", dial: "+351", groups: [3, 3, 3] },
  { iso: "RO", dial: "+40", groups: [3, 3, 3] },
  { iso: "SI", dial: "+386", groups: [2, 3, 3] },
  { iso: "SK", dial: "+421", groups: [3, 3, 3] },
  { iso: "UA", dial: "+380", groups: [2, 3, 4] },
  { iso: "US", dial: "+1", groups: [3, 3, 4] },
];

const BY_ISO = new Map(PHONE_COUNTRIES.map((c) => [c.iso, c]));

/** Название страны на языке интерфейса — берём у самого браузера, чтобы не
 *  держать в репозитории тридцать три перевода на пять языков. */
function countryName(iso: string, lang: string): string {
  try {
    return new Intl.DisplayNames([lang], { type: "region" }).of(iso) ?? iso;
  } catch {
    return iso;
  }
}

/** Расставляет пробелы по группам страны: 20 123 456. */
export function maskPhone(digits: string, iso: string): string {
  const c = BY_ISO.get(iso);
  const max = c ? c.groups.reduce((a, b) => a + b, 0) : 15;
  const d = digits.replace(/\D/g, "").slice(0, max);
  if (!c) return d;
  const out: string[] = [];
  let i = 0;
  for (const g of c.groups) {
    if (i >= d.length) break;
    out.push(d.slice(i, i + g));
    i += g;
  }
  return out.join(" ");
}

/** E.164 из выбранной страны и введённых цифр. Пустая строка, если пусто. */
export function toE164(digits: string, iso: string): string {
  const d = digits.replace(/\D/g, "");
  if (!d) return "";
  return `${BY_ISO.get(iso)?.dial ?? "+371"}${d}`;
}

/** Разбирает E.164 обратно: подбирает самый длинный подходящий код. */
export function fromE164(value: string): { iso: string; digits: string } {
  const v = value.replace(/[^\d+]/g, "");
  if (v.startsWith("+")) {
    const hit = [...PHONE_COUNTRIES]
      .sort((a, b) => b.dial.length - a.dial.length)
      .find((c) => v.startsWith(c.dial));
    if (hit) return { iso: hit.iso, digits: v.slice(hit.dial.length) };
  }
  return { iso: "LV", digits: v.replace(/\D/g, "") };
}

/** Номер набран полностью, если цифр столько, сколько просит маска страны. */
export function phoneComplete(digits: string, iso: string): boolean {
  const c = BY_ISO.get(iso);
  if (!c) return digits.replace(/\D/g, "").length >= 7;
  return digits.replace(/\D/g, "").length === c.groups.reduce((a, b) => a + b, 0);
}

export function PhoneField({
  value,
  onChange,
  label,
  lang = "lv",
  required,
  id = "phone",
  invalid,
}: {
  /** Значение в E.164 либо пустая строка. */
  value: string;
  onChange: (e164: string) => void;
  label: string;
  lang?: string;
  required?: boolean;
  id?: string;
  invalid?: boolean;
}) {
  const parsed = useMemo(() => fromE164(value), [value]);
  const [iso, setIso] = useState(parsed.iso);
  const digits = parsed.digits;

  /* Балтия закреплена сверху, остальное — по названию на языке интерфейса. */
  const options = useMemo(() => {
    const named = PHONE_COUNTRIES.map((c) => ({ ...c, name: countryName(c.iso, lang) }));
    const pinned = named.slice(0, 3);
    const rest = named.slice(3).sort((a, b) => a.name.localeCompare(b.name, lang));
    return [...pinned, ...rest];
  }, [lang]);

  return (
    <label className="fld phone-fld" htmlFor={id}>
      <span>{label}</span>
      <div className={`phone-row${invalid ? " is-bad" : ""}`}>
        <select
          className="phone-cc"
          aria-label={label}
          value={iso}
          onChange={(e) => {
            setIso(e.target.value);
            onChange(toE164(digits, e.target.value));
          }}
        >
          {options.map((c) => (
            <option key={c.iso} value={c.iso}>
              {c.name} {c.dial}
            </option>
          ))}
        </select>
        <input
          id={id}
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          required={required}
          aria-invalid={invalid || undefined}
          value={maskPhone(digits, iso)}
          onChange={(e) => onChange(toE164(e.target.value, iso))}
        />
      </div>
    </label>
  );
}
