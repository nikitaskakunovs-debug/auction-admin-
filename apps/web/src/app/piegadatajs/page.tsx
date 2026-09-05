"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { AuthCard } from "@/components/authUi";
import { supplierApi } from "@/lib/supplierApi";
import { supT, SUP_LANGS, type SupLang } from "@/lib/supplierStrings";

/**
 * Вход в кабинет поставщика. Самостоятельной регистрации здесь нет вовсе:
 * аккаунт заводит менеджер, ссылку человек получает письмом.
 */
export default function SupplierLoginPage() {
  const router = useRouter();
  const [lang, setLang] = useState<SupLang>("lv");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const t = supT(lang);

  useEffect(() => {
    if (supplierApi.hasSession) router.replace("/piegadatajs/kabinets");
  }, [router]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      const res = await supplierApi.post<{ accessToken: string }>("/api/piegadatajs/login", { email, password });
      supplierApi.setToken(res.accessToken);
      router.replace("/piegadatajs/kabinets");
    } catch {
      setMsg(t("p.badLogin"));
    } finally {
      setBusy(false);
    }
  };

  const forgot = async () => {
    if (!email) return;
    await supplierApi.post("/api/piegadatajs/forgot", { email }).catch(() => undefined);
    setMsg(t("p.forgotSent"));
  };

  return (
    <AuthCard title={t("p.title")} sub={t("p.loginSub")}>
      <div style={{ display: "flex", gap: 6, marginBottom: 14 }}>
        {SUP_LANGS.map((l) => (
          <button key={l} type="button" className={l === lang ? "btn" : "btn btn-ghost"} style={{ padding: "4px 10px" }} onClick={() => setLang(l)}>
            {l.toUpperCase()}
          </button>
        ))}
      </div>
      <form onSubmit={submit} className="fields">
        <label>
          {t("p.email")}
          <input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </label>
        <label>
          {t("p.password")}
          <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </label>
        {msg ? <p className="note">{msg}</p> : null}
        <button className="btn" type="submit" disabled={busy}>{t("p.login")}</button>
      </form>
      <button className="btn btn-ghost" style={{ marginTop: 10 }} onClick={() => void forgot()}>{t("p.forgot")}</button>
    </AuthCard>
  );
}
