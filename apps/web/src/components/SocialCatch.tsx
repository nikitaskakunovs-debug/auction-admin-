"use client";

import { useEffect } from "react";
import { publicApi } from "@/lib/api";
import { PUBLIC_API_URL } from "@/lib/config";
import { useT } from "@/lib/i18n";
import { track } from "@/lib/track";
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

    // Мобильный Telegram после подтверждения в приложении возвращает не на
    // страницу с виджетом, а на корень домена с #tgAuthResult=<base64 json>.
    // API-домен переадресует на витрину, фрагмент выживает — доводим вход:
    // отправляем подписанные поля на проверку, дальше обычный путь #a=&r=.
    const tg = params.get("tgAuthResult");
    if (tg) {
      try {
        const fields = JSON.parse(atob(tg.replace(/-/g, "+").replace(/_/g, "/"))) as Record<string, string | number>;
        const q = new URLSearchParams();
        for (const [k, v] of Object.entries(fields)) q.set(k, String(v));
        q.set("redirect", `${window.location.origin}/account`);
        window.location.replace(`${PUBLIC_API_URL}/api/public/auth/oauth/telegram/callback?${q.toString()}`);
      } catch {
        say(t("sa.error"));
        history.replaceState(null, "", window.location.pathname + window.location.search);
      }
      return;
    }
    const a = params.get("a");
    const r = params.get("r");
    if (a && r) {
      publicApi.adoptTokens(a, r);
      // Аналитика: p — способ входа (google/facebook/telegram), n=1 — первая
      // регистрация. Фрагмент стирается сразу, поэтому sign_up не повторится
      // при обновлении страницы. Никаких персональных данных.
      const method = params.get("p");
      if (method) track(params.get("n") === "1" ? "sign_up" : "login", { method });
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
