"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { PUBLIC_API_URL } from "@/lib/config";
import { useT } from "@/lib/i18n";
import { AuthCard } from "@/components/authUi";

/** Ienākšana ar Telegram (макет № 52).
 *
 *  Виджет Telegram живёт здесь, на витрине, а не на api-поддомене: тогда в
 *  окне Telegram написано «izsoli.lv», а после подтверждения в приложении
 *  человек возвращается на сайт, где возврат ловят и эта страница, и
 *  SocialCatch (мобильный Telegram возвращает на корень домена с
 *  #tgAuthResult=…). Подписанные поля виджета уходят на проверку в API,
 *  который отвечает токенами тем же фрагментом, что и остальные провайдеры.
 */
export default function TelegramLoginPage() {
  const { t } = useT();
  // undefined — ещё спрашиваем конфиг; null — провайдер не подключён.
  const [bot, setBot] = useState<string | null | undefined>(undefined);
  const slot = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void fetch(`${PUBLIC_API_URL}/api/public/auth/oauth/config`)
      .then((r) => r.json() as Promise<{ telegram?: string | null }>)
      .then((cfg) => setBot(cfg.telegram ?? null))
      .catch(() => setBot(null));
  }, []);

  useEffect(() => {
    if (!bot || !slot.current) return;
    const forward = (user: Record<string, string | number>) => {
      const p = new URLSearchParams();
      for (const [k, v] of Object.entries(user)) p.set(k, String(v));
      const raw = new URLSearchParams(window.location.search).get("next");
      // safeNext не пускает «//evil.lv» — startsWith("/") пропускал.
      const next = raw && /^\/(?!\/)/.test(raw) ? raw : "/account";
      p.set("redirect", `${window.location.origin}${next}`);
      window.location.assign(`${PUBLIC_API_URL}/api/public/auth/oauth/telegram/callback?${p.toString()}`);
    };
    (window as unknown as { onTelegramAuth: typeof forward }).onTelegramAuth = forward;

    const s = document.createElement("script");
    s.src = "https://telegram.org/js/telegram-widget.js?22";
    s.async = true;
    s.setAttribute("data-telegram-login", bot);
    s.setAttribute("data-size", "large");
    s.setAttribute("data-onauth", "onTelegramAuth(user)");
    s.setAttribute("data-request-access", "write");
    const host = slot.current;
    host.appendChild(s);
    return () => { host.replaceChildren(); };
  }, [bot]);

  return (
    <AuthCard title={t("sa.tgTitle")} sub={t("sa.tgSub")}>
      {bot === undefined && <p className="note" style={{ textAlign: "center" }}>{t("wl.loading")}</p>}
      {bot === null && <p className="auth-err">{t("sa.soon", { provider: "Telegram" })}</p>}
      {bot && (
        <>
          <div ref={slot} style={{ display: "grid", placeItems: "center", minHeight: 56, margin: "18px 0 6px" }} />
          <ol className="tg-steps">
            <li>{t("sa.tgStep1")}</li>
            <li>{t("sa.tgStep2")}</li>
            <li>{t("sa.tgStep3")}</li>
          </ol>
        </>
      )}
      <p className="auth-alt">
        <Link href="/login">{t("sa.tgBack")}</Link>
      </p>
    </AuthCard>
  );
}
