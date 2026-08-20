"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { publicApi, PublicApiError } from "@/lib/api";
import { conditionLabel } from "@/lib/conditions";
import { useT } from "@/lib/i18n";
import { photoWeb, photoThumb } from "@/lib/photos";
import { formatEur, type FixedListing } from "@/lib/types";
import { KlixPayLater } from "@/components/KlixPayLater";
import { Icon } from "./Icon";
import { openShare } from "./Modals";
import { say } from "./Toast";

/** Лот с фиксированной ценой — та же раскладка, что у страницы аукциона:
 *  галерея слева, блок покупки справа. Комиссии тут нет, только НДС. */
export function BuyNow({ listing }: { listing: FixedListing }) {
  const { t } = useT();
  const router = useRouter();
  const [signedIn, setSignedIn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [soldOut, setSoldOut] = useState(!!listing.soldOut);
  const [frame, setFrame] = useState(0);
  const [confirm, setConfirm] = useState(false);

  useEffect(() => {
    setSignedIn(publicApi.hasSession);
    const fn = () => setSignedIn(publicApi.hasSession);
    publicApi.listeners.add(fn);
    return () => { publicApi.listeners.delete(fn); };
  }, []);

  const buy = async () => {
    setBusy(true); setError(null);
    try {
      await publicApi.post(`/api/public/listings/${listing.id}/buy`);
      setConfirm(false);
      say(t("buy.now"));
      // Сразу на вкладку заказов: новый заказ ждёт оплаты именно там,
      // на обзоре его карточки нет.
      router.push("/account?tab=orders");
    } catch (err) {
      if (err instanceof PublicApiError && err.body.code === "NOT_AVAILABLE") {
        setSoldOut(true); setError(t("buy.soldOut"));
      } else if (err instanceof PublicApiError && err.body.code === "BIDDER_BLOCKED") {
        setError(t("buy.blocked"));
      } else if (err instanceof PublicApiError && err.body.code === "EMAIL_NOT_VERIFIED") {
        setError(t("lc.verifyFirst"));
      } else if (err instanceof PublicApiError && err.body.code === "FEES_OUTSTANDING") {
        setError(t("fees.blockedShort"));
      } else {
        setError(err instanceof Error ? err.message : "error");
      }
    } finally { setBusy(false); }
  };

  const shots = listing.photos.length ? listing.photos : new Array<string | null>(3).fill(null);

  return (
    <section className="wrap" style={{ paddingTop: 24 }}>
      <nav className="crumbs" aria-label={t("nav.breadcrumb")}>
        <ol>
          <li><Link href="/">{t("nav.home")}</Link></li>
          <li><Link href="/katalogs?type=fixed">{t("buy.badge")}</Link></li>
          <li aria-current="page">{listing.title}</li>
        </ol>
      </nav>

      <div className="lot-page">
        <div>
          <div className="lgal">
            {shots.map((p, i) => (
              <span key={i} className={`lframe frame-${i + 1}${i === frame ? " on" : ""}`}>
                {p ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={photoWeb(p)} alt={i === 0 ? listing.title : ""} loading={i === 0 ? "eager" : "lazy"} />
                ) : <Icon name="box" className="pic" />}
              </span>
            ))}
            <span className="lcount">{frame + 1} / {shots.length}</span>
          </div>
          <div className="lthumbs">
            {shots.map((p, i) => (
              <button key={i} className={`lthumb${i === frame ? " on" : ""}`} type="button"
                      aria-label={t("card.photoN", { i: i + 1, n: shots.length })}
                      aria-current={i === frame ? "true" : undefined}
                      onClick={() => setFrame(i)}>
                {p ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={photoThumb(p)} alt="" loading="lazy" />
                ) : <span className={`frame-${i + 1}`}><Icon name="box" /></span>}
              </button>
            ))}
          </div>

          <div className="facts">
            <div><span>{t("bn.lot")}</span><b>{listing.sku}</b></div>
            <div><span>{t("bn.condition")}</span><b>{conditionLabel(listing.condition, t)}</b></div>
            <div><span>{t("bn.market")}</span><b>{listing.marketCode}</b></div>
          </div>

          {(listing.conditionNotes || listing.description) && (
            <section className="report">
              <div className="rep-head"><h2>{t("bn.about")}</h2></div>
              {listing.conditionNotes && (
                <div className="rep-strip">
                  <span className="ic" aria-hidden="true"><Icon name="shield" /></span>
                  <div><b>{t("cond.notes")}</b><p>{listing.conditionNotes}</p></div>
                </div>
              )}
              {listing.description && <p className="note" style={{ fontSize: 15 }}>{listing.description}</p>}
            </section>
          )}
        </div>

        <div className="lot-side">
          <div className="ltags">
            <span className="tag">{t("buy.badge")}</span>
            <span className="tag">{conditionLabel(listing.condition, t)}</span>
          </div>
          <h1 data-hero>{listing.title}</h1>

          <div className="lacts">
            <button type="button" aria-haspopup="dialog" aria-label={t("bn.share")}
                    onClick={() => openShare({ id: listing.id, sku: listing.sku, title: listing.title })}
            ><Icon name="share" /></button>
          </div>

          <div className="bidbox">
            <div className="bb-price">
              <div>
                <p className="price-lab">{t("buy.price")}</p>
                <p className="big tnum">{formatEur(listing.priceCents)}</p>
                <p className="note">{t("buy.vatNote")}</p>
              </div>
            </div>

            {error && <p className="bb-status err">{error}</p>}

            {soldOut ? (
              <p className="bb-status warn">{t("buy.soldOut")}</p>
            ) : signedIn ? (
              <button className="btn btn-primary btn-lg btn-block" type="button" disabled={busy}
                      aria-haspopup="dialog" onClick={() => setConfirm(true)}>{t("buy.now")}</button>
            ) : (
              <Link className="btn btn-primary btn-lg btn-block" href="/login">{t("buy.signin")}</Link>
            )}

            {!soldOut && listing.estimatedTotalCents ? (
              <div style={{ marginTop: 12 }}>
                <KlixPayLater amountCents={listing.estimatedTotalCents} view="product" />
              </div>
            ) : null}

            <p className="fine">{t("bn.noPremium")}</p>
          </div>
        </div>
      </div>

      {/* ═══ МОДАЛКА: ПОДТВЕРЖДЕНИЕ ПОКУПКИ ═══ */}
      {confirm && (
        <div className="modal" role="dialog" aria-modal="true" aria-labelledby="m-buy-t">
          <div className="modal-bd" onClick={() => setConfirm(false)} />
          <div className="modal-card">
            <div className="modal-head">
              <div>
                <span className="kicker">{t("bn.confirmKicker")} · {listing.sku}</span>
                <h3 id="m-buy-t">{listing.title}</h3>
              </div>
              <button className="modal-x" type="button" aria-label={t("nav.close")}
                      onClick={() => setConfirm(false)}><Icon name="x" /></button>
            </div>
            <div className="sum">
              <p className="sum-lab">{t("buy.price")}</p>
              <p className="sum-amt tnum">{formatEur(listing.priceCents)}</p>
              <p className="note">{t("buy.vatNote")}</p>
            </div>
            <table className="fees"><tbody>
              <tr><th scope="row">{t("bn.item")}</th><td className="tnum">{formatEur(listing.priceCents)}</td></tr>
              {listing.estimatedTotalCents ? (
                <>
                  <tr><th scope="row">{t("bn.vat")}</th>
                    <td className="tnum">{formatEur(listing.estimatedTotalCents - listing.priceCents)}</td></tr>
                  <tr className="tot"><th scope="row">{t("bn.total")}</th>
                    <td className="tnum">{formatEur(listing.estimatedTotalCents)}</td></tr>
                </>
              ) : null}
            </tbody></table>
            {error && <p className="bb-status out">{error}</p>}
            <button className="btn btn-primary btn-block" type="button" disabled={busy}
                    onClick={() => void buy()}>
              {busy ? t("bn.processing") : t("bn.buyAndPay")}
            </button>
            <button className="btn btn-outline btn-block" type="button" style={{ marginTop: 8 }}
                    onClick={() => setConfirm(false)}>{t("bn.cancel")}</button>
            <p className="note" style={{ textAlign: "center", marginTop: 12 }}>
              {t("bn.noPremium")}
            </p>
          </div>
        </div>
      )}
    </section>
  );
}
