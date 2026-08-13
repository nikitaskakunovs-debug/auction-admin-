"use client";


import Link from "next/link";
import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { publicApi, PublicApiError } from "@/lib/api";
import { Icon } from "@/components/Icon";
import { VerifyNotice } from "@/components/VerifyNotice";

type State = "checking" | "ok" | "expired" | "invalid" | "nothing";

/** Страница, на которую ведёт ссылка из письма.
 *  Без токена показывает «проверь почту», с токеном — результат проверки. */
export default function VerifyEmailPage() {
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
            <h1>Pārbaudām saiti…</h1>
            <p className="note" style={{ fontSize: 15 }}>Tas aizņem pāris sekundes.</p>
          </>
        )}

        {state === "ok" && (
          <>
            <span className="ic-round ok" aria-hidden="true"><Icon name="check" /></span>
            <h1>E-pasts apstiprināts</h1>
            <p className="note" style={{ fontSize: 15 }}>
              Konts ir gatavs: vari solīt, sekot lotiem un saņemt brīdinājumus par pārsolīšanu.
            </p>
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
              <Link className="btn btn-primary" href="/katalogs">Atrast pirmo lotu</Link>
              <Link className="btn btn-outline" href="/account">Mans konts</Link>
            </div>
          </>
        )}

        {state === "expired" && (
          <>
            <span className="ic-round warn" aria-hidden="true"><Icon name="timer" /></span>
            <h1>Saitei beidzies termiņš</h1>
            <p className="note" style={{ fontSize: 15 }}>
              Apstiprinājuma saite derīga 24 stundas. Nosūtīsim jaunu — tā aizņem mirkli.
            </p>
            <VerifyNotice email={email} compact />
          </>
        )}

        {state === "invalid" && (
          <>
            <span className="ic-round warn" aria-hidden="true"><Icon name="x" /></span>
            <h1>Saite nav derīga</h1>
            <p className="note" style={{ fontSize: 15 }}>
              Iespējams, e-pasts jau ir apstiprināts vai saite tika nokopēta nepilnīgi.
              Pamēģini ieiet — ja neizdodas, nosūtīsim jaunu vēstuli.
            </p>
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
              <Link className="btn btn-primary" href="/login">Ieiet</Link>
              <Link className="btn btn-outline" href="/kontakti">Sazināties</Link>
            </div>
          </>
        )}
      </div>
    </section>
  );
}
