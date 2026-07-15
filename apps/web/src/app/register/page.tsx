"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { publicApi, PublicApiError } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { AuthCard, authInput, authButton } from "@/components/authUi";

export default function RegisterPage() {
  const { t } = useT();
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [alias, setAlias] = useState("");
  const [password, setPassword] = useState("");
  const [country, setCountry] = useState("LV");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await publicApi.register({ email: email.trim().toLowerCase(), alias: alias.trim(), password, country });
      router.push("/");
    } catch (err) {
      if (err instanceof PublicApiError && err.body.error === "email_exists") setError("Email already registered.");
      else setError("Registration failed — alias 3-24 chars (letters/digits/_.-), password min 8.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthCard title={t("auth.register")}>
      <form onSubmit={submit} style={{ display: "grid", gap: 12 }}>
        <input style={authInput} type="email" placeholder={t("auth.email")} value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
        <input style={authInput} placeholder={t("auth.alias")} value={alias} onChange={(e) => setAlias(e.target.value)} />
        <input style={authInput} type="password" placeholder={t("auth.password")} value={password} onChange={(e) => setPassword(e.target.value)} />
        <select style={{ ...authInput, appearance: "auto" }} value={country} onChange={(e) => setCountry(e.target.value)}>
          <option value="LV">Latvija</option>
          <option value="EE">Eesti</option>
          <option value="LT">Lietuva</option>
        </select>
        {error && <div style={{ color: "#B0282C", fontSize: 12.5, fontWeight: 600 }}>{error}</div>}
        <button style={authButton} type="submit" disabled={busy || !email || !alias || password.length < 8}>{t("auth.register")}</button>
      </form>
      <p style={{ fontSize: 12.5, color: "#6B6B68", marginBottom: 0 }}>
        {t("auth.haveAccount")} <a href="/login" style={{ color: "#2D4BFF", fontWeight: 700 }}>{t("auth.signin")}</a>
      </p>
    </AuthCard>
  );
}
