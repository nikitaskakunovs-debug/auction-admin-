"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { publicApi } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { track } from "@/lib/track";
import { AuthCard } from "@/components/authUi";
import { SocialAuth } from "@/components/SocialAuth";
import Link from "next/link";

export default function LoginPage() {
  const { t } = useT();
  const router = useRouter();
  const next = useSearchParams().get("next") ?? "/";
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await publicApi.login(email.trim().toLowerCase(), password);
      track("login", { method: "email" });
      router.push(next);
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
        {t("auth.noAccount")} <Link href="/register">{t("nav.register")}</Link>
        {" · "}
        <Link href="/forgot-password">{t("auth.forgot")}</Link>
      </p>
    </AuthCard>
  );
}
