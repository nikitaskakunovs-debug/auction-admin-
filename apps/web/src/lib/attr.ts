"use client";

import { publicApi } from "./api";

/** Атрибуция: с чем человек пришёл на сайт.
 *
 *  Касаний два, и они отвечают на разные вопросы.
 *
 *  ПЕРВОЕ — кто его вообще привёл. Пишется один раз и больше не меняется:
 *  по нему считается цена привлечения покупателя.
 *
 *  ПОСЛЕДНЕЕ — что привело его к этой покупке. Обновляется на каждом визите
 *  с меткой. Без него письмо и ретаргетинг невидимы: человек однажды пришёл
 *  из поиска, а купил через месяц по рассылке — и вся заслуга рассылки в
 *  модели первого касания достаётся поиску.
 *
 *  Личного здесь нет: метки ссылок, адрес входа и случайный id браузера.
 */
const FIRST = "izsoli_attr_v1";
const LAST = "izsoli_attr_last_v1";
const SENT_FIRST = "izsoli_attr_sent_v1";
/** Отпечаток последнего отправленного касания — не шлём одно и то же дважды. */
const SENT_LAST = "izsoli_attr_last_sent_v1";
/** Тот же ключ, что у плашки cookie: сшивает согласие гостя с аккаунтом. */
const VISITOR = "izsoli_visitor_v1";

interface Touch {
  source?: string;
  medium?: string;
  campaign?: string;
  content?: string;
  term?: string;
  referrer?: string;
  landing?: string;
}

/** Метки текущего захода. Пусто, если заход ничем не помечен. */
function readTouch(): Touch | null {
  const p = new URLSearchParams(window.location.search);
  const external =
    document.referrer && !document.referrer.startsWith(window.location.origin) ? document.referrer : "";
  const cut = (v: string | null, n = 120) => (v ? v.slice(0, n) : undefined);
  const touch: Touch = {
    ...(cut(p.get("utm_source")) ? { source: cut(p.get("utm_source"))! } : {}),
    ...(cut(p.get("utm_medium")) ? { medium: cut(p.get("utm_medium"))! } : {}),
    ...(cut(p.get("utm_campaign")) ? { campaign: cut(p.get("utm_campaign"))! } : {}),
    ...(cut(p.get("utm_content")) ? { content: cut(p.get("utm_content"))! } : {}),
    ...(cut(p.get("utm_term")) ? { term: cut(p.get("utm_term"))! } : {}),
    // Клик из рекламы Google/Meta несёт свой идентификатор даже без utm —
    // без него платный переход выглядел бы прямым заходом.
    ...(!p.get("utm_source") && p.get("gclid") ? { source: "google", medium: "cpc" } : {}),
    ...(!p.get("utm_source") && p.get("fbclid") ? { source: "facebook", medium: "paid_social" } : {}),
    ...(!p.get("utm_source") && p.get("ttclid") ? { source: "tiktok", medium: "paid_social" } : {}),
    ...(external ? { referrer: external.slice(0, 400) } : {}),
    landing: (window.location.pathname + window.location.search).slice(0, 400),
  };
  // Прямой заход без меток и без внешнего реферера ничего не сообщает:
  // записать его — значит затереть настоящий источник пустотой.
  if (!touch.source && !touch.referrer) return null;
  return touch;
}

export function captureAttribution(): void {
  try {
    const touch = readTouch();
    if (!touch) return;
    if (!localStorage.getItem(FIRST)) localStorage.setItem(FIRST, JSON.stringify(touch));
    localStorage.setItem(LAST, JSON.stringify(touch));
  } catch {
    /* приватный режим */
  }
}

export function submitAttribution(): void {
  try {
    if (!publicApi.hasSession) return;
    const first = localStorage.getItem(FIRST);
    const last = localStorage.getItem(LAST);
    const visitorId = localStorage.getItem(VISITOR);
    const sendFirst = first && !localStorage.getItem(SENT_FIRST);
    // Последнее касание отправляем, когда оно изменилось: повторные визиты
    // по той же ссылке не должны каждый раз дёргать движок.
    const sendLast = last && localStorage.getItem(SENT_LAST) !== last;
    if (!sendFirst && !sendLast && !visitorId) return;

    const payload: Record<string, unknown> = {};
    if (sendFirst) payload.first = JSON.parse(first) as Touch;
    if (sendLast) payload.last = JSON.parse(last!) as Touch;
    if (visitorId) payload.visitorId = visitorId;

    void publicApi
      .post("/api/public/me/attribution", payload)
      .then(() => {
        if (sendFirst) localStorage.setItem(SENT_FIRST, "1");
        if (sendLast) localStorage.setItem(SENT_LAST, last!);
      })
      .catch(() => undefined);
  } catch {
    /* не мешаем работе */
  }
}
