"use client";

import Link from "next/link";
import { useState } from "react";
import { dateLocale, useT } from "@/lib/i18n";
import { BrandMark } from "../BrandMark";
import { Ph } from "../Ph";
import { say } from "../Toast";
import type { MyShipment, PickupInfo } from "./data";

/** Izņemšana (макет № 16): пропуск склада, очередь, мои посылки.
 *  «Kā nokļūt» (№ 26) — шторка с картами и копированием адреса. */
export function Pickup({ info, shipments }: { info: PickupInfo; shipments: MyShipment[] }) {
  const { t, lang } = useT();
  const [maps, setMaps] = useState(false);

  const short = (d: string | null) => (d ? new Date(d).toLocaleDateString(dateLocale(lang)) : "—");
  const first = info.pickup[0] ?? null;

  // Группы «Мои посылки» по состоянию — как колонки макета.
  const groups: Array<{ key: string; label: string; rows: MyShipment[] }> = [
    { key: "waiting", label: t("kb.gWaiting"), rows: shipments.filter((s) => s.status === "delivered" && !isPickedUp(s)) },
    { key: "transit", label: t("kb.gTransit"), rows: shipments.filter((s) => s.status === "registered" || s.status === "in_transit") },
    { key: "done", label: t("kb.gDone"), rows: shipments.filter((s) => s.status === "delivered" && isPickedUp(s)) },
  ].filter((g) => g.rows.length > 0);

  const empty = info.pickup.length === 0 && info.ticket === null && shipments.length === 0;

  if (empty) {
    return (
      <div className="acct">
        <div className="empty">
          <span className="ic" aria-hidden="true"><Ph name="map-pin" size={22} /></span>
          <h3>{t("kb.emptyPickupT")}</h3>
          <p>{t("kb.emptyPickupD")}</p>
          <Link className="btn btn-primary" href="/account?tab=pirkumi">{t("kb.toPurchases")}</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="acct pk-cols">
      <div className="pk-main">
        {first && (
          <article className="passcard">
            <header>
              <small>{t("kb.orderN", { ref: first.ref })}</small>
              <span className="lbl">{t("pickup.code")}</span>
              <b className="code tnum">{first.pickupCode ?? "— — — —"}</b>
              <span className="item">{first.itemTitle}</span>
              <span className="doc" aria-hidden="true"><Ph name="qr-code" size={44} /></span>
            </header>
            <div className="pass-rows">
              <div className="prow-s">
                <span className="k"><Ph name="map-pin" size={16} /> {t("kb.where")}</span>
                <b>{t("kb.addressShort")}</b>
                <small>{t("kb.addressHint")}</small>
              </div>
              <div className="prow-s">
                <span className="k"><Ph name="timer" size={16} /> {t("kb.hours")}</span>
                <b>{t("kb.hoursVal")}</b>
                <small>{t("kb.hoursNote")}</small>
              </div>
              <div className="prow-s">
                <span className="k"><Ph name="file-text" size={16} /> {t("kb.bring")}</span>
                <b>{t("kb.bringText")}</b>
              </div>
              <div className="prow-s">
                <span className="k"><Ph name="check" size={16} /> {t("kb.until")}</span>
                <b>{short(first.pickupDeadlineAt)}</b>
                <small>{t("kb.untilNote")}</small>
              </div>
            </div>
            <div className="acts">
              <button className="btn btn-outline" type="button" onClick={() => setMaps(true)}>{t("kb.howTo")}</button>
            </div>
          </article>
        )}

        {info.ticket && (
          <section className="queue">
            <h3 className="ttl-sm">{t("kb.whenHere")}</h3>
            <div className="q-num">
              <b className="tnum">{info.ticket.number}</b>
              <span>
                {t("kb.queueNum")}
                {info.ticket.status === "waiting" && info.ticket.queueAhead > 0 && (
                  <small>{t("kb.queueAhead", { n: info.ticket.queueAhead })}</small>
                )}
              </span>
            </div>
            <ol className="q-steps">
              <li className="done"><i aria-hidden="true"><Ph name="check" size={12} /></i>{t("kb.stepKiosk")}</li>
              <li className={info.ticket.status === "picking" ? "on" : info.ticket.status === "delivering" ? "done" : ""}>
                <i aria-hidden="true" />{t("kb.stepPicking")}
              </li>
              <li className={info.ticket.status === "delivering" ? "on" : ""}><i aria-hidden="true" />{t("kb.stepDesk")}</li>
            </ol>
          </section>
        )}
      </div>

      <aside className="pk-side">
        {info.pickup.length > 0 && (
          <section className="shipgroup">
            <h3 className="ttl-sm">{t("pickup.title")} <span className="n">{info.pickup.length}</span></h3>
            {info.pickup.map((p) => (
              <div className="shiprow" key={p.ref}>
                <span className="mark"><Ph name="map-pin" size={18} /></span>
                <span className="t">
                  <small className="tnum">{p.ref}</small>
                  <b>{p.itemTitle}</b>
                  <small>
                    {p.collecting ? t("kb.stepPicking") : `${t("kb.addressShort")} · ${t("pickup.code").toLowerCase()} ${p.pickupCode ?? "—"}`}
                    {p.pickupDeadlineAt ? ` · ${t("kb.until").toLowerCase()} ${short(p.pickupDeadlineAt)}` : ""}
                  </small>
                </span>
              </div>
            ))}
          </section>
        )}

        {groups.length > 0 && (
          <section className="shipgroup">
            <h3 className="ttl-sm">{t("kb.myDeliveries")}</h3>
            {groups.map((g) => (
              <div key={g.key}>
                <p className="g-lbl">{g.label} <span className="n">{g.rows.length}</span></p>
                {g.rows.map((s) => (
                  <div className="shiprow" key={s.barcode}>
                    <span className="mark"><BrandMark name={s.provider === "dpd" ? "dpd" : "omniva"} h={18} /></span>
                    <span className="t">
                      <small className="tnum">{s.ref}</small>
                      <b>{s.itemTitle}</b>
                      <small>{s.lastEvent?.description ?? s.providerStatus ?? s.status} · <span className="tnum">{s.barcode}</span></small>
                    </span>
                    <a
                      className="btn btn-outline btn-sm" target="_blank" rel="noopener"
                      href={s.provider === "dpd"
                        ? `https://www.dpdgroup.com/lv/mydpd/my-parcels/track?parcelNumber=${encodeURIComponent(s.barcode)}`
                        : `https://www.omniva.lv/privats/sutijuma_atrasanas_vieta?barcode=${encodeURIComponent(s.barcode)}`}
                    >{t("kb.track")}</a>
                  </div>
                ))}
              </div>
            ))}
          </section>
        )}
      </aside>

      {maps && <HowToGet onClose={() => setMaps(false)} />}
    </div>
  );
}

function isPickedUp(s: MyShipment): boolean {
  const code = (s.providerStatus ?? "").toUpperCase();
  return code.includes("PICKED_UP") || code.includes("DELIVERED_TO_CLIENT");
}

/** «Kā nokļūt» — Waze, Google Maps, Apple Maps, копировать адрес (№ 26). */
function HowToGet({ onClose }: { onClose: () => void }) {
  const { t } = useT();
  const addr = t("kb.address");
  const q = encodeURIComponent(addr);
  const rows: Array<{ name: string; brand: string; href: string }> = [
    { name: "Waze", brand: "waze", href: `https://waze.com/ul?q=${q}&navigate=yes` },
    { name: "Google Maps", brand: "googlemaps", href: `https://www.google.com/maps/search/?api=1&query=${q}` },
    { name: "Apple Maps", brand: "applemaps", href: `https://maps.apple.com/?q=${q}` },
  ];
  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label={t("kb.howTo")}>
      <div className="modal-bd" onClick={onClose} />
      <div className="modal-card maps">
        <div className="modal-head">
          <div>
            <small className="cnt">{t("ac.fulfilment")}</small>
            <h2>{t("kb.howTo")}</h2>
          </div>
          <button className="modal-x" type="button" aria-label={t("nav.close")} onClick={onClose}><Ph name="x" size={16} /></button>
        </div>
        <p className="maps-addr">
          <b>{addr}</b>
          <small>{t("kb.addressHint")} · {t("kb.hoursVal")}</small>
        </p>
        {rows.map((r) => (
          <a className="maps-row" key={r.brand} href={r.href} target="_blank" rel="noopener">
            <BrandMark name={r.brand} h={20} />
            <b>{r.name}</b>
            <Ph name="caret-right" size={14} />
          </a>
        ))}
        <button
          className="maps-row" type="button"
          onClick={() => { void navigator.clipboard?.writeText(addr).then(() => say(t("kb.copied"))); }}
        >
          <Ph name="copy-simple" size={18} />
          <b>{t("kb.copyAddr")}</b>
          <Ph name="caret-right" size={14} />
        </button>
      </div>
    </div>
  );
}
