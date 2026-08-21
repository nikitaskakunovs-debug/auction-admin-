"use client";

import { publicApi } from "./api";

/** Атрибуция первого касания: с чем человек впервые пришёл на сайт.
 *
 *  На первом заходе запоминаем utm-метки и внешний реферер в localStorage;
 *  когда появляется аккаунт (регистрация или соцвход) — один раз отдаём в
 *  движок. Панель по этим меткам считает регистрации, заказы и выручку на
 *  кампанию. Ничего личного здесь нет: только метки ссылок.
 */
const KEY = "izsoli_attr_v1";
const SENT = "izsoli_attr_sent_v1";

export function captureAttribution(): void {
  try {
    if (localStorage.getItem(KEY)) return; // первое касание уже записано
    const p = new URLSearchParams(window.location.search);
    const external = document.referrer && !document.referrer.startsWith(window.location.origin)
      ? document.referrer : "";
    const a = {
      ...(p.get("utm_source") ? { source: p.get("utm_source")!.slice(0, 120) } : {}),
      ...(p.get("utm_medium") ? { medium: p.get("utm_medium")!.slice(0, 120) } : {}),
      ...(p.get("utm_campaign") ? { campaign: p.get("utm_campaign")!.slice(0, 120) } : {}),
      ...(p.get("utm_content") ? { content: p.get("utm_content")!.slice(0, 120) } : {}),
      ...(p.get("utm_term") ? { term: p.get("utm_term")!.slice(0, 120) } : {}),
      ...(external ? { referrer: external.slice(0, 400) } : {}),
      landing: (window.location.pathname + window.location.search).slice(0, 400),
    };
    // Прямой заход без меток и реферера ничего не говорит — не пишем.
    if (!("source" in a) && !("referrer" in a)) return;
    localStorage.setItem(KEY, JSON.stringify(a));
  } catch { /* приватный режим */ }
}

export function submitAttribution(): void {
  try {
    if (localStorage.getItem(SENT) || !publicApi.hasSession) return;
    const raw = localStorage.getItem(KEY);
    if (!raw) return;
    void publicApi
      .post("/api/public/me/attribution", JSON.parse(raw) as Record<string, string>)
      .then(() => localStorage.setItem(SENT, "1"))
      .catch(() => undefined);
  } catch { /* не мешаем работе */ }
}
