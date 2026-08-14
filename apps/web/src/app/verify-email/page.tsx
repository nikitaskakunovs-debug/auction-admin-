"use client";


import Link from "next/link";
import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { publicApi, PublicApiError } from "@/lib/api";
import { Icon } from "@/components/Icon";
import { VerifyNotice } from "@/components/VerifyNotice";
import { useT } from "@/lib/i18n";

type State = "checking" | "ok" | "expired" | "invalid" | "nothing";

/** Страница, на которую ведёт ссылка из письма.
 *  Без токена показывает «проверь почту», с токеном — результат проверки. */
export default function VerifyEmailPage() {
  const { t } = useT();
  const qs = useSearchParams();
  const token = qs.get("token") ?? "";
  const email = qs.get("email") ?? "";
  const [state, setState] = useState<State>(token ? "checking" : "nothing");

  useEffect(() => {
    if (!token) return;
    let alive = true;
    void publicApi.verifyEmail(token)
      .then(() => { if (alive) setState("ok"); })
      .catch((err) => {
        if (!alive) return;
        const code = err instanceof PublicApiError ? String(err.body.code ?? "") : "";
        setState(code === "TOKEN_EXPIRED" ? "expired" : "invalid");
      });
    return () => { alive = false; };
  }, [token]);

  if (state === "nothing") return <VerifyNotice email={email} />;

  return (
    <section className="wrap" style={{ paddingTop: 40, paddingBottom: 80 }}>
      <div className="card-b auth-card">
        {state === "checking" && (
          <>
            <span className="spin" aria-hidden="true" />
            <h1>{t("ve.checking")}</h1>
            <p className="note" style={{ fontSize: 15 }}>{t("ve.checkingD")}</p>
          </>
        )}

        {state === "ok" && (
          <>
            <span className="ic-round ok" aria-hidden="true"><Icon name="check" /></span>
            <h1>{t("ve.confirmed")}</h1>
            <p className="note" style={{ fontSize: 15 }}>
              {t("ve.okD")}
            </p>
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
              <Link className="btn btn-primary" href="/katalogs">{t("sec.findFirst")}</Link>
              <Link className="btn btn-outline" href="/account">{t("nav.account")}</Link>
            </div>
          </>
        )}

        {state === "expired" && (
          <>
            <span className="ic-round warn" aria-hidden="true"><Icon name="timer" /></span>
            <h1>{t("ve.expired")}</h1>
            <p className="note" style={{ fontSize: 15 }}>
              {t("ve.expiredD")}
            </p>
            <VerifyNotice email={email} compact />
          </>
        )}

        {state === "invalid" && (
          <>
            <span className="ic-round warn" aria-hidden="true"><Icon name="x" /></span>
            <h1>{t("ve.invalid")}</h1>
            <p className="note" style={{ fontSize: 15 }}>
              {t("ve.invalidD")}
            </p>
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
              <Link className="btn btn-primary" href="/login">{t("ve.signin")}</Link>
              <Link className="btn btn-outline" href="/kontakti">{t("misc.contactUs")}</Link>
            </div>
          </>
        )}
      </div>
    </section>
  );
}
