"use client";

import { useState } from "react";
import { publicApi } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { AuthCard } from "@/components/authUi";
import Link from "next/link";

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
        <p className="note" style={{ fontSize: 15 }}>{t("auth.resetSent")}</p>
        <Link className="btn btn-outline btn-block" href="/login">{t("auth.signin")}</Link>
      </AuthCard>
    );
  }

  return (
    <AuthCard title={t("auth.resetTitle")}>
      <p className="note" style={{ fontSize: 15 }}>{t("auth.resetIntro")}</p>
      <form onSubmit={submit} className="fields">
        <input type="email" placeholder={t("auth.email")} value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
        <button className="btn btn-primary btn-lg btn-block" type="submit" disabled={busy || !email}>{t("auth.resetSend")}</button>
      </form>
      <Link className="btn btn-outline btn-block" href="/login">{t("auth.signin")}</Link>
    </AuthCard>
  );
}
