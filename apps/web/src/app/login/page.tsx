"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { publicApi } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { AuthCard, authInput, authButton } from "@/components/authUi";

export default function LoginPage() {
  const { t } = useT();
  const router = useRouter();
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
      router.push("/");
    } catch {
      setError(t("auth.failed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthCard title={t("auth.signin")}>
      <form onSubmit={submit} style={{ display: "grid", gap: 12 }}>
        <input style={authInput} type="email" placeholder={t("auth.email")} value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
        <input style={authInput} type="password" placeholder={t("auth.password")} value={password} onChange={(e) => setPassword(e.target.value)} />
        {error && <div style={{ color: "#B0282C", fontSize: 12.5, fontWeight: 600 }}>{error}</div>}
        <button style={authButton} type="submit" disabled={busy || !email || !password}>{t("auth.signin")}</button>
      </form>
      <p style={{ fontSize: 12.5, color: "#6B6B68", marginBottom: 0 }}>
        {t("auth.noAccount")} <a href="/register" style={{ color: "#2D4BFF", fontWeight: 700 }}>{t("nav.register")}</a>
      </p>
    </AuthCard>
  );
}
