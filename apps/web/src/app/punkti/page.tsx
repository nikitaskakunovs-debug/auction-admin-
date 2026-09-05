"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { publicApi } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { loginHref } from "@/lib/nav";
import { formatEur } from "@/lib/types";
import { say } from "@/components/Toast";

/**
 * «Kā darbojas punkti» (MD §5a.2) + «Uzaicini draugu» (MD §4).
 *
 * Простая страница-объяснение: 1 балл = 1 €, зарабатываются оплатой,
 * списываются в оплате. Вошедшему — живой баланс, журнал и личная
 * реферальная ссылка. Числа приходят из настроек сервера — не зашиты.
 */

interface Points {
  balanceCents: number;
  redeemMaxBp: number;
  earnPerEurCents: number;
  tier: "bronze" | "silver" | "gold";
  tierEarnBp: number;
  lifetimeEarnedCents: number;
  toNextTierCents: number | null;
  ledger: Array<{ reason: string; amountCents: number; orderRef: string | null; createdAt: string }>;
}
interface Referral {
  code: string;
  url: string;
  rewards: { signupCents: number; orderCents: number; friendPercent: number };
  stats: { invited: number; signupRewarded: number; orderRewarded: number; onHold: number };
}

export default function PointsPage() {
  const { t } = useT();
  const [signedIn, setSignedIn] = useState(false);
  const [points, setPoints] = useState<Points | null>(null);
  const [referral, setReferral] = useState<Referral | null>(null);

  useEffect(() => {
    setSignedIn(publicApi.hasSession);
    if (!publicApi.hasSession) return;
    void publicApi.get<Points>("/api/public/me/points").then(setPoints).catch(() => undefined);
    void publicApi.get<Referral>("/api/public/me/referral").then(setReferral).catch(() => undefined);
  }, []);

  const pct = points ? Math.round(points.redeemMaxBp / 100) : 50;

  // Подарочная карта: погашение зачисляет номинал в кредит счёта.
  const [gcCode, setGcCode] = useState("");
  const [gcBusy, setGcBusy] = useState(false);
  const [gcMsg, setGcMsg] = useState<string | null>(null);
  const redeemGc = async () => {
    if (gcCode.trim().length < 6) return;
    setGcBusy(true); setGcMsg(null);
    try {
      const r = await publicApi.post<{ ok: boolean; amountCents: number; creditBalanceCents: number }>(
        "/api/public/me/gift-card", { code: gcCode.trim() },
      );
      setGcMsg(t("gc.done", { sum: formatEur(r.amountCents) }));
      setGcCode("");
      say(t("gc.doneToast"));
    } catch (err) {
      const reason = (err as { body?: { reason?: string } }).body?.reason;
      setGcMsg(
        reason === "redeemed" ? t("gc.errRedeemed")
        : reason === "expired" ? t("gc.errExpired")
        : t("gc.errInvalid"));
    } finally { setGcBusy(false); }
  };

  const reasonLabel = (r: string) =>
    r === "purchase" ? t("pts.rPurchase")
    : r === "redemption" ? t("pts.rRedeem")
    : r === "referral_signup" || r === "referral_order" ? t("pts.rReferral")
    : t("pts.rManual");

  return (
    <section className="wrap" style={{ paddingTop: 24, maxWidth: 760 }}>
      <h1 data-hero>{t("pts.pageTitle")}</h1>

      {signedIn && points && (
        <div className="bidbox" style={{ margin: "16px 0" }}>
          <p className="price-lab">{t("pts.balance")}</p>
          <p className="big tnum">{formatEur(points.balanceCents)}</p>
          {/* §6.5: уровень и путь до следующего. Множитель — из настроек. */}
          <p className="note" style={{ marginTop: 6 }}>
            {t(`tier.${points.tier}`)}
            {points.tierEarnBp > 10_000 ? ` · ${t("tier.multiplier", { x: (points.tierEarnBp / 10_000).toFixed(2).replace(/0$/, "") })}` : ""}
          </p>
          {points.toNextTierCents !== null && (
            <p className="note">{t("tier.toNext", { sum: formatEur(points.toNextTierCents), next: t(points.tier === "bronze" ? "tier.silver" : "tier.gold") })}</p>
          )}
        </div>
      )}

      {signedIn && (
        <section className="report" style={{ marginTop: 16 }}>
          <h2>{t("gc.title")}</h2>
          <p className="note" style={{ fontSize: 15 }}>{t("gc.intro")}</p>
          <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
            <input value={gcCode} placeholder="DAVANA-XXXXXXXX" style={{ flex: 1, minWidth: 0 }}
                   onChange={(e) => setGcCode(e.target.value.toUpperCase())}
                   onKeyDown={(e) => { if (e.key === "Enter") void redeemGc(); }} />
            <button className="btn btn-primary btn-sm" type="button" disabled={gcBusy || gcCode.trim().length < 6}
                    onClick={() => void redeemGc()}>
              {t("gc.redeem")}
            </button>
          </div>
          {gcMsg && <p className="note" style={{ marginTop: 6 }}>{gcMsg}</p>}
        </section>
      )}

      <section className="report" style={{ marginTop: 16 }}>
        <h2>{t("pts.howTitle")}</h2>
        <p className="note" style={{ fontSize: 15 }}>{t("pts.how1")}</p>
        <p className="note" style={{ fontSize: 15 }}>{t("pts.how2", { pct })}</p>
        <p className="note" style={{ fontSize: 15 }}>{t("pts.how3")}</p>
      </section>

      {signedIn && referral && (
        <section className="report" style={{ marginTop: 16 }}>
          <h2>{t("ref.title")}</h2>
          <p className="note" style={{ fontSize: 15 }}>
            {t("ref.intro", {
              pct: referral.rewards.friendPercent,
              s: formatEur(referral.rewards.signupCents),
              o: formatEur(referral.rewards.orderCents),
            })}
          </p>
          <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
            <input readOnly value={referral.url} style={{ flex: 1, minWidth: 0 }} onFocus={(e) => e.currentTarget.select()} />
            <button className="btn btn-primary btn-sm" type="button"
                    onClick={() => { navigator.clipboard?.writeText(referral.url).catch(() => {}); say(t("card.copied")); }}>
              {t("share.copy")}
            </button>
          </div>
          <p className="note" style={{ marginTop: 8 }}>
            {t("ref.stats", { n: referral.stats.invited, ok: referral.stats.orderRewarded })}
            {referral.stats.onHold > 0 ? ` · ${t("ref.onHold", { n: referral.stats.onHold })}` : ""}
          </p>
        </section>
      )}

      {signedIn && points && points.ledger.length > 0 && (
        <section className="report" style={{ marginTop: 16 }}>
          <h2>{t("pts.ledger")}</h2>
          <table className="fees"><tbody>
            {points.ledger.map((l, i) => (
              <tr key={i}>
                <th scope="row">{reasonLabel(l.reason)}{l.orderRef ? ` · ${l.orderRef}` : ""}</th>
                <td className="tnum">{l.amountCents > 0 ? "+" : "−"}{formatEur(Math.abs(l.amountCents))}</td>
              </tr>
            ))}
          </tbody></table>
        </section>
      )}

      {!signedIn && (
        <p className="note" style={{ marginTop: 16 }}>
          <Link className="btn btn-primary" href={loginHref("/punkti")}>{t("a.signinToBid")}</Link>
        </p>
      )}
    </section>
  );
}
