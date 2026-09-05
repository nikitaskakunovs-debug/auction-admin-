import type { Attribution } from "./api.js";
import { AT } from "./theme.js";
import { ABadge } from "./ui.js";
import { useT } from "./i18n.js";

/**
 * «Откуда пришёл» — один блок для карточки клиента и карточки заказа.
 *
 * Раньше метки лежали в базе, но не показывались нигде: отчёт говорил
 * «google · vasara_lv → 2 заказа», а какие это заказы и что за люди — узнать
 * было негде. Здесь они на виду в обеих карточках, одинаково выглядят и
 * одинаково читаются.
 *
 * Касаний два, и подписаны они прямо: первое — кто привёл, последнее — что
 * вернуло. Когда они совпадают, второй блок не рисуем: повторять одно и то же
 * значит заставлять читателя сравнивать строки взглядом.
 */

/** Человеческое имя канала: «google · cpc» вместо пустоты у прямого захода. */
export function channelLabel(a: Attribution | null | undefined, directLabel: string): string {
  if (!a) return directLabel;
  const parts = [a.source, a.medium].filter(Boolean);
  if (parts.length === 0) return a.referrer ? hostOf(a.referrer) : directLabel;
  return parts.join(" · ");
}

function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url.slice(0, 60);
  }
}

const same = (a: Attribution | null | undefined, b: Attribution | null | undefined): boolean =>
  (a?.source ?? "") === (b?.source ?? "") &&
  (a?.medium ?? "") === (b?.medium ?? "") &&
  (a?.campaign ?? "") === (b?.campaign ?? "");

function Line({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
      <span style={{ fontFamily: AT.body, fontSize: 11.5, color: AT.inkSoft, minWidth: 92 }}>{label}</span>
      <span style={{
        fontFamily: mono ? AT.mono : AT.body, fontSize: mono ? 11 : 12.5, color: AT.ink,
        wordBreak: "break-all",
      }}>
        {value}
      </span>
    </div>
  );
}

function Touch({ a, title, tone }: { a: Attribution; title: string; tone: "accent" | "neutral" }) {
  const { t } = useT();
  return (
    <div style={{ display: "grid", gap: 4 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <ABadge tone={tone}>{title}</ABadge>
        <span style={{ fontFamily: AT.body, fontSize: 12.5, fontWeight: 700 }}>
          {channelLabel(a, t("attr.direct"))}
        </span>
        {a.campaign && <span style={{ fontFamily: AT.body, fontSize: 12.5, color: AT.inkSoft }}>· {a.campaign}</span>}
      </div>
      {a.content && <Line label={t("attr.content")} value={a.content} />}
      {a.term && <Line label={t("attr.term")} value={a.term} />}
      {a.landing && <Line label={t("attr.landing")} value={a.landing} mono />}
      {a.referrer && <Line label={t("attr.referrer")} value={a.referrer} mono />}
      {a.at && <Line label={t("attr.when")} value={new Date(a.at).toLocaleString()} />}
    </div>
  );
}

export function AttributionCard({
  first,
  last,
  touches,
  note,
}: {
  first?: Attribution | null;
  last?: Attribution | null;
  /** Сколько раз приходил по метке — показываем только когда их правда много. */
  touches?: number;
  note?: string;
}) {
  const { t } = useT();
  const nothing = !first && !last;
  return (
    <div style={{ background: AT.surfaceAlt, borderRadius: AT.radiusSm, padding: "10px 12px", display: "grid", gap: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontFamily: AT.body, fontSize: 12, fontWeight: 700, flex: 1 }}>{t("attr.title")}</span>
        {touches !== undefined && touches > 1 && (
          <span style={{ fontFamily: AT.body, fontSize: 11.5, color: AT.inkSoft }}>
            {t("attr.touches")}: {touches}
          </span>
        )}
      </div>

      {nothing ? (
        <div style={{ fontFamily: AT.body, fontSize: 12.5, color: AT.inkSoft }}>{t("attr.none")}</div>
      ) : (
        <>
          {first && <Touch a={first} title={t("attr.first")} tone="accent" />}
          {last && !same(first, last) && <Touch a={last} title={t("attr.last")} tone="neutral" />}
        </>
      )}

      {note && <div style={{ fontFamily: AT.body, fontSize: 11.5, color: AT.inkSoft }}>{note}</div>}
    </div>
  );
}
