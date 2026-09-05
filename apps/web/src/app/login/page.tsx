"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { publicApi } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { safeNext } from "@/lib/nav";
import { track } from "@/lib/track";
import { AuthCard } from "@/components/authUi";
import { SocialAuth } from "@/components/SocialAuth";
import Link from "next/link";

export default function LoginPage() {
  const { t } = useT();
  const router = useRouter();
  // Только внутренний адрес: next из строки запроса пишет кто угодно.
  const next = safeNext(useSearchParams().get("next"));
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Уже вошедшему форма входа не нужна: его молча возвращают туда, куда он
  // шёл, а пришедшего на /login напрямую — в кабинет.
  useEffect(() => {
    if (publicApi.hasSession) router.replace(next === "/" ? "/account" : next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const bidder = await publicApi.login(email.trim().toLowerCase(), password);
      // Переход — только после того, как теги Meta отработали: иначе запрос
      // пикселя обрывается вместе со страницей, и до Meta доезжает лишь
      // серверная копия. Задержка ограничена — заблокированный GTM не должен
      // держать человека на форме входа.
      track("login", { method: "email", user_id: bidder.id }, { onDone: () => router.push(next) });
    } catch {
      setError(t("auth.failed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthCard title={t("auth.signin")}>
      <form onSubmit={submit} className="fields">
        <input type="email" placeholder={t("auth.email")} value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
        <input type="password" placeholder={t("auth.password")} value={password} onChange={(e) => setPassword(e.target.value)} />
        {error && <div className="auth-err">{error}</div>}
        <button className="btn btn-primary btn-lg btn-block" type="submit" disabled={busy || !email || !password}>{t("auth.signin")}</button>
      </form>
      <SocialAuth next={next} />
      <p className="auth-alt">
        {t("auth.noAccount")} <Link href={`/register?next=${encodeURIComponent(next)}`}>{t("nav.register")}</Link>
        {" · "}
        <Link href="/forgot-password">{t("auth.forgot")}</Link>
      </p>
    </AuthCard>
  );
}
