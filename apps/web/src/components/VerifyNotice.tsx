"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { publicApi, PublicApiError } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { Icon } from "./Icon";
import { say } from "./Toast";

/**
 * Почтовые службы, популярные у наших покупателей: кнопка «Atvērt Gmail»
 * ведёт прямо в ящик, чтобы подтверждение не терялось на полпути между
 * нашей вкладкой и вкладкой почты. По домену адреса угадываем нужную;
 * если не угадали — показываем три самые распространённые в Латвии.
 */
const MAIL_PROVIDERS: Array<{ test: RegExp; name: string; url: string }> = [
  { test: /@(gmail|googlemail)\./i, name: "Gmail", url: "https://mail.google.com/" },
  { test: /@inbox\.(lv|lt|eu)$/i, name: "Inbox.lv", url: "https://mail.inbox.lv/" },
  { test: /@(outlook|hotmail|live|msn)\./i, name: "Outlook", url: "https://outlook.live.com/mail/" },
  { test: /@apollo\.lv$/i, name: "Apollo", url: "https://mail.apollo.lv/" },
  { test: /@(mail\.ru|bk\.ru|list\.ru|inbox\.ru)$/i, name: "Mail.ru", url: "https://e.mail.ru/inbox/" },
  { test: /@(yahoo|ymail)\./i, name: "Yahoo", url: "https://mail.yahoo.com/" },
  { test: /@(icloud|me|mac)\.com$/i, name: "iCloud", url: "https://www.icloud.com/mail/" },
];
const DEFAULT_PROVIDERS = MAIL_PROVIDERS.slice(0, 3);

export function mailProvidersFor(email: string): Array<{ name: string; url: string }> {
  const hit = MAIL_PROVIDERS.find((p) => p.test.test(email));
  return hit ? [hit] : DEFAULT_PROVIDERS;
}

/** Экран «проверь почту» после регистрации.
 *
 *  Контракт с движком:
 *    POST /api/public/auth/verify-email/resend { email? }  — выслать письмо
 *    POST /api/public/auth/verify-email        { token }   — подтвердить
 *  Пока эндпоинтов нет, кнопка честно говорит, что письмо не ушло. */
export function VerifyNotice({ email, compact }: { email: string; compact?: boolean }) {
  const { t } = useT();
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
      say(t("vn.resent"));
      setLeft(60);
    } catch (err) {
      say(err instanceof PublicApiError && (err.status === 404 || err.status === 501)
        ? t("vn.notReady")
        : t("vn.sendFailed"));
    } finally { setBusy(false); }
  };

  const body = (
    <>
      <p className="note" style={{ fontSize: 15 }}>
        {t("vn.intro")} <b>{email || t("vn.yourEmail")}</b>. {t("vn.introTail")}
      </p>
      {/* Главное действие — открыть ящик, а не «выслать ещё раз»: письмо в
          девяти случаях из десяти уже там. */}
      <div className="mail-cta">
        {mailProvidersFor(email).map((p) => (
          <a key={p.name} className="btn btn-primary" href={p.url} target="_blank" rel="noopener noreferrer">
            <Icon name="mail" size={16} /> {t("vn.openMail", { p: p.name })}
          </a>
        ))}
      </div>
      <p className="note" style={{ marginTop: 8 }}>{t("vn.openMailHint")}</p>
      <ul className="rep-list" style={{ marginTop: 12 }}>
        <li className="in"><Icon name="check" size={16} />{t("vn.checkSpam")}</li>
        <li className="in"><Icon name="check" size={16} />{t("vn.fromAddress")}</li>
      </ul>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 16 }}>
        <button className="btn btn-outline" type="button" disabled={busy || left > 0}
                onClick={() => void resend()}>
          {left > 0 ? t("vn.resendIn", { n: left }) : t("vn.resend")}
        </button>
        <Link className="btn btn-outline" href="/kontakti">{t("vn.notReceived")}</Link>
      </div>
    </>
  );

  if (compact) return <div className="verify-box">{body}</div>;

  return (
    <section className="wrap" style={{ paddingTop: 40, paddingBottom: 80 }}>
      <div className="card-b auth-card">
        <span className="ic-round" aria-hidden="true"><Icon name="mail" /></span>
        <h1>{t("vn.title")}</h1>
        {body}
        <p className="auth-alt">
          {t("vn.wrongAddress")} <Link href="/register">{t("vn.registerAgain")}</Link>
          {" · "}
          <Link href="/login">{t("nav.signin")}</Link>
        </p>
      </div>
    </section>
  );
}
