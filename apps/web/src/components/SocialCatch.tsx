"use client";

import { useEffect } from "react";
import { publicApi } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { say } from "./Toast";

/** Приём токенов после соцвхода (макеты № 50, 52).
 *
 *  Сервер после колбэка провайдера возвращает человека на витрину с
 *  фрагментом `#a=<access>&r=<refresh>` (или `#social-error=1`, если у
 *  провайдера не вышло). Фрагмент не уходит на сервер и не попадает в логи;
 *  здесь мы его разбираем, кладём токены в клиент и сразу стираем из адресной
 *  строки, чтобы они не остались в истории браузера. */
export function SocialCatch() {
  const { t } = useT();
  useEffect(() => {
    const raw = window.location.hash.replace(/^#/, "");
    if (!raw) return;
    const params = new URLSearchParams(raw);
    const a = params.get("a");
    const r = params.get("r");
    if (a && r) {
      publicApi.adoptTokens(a, r);
      history.replaceState(null, "", window.location.pathname + window.location.search);
      return;
    }
    if (params.get("social-error")) {
      say(t("sa.error"));
      history.replaceState(null, "", window.location.pathname + window.location.search);
    }
  }, [t]);
  return null;
}
