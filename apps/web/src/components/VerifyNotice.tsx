"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { publicApi, PublicApiError } from "@/lib/api";
import { Icon } from "./Icon";
import { say } from "./Toast";

/** Экран «проверь почту» после регистрации.
 *
 *  Контракт с движком:
 *    POST /api/public/auth/verify-email/resend { email? }  — выслать письмо
 *    POST /api/public/auth/verify-email        { token }   — подтвердить
 *  Пока эндпоинтов нет, кнопка честно говорит, что письмо не ушло. */
export function VerifyNotice({ email, compact }: { email: string; compact?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [left, setLeft] = useState(0);

  useEffect(() => {
    if (left <= 0) return;
    const id = setTimeout(() => setLeft((v) => v - 1), 1000);
    return () => clearTimeout(id);
  }, [left]);

  const resend = async () => {
    setBusy(true);
    try {
      await publicApi.resendVerification(email || undefined);
      say("Vēstule nosūtīta vēlreiz");
      setLeft(60);
    } catch (err) {
      say(err instanceof PublicApiError && (err.status === 404 || err.status === 501)
        ? "Apstiprināšanas vēstules vēl tiek pieslēgtas"
        : "Neizdevās nosūtīt — mēģini vēlreiz");
    } finally { setBusy(false); }
  };

  const body = (
    <>
      <p className="note" style={{ fontSize: 15 }}>
        Nosūtījām apstiprinājuma saiti uz <b>{email || "tavu e-pastu"}</b>.
        Atver to, un konts būs gatavs solīšanai. Saite derīga 24 stundas.
      </p>
      <ul className="rep-list" style={{ marginTop: 12 }}>
        <li className="in"><Icon name="check" size={16} />Pārbaudi arī mēstuļu mapi</li>
        <li className="in"><Icon name="check" size={16} />Vēstule nāk no info@izsoli.lv</li>
      </ul>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 16 }}>
        <button className="btn btn-primary" type="button" disabled={busy || left > 0}
                onClick={() => void resend()}>
          {left > 0 ? `Nosūtīt vēlreiz pēc ${left} s` : "Nosūtīt vēstuli vēlreiz"}
        </button>
        <Link className="btn btn-outline" href="/kontakti">Nesaņēmu vēstuli</Link>
      </div>
    </>
  );

  if (compact) return <div className="verify-box">{body}</div>;

  return (
    <section className="wrap" style={{ paddingTop: 40, paddingBottom: 80 }}>
      <div className="card-b auth-card">
        <span className="ic-round" aria-hidden="true"><Icon name="mail" /></span>
        <h1>Apstiprini e-pastu</h1>
        {body}
        <p className="auth-alt">
          Nepareiza adrese? <Link href="/register">Reģistrējies vēlreiz</Link>
          {" · "}
          <Link href="/login">Ieiet</Link>
        </p>
      </div>
    </section>
  );
}
