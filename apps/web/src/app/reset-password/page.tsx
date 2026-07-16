"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { publicApi } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { AuthCard, authInput, authButton } from "@/components/authUi";

function ResetForm() {
  const { t } = useT();
  const token = useSearchParams().get("token") ?? "";
  const [password, setPassword] = useState("");
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await publicApi.resetPassword(token, password);
      setDone(true);
    } catch {
      setError(t("auth.resetInvalid"));
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <AuthCard title={t("auth.resetTitle")}>
        <p style={{ fontSize: 14, color: "#3B3B38", margin: 0 }}>{t("auth.resetDone")}</p>
        <a href="/login" style={{ color: "#2D4BFF", fontWeight: 700, fontSize: 13 }}>{t("auth.signin")}</a>
      </AuthCard>
    );
  }

  return (
    <AuthCard title={t("auth.resetTitle")}>
      <form onSubmit={submit} style={{ display: "grid", gap: 12 }}>
        <input
          style={authInput}
          type="password"
          placeholder={t("auth.newPassword")}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoFocus
        />
        {error && <div style={{ color: "#B0282C", fontSize: 12.5, fontWeight: 600 }}>{error}</div>}
        <button style={authButton} type="submit" disabled={busy || password.length < 8 || !token}>
          {t("auth.resetSave")}
        </button>
      </form>
    </AuthCard>
  );
}

export default function ResetPasswordPage() {
  // useSearchParams requires a Suspense boundary in the App Router.
  return (
    <Suspense fallback={null}>
      <ResetForm />
    </Suspense>
  );
}
