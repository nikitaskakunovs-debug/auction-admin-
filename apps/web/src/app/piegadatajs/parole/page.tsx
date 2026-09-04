"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AuthCard } from "@/components/authUi";
import { supplierApi } from "@/lib/supplierApi";
import { supT, SUP_LANGS, type SupLang } from "@/lib/supplierStrings";

/** Установка пароля по ссылке из письма-приглашения (S1) или из «забыли пароль». */
function SetPassword() {
  const router = useRouter();
  const token = useSearchParams().get("token") ?? "";
  const [lang, setLang] = useState<SupLang>("lv");
  const [company, setCompany] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const t = supT(lang);

  // Проверяем ссылку до показа формы: истёкшее приглашение честнее
  // показать сразу, чем после ввода пароля.
  useEffect(() => {
    if (!token) {
      setInvalid(true);
      return;
    }
    supplierApi
      .get<{ supplierName: string }>(`/api/piegadatajs/invite/${encodeURIComponent(token)}`)
      .then((r) => setCompany(r.supplierName))
      .catch(() => setInvalid(true));
  }, [token]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password.length < 8) return;
    setBusy(true);
    try {
      const res = await supplierApi.post<{ accessToken: string }>(`/api/piegadatajs/invite/${encodeURIComponent(token)}`, { password });
      supplierApi.setToken(res.accessToken);
      router.replace("/piegadatajs/kabinets");
    } catch {
      setMsg(t("p.inviteInvalid"));
    } finally {
      setBusy(false);
    }
  };

  if (invalid) {
    return (
      <AuthCard title={t("p.title")}>
        <p className="note">{t("p.inviteInvalid")}</p>
      </AuthCard>
    );
  }

  return (
    <AuthCard title={t("p.setPassword")} sub={company ?? t("p.setPasswordSub")}>
      <div style={{ display: "flex", gap: 6, marginBottom: 14 }}>
        {SUP_LANGS.map((l) => (
          <button key={l} type="button" className={l === lang ? "btn" : "btn btn-ghost"} style={{ padding: "4px 10px" }} onClick={() => setLang(l)}>
            {l.toUpperCase()}
          </button>
        ))}
      </div>
      <form onSubmit={submit} className="fields">
        <label>
          {t("p.newPassword")}
          <input
            type="password"
            autoComplete="new-password"
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </label>
        <p className="note">{t("p.setPasswordSub")}</p>
        {msg ? <p className="note">{msg}</p> : null}
        <button className="btn" type="submit" disabled={busy}>{t("p.setPassword")}</button>
      </form>
    </AuthCard>
  );
}

export default function SupplierPasswordPage() {
  return (
    <Suspense fallback={null}>
      <SetPassword />
    </Suspense>
  );
}
