"use client";

import { useState } from "react";
import { publicApi, PublicApiError } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { track } from "@/lib/track";
import { AuthCard } from "@/components/authUi";
import { SocialAuth } from "@/components/SocialAuth";
import { VerifyNotice } from "@/components/VerifyNotice";
import Link from "next/link";

export default function RegisterPage() {
  const { t } = useT();
  const [email, setEmail] = useState("");
  const [alias, setAlias] = useState("");
  const [password, setPassword] = useState("");
  const [country, setCountry] = useState("LV");
  const [marketing, setMarketing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  // Живой намёк по сегвардсу: браузеры любят автозаполнять сюда e-mail, и
  // человек получал отказ по-английски без объяснения, какое поле виновато.
  const aliasTrim = alias.trim();
  const aliasOk = /^[a-zA-Z0-9_.-]{3,24}$/.test(aliasTrim);
  const aliasHint = aliasTrim.length === 0
    ? null
    : aliasTrim.includes("@") ? t("auth.aliasNotEmail")
    : !aliasOk ? t("auth.aliasRules")
    : null;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const bidder = await publicApi.register({ email: email.trim().toLowerCase(), alias: aliasTrim, password, country, marketingOptIn: marketing });
      track("sign_up", { method: "email", user_id: bidder.id });
      setDone(true);
    } catch (err) {
      if (err instanceof PublicApiError && err.body.error === "email_exists") setError(t("auth.errEmailExists"));
      else if (err instanceof PublicApiError && err.body.error === "alias_exists") setError(t("auth.errAliasExists"));
      else setError(t("auth.errGeneric"));
    } finally {
      setBusy(false);
    }
  };

  if (done) return <VerifyNotice email={email.trim().toLowerCase()} />;

  return (
    <AuthCard title={t("auth.register")}>
      <form onSubmit={submit} className="fields">
        <input type="email" placeholder={t("auth.email")} value={email} autoComplete="email"
               onChange={(e) => setEmail(e.target.value)} autoFocus />
        {/* autoComplete="nickname": иначе браузер вписывает сюда почту. */}
        <input placeholder={t("auth.alias")} value={alias} autoComplete="nickname" maxLength={24}
               aria-invalid={aliasHint !== null} onChange={(e) => setAlias(e.target.value)} />
        {aliasHint && <p className="note" style={{ color: "var(--live)" }}>{aliasHint}</p>}
        <input type="password" placeholder={t("auth.password")} value={password} autoComplete="new-password"
               onChange={(e) => setPassword(e.target.value)} aria-describedby="pw-hint" minLength={8} />
        {/* Кнопка неактивна, пока пароль короткий, — требование должно быть
            видно сразу, иначе кнопка выглядит сломанной. */}
        <p className="note" id="pw-hint">
          {password.length > 0 && password.length < 8
            ? t("auth.pwLeft", { n: 8 - password.length })
            : t("auth.pwHint")}
        </p>
        <select value={country} onChange={(e) => setCountry(e.target.value)}>
          <option value="LV">{t("reg.countryLV")}</option>
          <option value="EE">{t("reg.countryEE")}</option>
          <option value="LT">{t("reg.countryLT")}</option>
        </select>
        {/* Согласие на рассылку — отдельной галочкой и по умолчанию снятой.
            Из факта регистрации согласие на рекламу не следует. */}
        <label className="maxrow" style={{ marginTop: 4 }}>
          <input type="checkbox" checked={marketing} onChange={(e) => setMarketing(e.target.checked)} />
          <span>{t("reg.marketing")}</span>
        </label>
        {error && <div className="auth-err">{error}</div>}
        <button className="btn btn-primary btn-lg btn-block" type="submit"
                disabled={busy || !email || !aliasOk || password.length < 8}>{t("auth.register")}</button>
      </form>
      <SocialAuth />
      <p className="auth-alt">
        {t("auth.haveAccount")} <Link href="/login">{t("auth.signin")}</Link>
      </p>
    </AuthCard>
  );
}
