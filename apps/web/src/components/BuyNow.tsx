"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { PublicApiError } from "@/lib/api";
import { cartAdd, cartList, refreshCart } from "@/lib/cart";
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [soldOut, setSoldOut] = useState(!!listing.soldOut);
  const [frame, setFrame] = useState(0);
  const [inCart, setInCart] = useState(false);

  // Лот уже отложен? Карточка обязана это помнить и после ухода в кабинет
  // и обратно — иначе кнопка выглядит так, будто ничего не было.
  useEffect(() => {
    void cartList()
      .then((c) => setInCart(c.items.some((i) => i.listingId === listing.id)))
      .catch(() => undefined);
  }, [listing.id]);

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

  /** Единственный путь покупки — через корзину, и для гостя, и для
   *  вошедшего: лот откладывается на сервере, заказ родится в грозсе.
   *  «Pirkt tagad» — то же добавление плюс переход сразу в грозс. */
  const addToCart = async (goToCart: boolean) => {
    setBusy(true); setError(null);
    try {
      const r = await cartAdd(listing.id);
      setInCart(true);
      refreshCart();
      // Один раз на лот: повторное нажатие и повторное открытие корзины
      // второго AddToCart не рождают.
      if (r.added) addToCartOnce(`listing:${listing.id}`, atcParams());
      if (goToCart) {
        router.push("/grozs");
        return;
      }
      // Резерв стартует с добавления — человека сразу предупреждают,
      // сколько у него времени на завершение заказа.
      say(!r.added ? t("cart.inCart") : r.reservedUntil ? t("cart.added10") : t("cart.added"));
    } catch (err) {
      if (err instanceof PublicApiError && err.status === 409) {
        setSoldOut(true); setError(t("buy.soldOut"));
      } else {
        setError(err instanceof Error ? err.message : "error");
      }
    } finally { setBusy(false); }
  };

  const stock = listing.stock ?? listing.quantity;
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

            {/* Живой остаток: единицы минус чужие резервы. Больше одной —
                говорим сколько; ноль при живом лоте — всё на оформлении. */}
            {!soldOut && stock > 1 && <p className="note">{t("bn.stock", { n: stock })}</p>}

            {soldOut ? (
              <p className="bb-status warn">{t("buy.soldOut")}</p>
            ) : stock === 0 ? (
              <p className="bb-status warn">{t("cart.allReserved")}</p>
            ) : inCart ? (
              <Link className="btn btn-primary btn-lg btn-block" href="/grozs">{t("cart.open")}</Link>
            ) : (
              /* Путь один для всех — через корзину, вход спросят при
                 оформлении. «Pirkt tagad» = положить и сразу в грозс. */
              <>
                <button className="btn btn-primary btn-lg btn-block" type="button" disabled={busy}
                        onClick={() => void addToCart(true)}>{t("buy.now")}</button>
                <button className="btn btn-outline btn-lg btn-block" type="button" disabled={busy}
                        style={{ marginTop: 8 }}
                        onClick={() => void addToCart(false)}>{t("cart.add")}</button>
              </>
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

    </section>
  );
}
