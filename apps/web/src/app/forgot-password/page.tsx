"use client";

import { useState } from "react";
import { publicApi } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { AuthCard, authInput, authButton } from "@/components/authUi";

export default function ForgotPasswordPage() {
  const { t } = useT();
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await publicApi.forgotPassword(email.trim().toLowerCase());
    } finally {
      // Always show the same confirmation — never reveal whether the account exists.
      setSent(true);
      setBusy(false);
    }
  };

  if (sent) {
    return (
      <AuthCard title={t("auth.resetTitle")}>
        <p style={{ fontSize: 14, color: "#3B3B38", margin: 0 }}>{t("auth.resetSent")}</p>
        <a href="/login" style={{ color: "#2D4BFF", fontWeight: 700, fontSize: 13 }}>{t("auth.signin")}</a>
      </AuthCard>
    );
  }

  return (
    <AuthCard title={t("auth.resetTitle")}>
      <p style={{ fontSize: 13.5, color: "#6B6B68", margin: 0 }}>{t("auth.resetIntro")}</p>
      <form onSubmit={submit} style={{ display: "grid", gap: 12 }}>
        <input style={authInput} type="email" placeholder={t("auth.email")} value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
        <button style={authButton} type="submit" disabled={busy || !email}>{t("auth.resetSend")}</button>
      </form>
      <a href="/login" style={{ color: "#2D4BFF", fontWeight: 700, fontSize: 13 }}>{t("auth.signin")}</a>
    </AuthCard>
  );
}
