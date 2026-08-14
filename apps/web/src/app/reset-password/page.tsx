"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { publicApi } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { AuthCard } from "@/components/authUi";
import Link from "next/link";

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
        <p className="note" style={{ fontSize: 15 }}>{t("auth.resetDone")}</p>
        <Link className="btn btn-outline btn-block" href="/login">{t("auth.signin")}</Link>
      </AuthCard>
    );
  }

  return (
    <AuthCard title={t("auth.resetTitle")}>
      <form onSubmit={submit} className="fields">
        <input
          
          type="password"
          placeholder={t("auth.newPassword")}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoFocus
        />
        {error && <div className="auth-err">{error}</div>}
        <button className="btn btn-primary btn-lg btn-block" type="submit" disabled={busy || password.length < 8 || !token}>
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
