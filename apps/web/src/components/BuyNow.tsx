"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { publicApi, PublicApiError } from "@/lib/api";
import { cartAdd, refreshCart } from "@/lib/cart";
import { conditionLabel } from "@/lib/conditions";
import { useT } from "@/lib/i18n";
import { computeInvoice, marketFees } from "@/lib/fees";
import { photoWeb, photoThumb } from "@/lib/photos";
import { addToCartOnce, gaItem, track } from "@/lib/track";
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
  const [inCart, setInCart] = useState(false);

  useEffect(() => {
    setSignedIn(publicApi.hasSession);
    const fn = () => setSignedIn(publicApi.hasSession);
    publicApi.listeners.add(fn);
    return () => { publicApi.listeners.delete(fn); };
  }, []);

  // Аналитика (GTM): просмотр товара «Pērc uzreiz». Цена финальная —
  // раскладываем той же арифметикой, что движок (комиссия и НДС внутри).
  useEffect(() => {
    const inv = computeInvoice(listing.priceCents, listing.marketCode);
    const netCents = inv.hammerCents + inv.premiumCents;
    track("view_item", {
      item_id: listing.sku, listing_id: listing.id, item_name: listing.title, item_category: listing.category,
      value: netCents / 100, currency: "EUR",
      gross_total: inv.totalCents / 100, commission_value: inv.premiumCents / 100, vat_scheme: "standard",
      ecommerce: {
        currency: "EUR", value: netCents / 100,
        items: [gaItem({
          sku: listing.sku, listingId: listing.id, name: listing.title, category: listing.category,
          netCents, hammerCents: inv.hammerCents, feeCents: inv.premiumCents,
          vatRateBp: marketFees(listing.marketCode).vatRateBp, grossCents: inv.totalCents,
        })],
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listing.id]);

  /** Параметры add_to_cart — одни и те же для гостя и для покупки сразу. */
  const atcParams = () => {
    const inv = computeInvoice(listing.priceCents, listing.marketCode);
    const netCents = inv.hammerCents + inv.premiumCents;
    const item = gaItem({
      sku: listing.sku, listingId: listing.id, name: listing.title, category: listing.category,
      netCents, hammerCents: inv.hammerCents, feeCents: inv.premiumCents,
      vatRateBp: marketFees(listing.marketCode).vatRateBp, grossCents: inv.totalCents,
    });
    return {
      item_id: listing.sku, listing_id: listing.id, item_name: listing.title,
      value: netCents / 100, currency: "EUR",
      gross_total: inv.totalCents / 100,
      commission_value: inv.premiumCents / 100,
      vat_scheme: "standard",
      cart_size: 1,
      cart_gross_total: inv.totalCents / 100,
      ecommerce: { currency: "EUR", value: netCents / 100, items: [item] },
    };
  };

  /** Гость откладывает лот: корзина живёт на сервере, вход не нужен — его
   *  попросят только при оформлении, с возвратом обратно. */
  const addToCart = async () => {
    setBusy(true); setError(null);
    try {
      const r = await cartAdd(listing.id);
      setInCart(true);
      refreshCart();
      say(r.added ? t("cart.added") : t("cart.inCart"));
      // Один раз на лот: повторное нажатие и повторное открытие корзины
      // второго AddToCart не рождают.
      if (r.added) addToCartOnce(`listing:${listing.id}`, atcParams());
    } catch (err) {
      if (err instanceof PublicApiError && err.status === 409) {
        setSoldOut(true); setError(t("buy.soldOut"));
      } else {
        setError(err instanceof Error ? err.message : "error");
      }
    } finally { setBusy(false); }
  };

  const buy = async () => {
    setBusy(true); setError(null);
    try {
      const created = await publicApi.post<{ orderRef?: string }>(
        `/api/public/listings/${listing.id}/buy`,
      );
      setConfirm(false);
      say(t("buy.now"));
      // Аналитика (GTM): лот попал в «к оплате» — это и есть добавление в
      // корзину. Раньше событие жило только на экране общей оплаты, куда
      // покупателя ОДНОГО лота не ведут вовсе, и ступень AddToCart, под
      // которую настраивают кампании Meta и Google, просто отсутствовала.
      const params = atcParams();
      // Ссылка на заказ есть — метим по ней, чтобы повторная покупка такого же
      // лота позже событие не потеряла; нет — метим по карточке.
      refreshCart();
      // Переход в кабинет — только после того, как событие ушло из браузера:
      // иначе запрос пикселя обрывается переходом и AddToCart приходит в Meta
      // одной серверной копией, склеивать которую не с чем.
      addToCartOnce(created?.orderRef ?? `listing:${listing.id}`, params, {
        // Новый заказ ждёт оплаты во вкладке заказов, на обзоре его нет.
        onDone: () => router.push("/account?tab=pirkumi"),
      });
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
                    onClick={() => openShare({ id: listing.id, sku: listing.sku, title: listing.title, kind: "fixed" })}
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
            ) : inCart ? (
              <Link className="btn btn-primary btn-lg btn-block" href="/grozs">{t("cart.open")}</Link>
            ) : (
              /* Гостю вход не нужен: лот откладывается в серверную корзину. */
              <button className="btn btn-primary btn-lg btn-block" type="button" disabled={busy}
                      onClick={() => void addToCart()}>{t("cart.add")}</button>
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
