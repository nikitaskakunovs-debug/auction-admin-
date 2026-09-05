"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { dateLocale, useT } from "@/lib/i18n";
import { copyText, daysLeft, shareLinks, usePerks } from "@/lib/perks";
import { formatEur } from "@/lib/types";
import { Ph } from "../Ph";
import { say } from "../Toast";

/**
 * Две привилегии кабинета, о которых человек иначе не узнал бы.
 *
 *  — Код за регистрацию жил только в письме о подтверждении почты. Письмо
 *    закрыто — код забыт, первая покупка отложена. Теперь он на виду в
 *    Pārskats со сроком и кнопкой «копировать», пока не использован.
 *  — «Пригласи друга» уходило рассылкой, а рассылку получают только давшие
 *    согласие. Остальные о программе не слышали вовсе. Показ внутри
 *    кабинета — не рассылка: согласия не требует, а видят все.
 */

/** Карточки для Pārskats: подарок и тизер приглашения. */
export function PerkCards({ goFriends }: { goFriends: () => void }) {
  const { t, lang } = useT();
  const { welcome, referral } = usePerks();
  if (!welcome && !referral) return null;

  const until = welcome?.validTo ? new Date(welcome.validTo).toLocaleDateString(dateLocale(lang)) : null;
  const left = welcome ? daysLeft(welcome.validTo) : null;
  const total = referral ? referral.rewards.signupCents + referral.rewards.orderCents : 0;

  return (
    <div className="perks">
      {welcome && (
        <div className="perk">
          <span className="ic" aria-hidden="true"><Ph name="gift" size={22} /></span>
          <span className="t">
            <b>{t("perk.codeTitle")} · {t("perk.codeSub", { n: welcome.value })}</b>
            <span className="code">{welcome.code}</span>
            <small>
              {until ? t("perk.validUntil", { d: until }) : ""}
              {left !== null ? ` · ${t("perk.daysLeft", { n: left })}` : ""}
              {" · "}{t("perk.howToUse")}
            </small>
          </span>
          <span className="act">
            <button className="btn btn-primary btn-sm" type="button"
                    onClick={() => { void copyText(welcome.code).then((ok) => say(ok ? t("perk.codeCopied") : welcome.code)); }}>
              <Ph name="copy-simple" size={14} /> {t("perk.copyCode")}
            </button>
            <Link className="btn btn-outline btn-sm" href="/katalogs?type=fixed">{t("kb.findLots")}</Link>
          </span>
        </div>
      )}
      {referral && (
        <button className="perk ref" type="button" onClick={goFriends}>
          <span className="ic" aria-hidden="true"><Ph name="users-three" size={22} /></span>
          <span className="t">
            <b>{t("ref.teaser", { total: formatEur(total) })}</b>
            <small>{t("ref.teaserSub", {
              pct: referral.rewards.friendPercent,
              s: formatEur(referral.rewards.signupCents),
              o: formatEur(referral.rewards.orderCents),
            })}</small>
          </span>
          <Ph name="caret-right" size={14} className="go" />
        </button>
      )}
    </div>
  );
}

/** Вкладка «Uzaicini draugus»: страница-лендинг с одной главной кнопкой. */
export function Friends() {
  const { t } = useT();
  const { referral, loaded } = usePerks();
  // Нативный «поделиться» есть не везде; решаем после монтирования, иначе
  // сервер и браузер отрисуют разное, и React пожалуется на расхождение.
  // Хуки — до любого раннего return: их число не должно зависеть от данных.
  const [canShare, setCanShare] = useState(false);
  useEffect(() => { setCanShare(typeof navigator.share === "function"); }, []);

  if (!loaded) return <div className="acct" aria-busy="true" />;
  if (!referral) return null;

  const { rewards, stats, url } = referral;
  const total = rewards.signupCents + rewards.orderCents;
  const text = t("ref.shareText", { pct: rewards.friendPercent });
  const links = shareLinks(url, text);

  const copy = () => { void copyText(url).then((ok) => say(ok ? t("card.copied") : url)); };
  const share = () => {
    void navigator.share({ title: "izsoli.lv", text, url }).catch(() => undefined);
  };

  return (
    <div className="acct">
      <div className="page-head" style={{ alignItems: "flex-start" }}>
        <div>
          <h1 data-hero>{t("ref.tab")}</h1>
          <p className="cnt">{t("ref.intro", { pct: rewards.friendPercent, s: formatEur(rewards.signupCents), o: formatEur(rewards.orderCents) })}</p>
        </div>
      </div>

      <section className="refhero">
        <div className="copy">
          <h2>{t("ref.heroTitle", { total: formatEur(total), pct: rewards.friendPercent })}</h2>
          <p className="note" style={{ fontSize: 15 }}>{t("ref.pointsNote")}</p>
          <p className="note"><Link href="/noteikumi">{t("ref.terms")}</Link></p>
          <button className="btn btn-primary btn-lg" type="button" onClick={copy} style={{ width: "100%", marginTop: 14 }}>
            <Ph name="copy-simple" size={16} /> {t("ref.copyLink")}
          </button>
          <div className="share-row">
            <a className="btn btn-outline btn-sm" href={links.whatsapp} target="_blank" rel="noopener noreferrer">WhatsApp</a>
            <a className="btn btn-outline btn-sm" href={links.telegram} target="_blank" rel="noopener noreferrer">Telegram</a>
            <a className="btn btn-outline btn-sm" href={links.email}>E-pasts</a>
            {canShare && (
              <button className="btn btn-outline btn-sm" type="button" onClick={share}>
                <Ph name="share-network" size={14} /> {t("ref.share")}
              </button>
            )}
          </div>
          <input readOnly value={url} style={{ width: "100%", marginTop: 10 }} onFocus={(e) => e.currentTarget.select()} aria-label={t("ref.copyLink")} />
        </div>
        <div className="art" aria-hidden="true">
          <Ph name="users-three" size={120} />
        </div>
      </section>

      <h2 className="ttl-sm" style={{ marginTop: 22 }}>{t("ref.how")}</h2>
      <div className="refsteps">
        <div><b>1</b>{t("ref.step1")}</div>
        <div><b>2</b>{t("ref.step2", { s: formatEur(rewards.signupCents) })}</div>
        <div><b>3</b>{t("ref.step3", { pct: rewards.friendPercent, o: formatEur(rewards.orderCents) })}</div>
      </div>

      <h2 className="ttl-sm" style={{ marginTop: 22 }}>{t("ref.yourInvites")}</h2>
      <div className="refstats">
        <div><b>{stats.invited}</b><small>{t("ref.stInvited")}</small></div>
        <div><b>{stats.signupRewarded}</b><small>{t("ref.stSignup")}</small></div>
        <div><b>{stats.orderRewarded}</b><small>{t("ref.stOrder")}</small></div>
      </div>
      {stats.onHold > 0 && <p className="note">{t("ref.onHold", { n: stats.onHold })}</p>}
    </div>
  );
}
