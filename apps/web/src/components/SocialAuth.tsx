"use client";

import { useState, type ReactElement } from "react";
import { PUBLIC_API_URL } from "@/lib/config";
import { say } from "./Toast";
import { useT } from "@/lib/i18n";

/** Вход через Google, Facebook и Telegram.
 *
 *  Каждая кнопка уводит на серверный старт OAuth:
 *  GET {API}/api/public/auth/oauth/{provider}/start?redirect={куда вернуть}
 *  Сервер сам делает редирект к провайдеру и после возврата кладёт токены.
 *  Пока эндпоинт не поднят, он отвечает 404 — тогда показываем понятный
 *  тост вместо белого экрана. */
const PROVIDERS: Array<{ id: string; label: string; brand: string; icon: ReactElement }> = [
  {
    id: "google", label: "Google", brand: "g",
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path fill="#4285F4" d="M21.6 12.23c0-.7-.06-1.38-.18-2.03H12v3.84h5.38a4.6 4.6 0 0 1-2 3.02v2.5h3.24c1.9-1.74 2.98-4.3 2.98-7.33z" />
        <path fill="#34A853" d="M12 22c2.7 0 4.96-.9 6.62-2.44l-3.24-2.5c-.9.6-2.05.96-3.38.96-2.6 0-4.8-1.76-5.6-4.12H3.06v2.58A10 10 0 0 0 12 22z" />
        <path fill="#FBBC05" d="M6.4 13.9a6 6 0 0 1 0-3.8V7.52H3.06a10 10 0 0 0 0 8.96l3.34-2.58z" />
        <path fill="#EA4335" d="M12 5.98c1.47 0 2.79.5 3.83 1.5l2.87-2.87C16.95 2.99 14.7 2 12 2A10 10 0 0 0 3.06 7.52L6.4 10.1c.8-2.36 3-4.12 5.6-4.12z" />
      </svg>
    ),
  },
  {
    id: "facebook", label: "Facebook", brand: "f",
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path fill="#1877F2" d="M22 12a10 10 0 1 0-11.56 9.88v-6.99H7.9V12h2.54V9.8c0-2.5 1.49-3.89 3.77-3.89 1.09 0 2.24.2 2.24.2v2.46h-1.26c-1.24 0-1.63.77-1.63 1.56V12h2.78l-.44 2.89h-2.34v6.99A10 10 0 0 0 22 12z" />
      </svg>
    ),
  },
  {
    id: "telegram", label: "Telegram", brand: "t",
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="10" fill="#2AABEE" />
        <path fill="#fff" d="M17.5 7.6l-1.9 9c-.14.64-.52.8-1.05.5l-2.9-2.14-1.4 1.35c-.16.15-.29.28-.58.28l.2-2.96 5.4-4.88c.24-.2-.05-.32-.36-.11l-6.68 4.2-2.88-.9c-.62-.2-.64-.63.13-.93l11.26-4.34c.52-.19.98.12.76 1.03z" />
      </svg>
    ),
  },
];

export function SocialAuth({ next = "/" }: { next?: string }) {
  const { t } = useT();
  const [busy, setBusy] = useState<string | null>(null);

  const start = async (id: string, label: string) => {
    setBusy(id);
    const url = `${PUBLIC_API_URL}/api/public/auth/oauth/${id}/start`
      + `?redirect=${encodeURIComponent(`${location.origin}${next}`)}`;
    try {
      // Включён ли провайдер, спрашиваем у /oauth/config: это обычный JSON.
      // Пробный запрос к самому /start нельзя — при включённом провайдере он
      // отвечает переадресацией на чужой домен, и браузер режет её по CORS,
      // из-за чего настроенная кнопка выглядела «не подключённой».
      const res = await fetch(`${PUBLIC_API_URL}/api/public/auth/oauth/config`);
      if (!res.ok) throw new Error(String(res.status));
      const cfg = (await res.json()) as { google?: boolean; facebook?: boolean; telegram?: string | null };
      const on = id === "telegram" ? Boolean(cfg.telegram) : cfg[id as "google" | "facebook"] === true;
      if (!on) {
        say(t("sa.soon", { provider: label }));
        setBusy(null);
        return;
      }
      // Полноценный переход (не fetch) — тут CORS уже ни при чём.
      location.assign(url);
    } catch {
      say(t("sa.soon", { provider: label }));
      setBusy(null);
    }
  };

  return (
    <div className="social">
      <p className="or"><span>{t("sa.orContinue")}</span></p>
      <div className="social-grid">
        {PROVIDERS.map((p) => (
          <button key={p.id} className={`social-btn s-${p.brand}`} type="button"
                  disabled={busy !== null}
                  onClick={() => void start(p.id, p.label)}>
            {p.icon}{p.label}
          </button>
        ))}
      </div>
      <p className="note" style={{ textAlign: "center", marginTop: 10 }}>
        {t("sa.agreePre")} <a href="/lietosanas-noteikumi">{t("sa.terms")}</a>.
      </p>
    </div>
  );
}
