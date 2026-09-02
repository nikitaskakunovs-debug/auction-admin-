"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { computeInvoice, marketFees } from "@/lib/fees";
import { useT } from "@/lib/i18n";
import { formatEur } from "@/lib/types";
import { Icon } from "./Icon";
import { say } from "./Toast";

/** Модалки макета: шкала состояния и «Поделиться».
 *  Открываются из любой карточки — состояние держим в модуле, чтобы не тащить
 *  контекст через всё дерево. */
/** kind решает путь ссылки: аукцион живёт на /auction/<id>, товар с фиксированной
 *  ценой — на /listing/<id>. Раньше всё уходило на /auction/, и ссылка на
 *  «Pirkt tagad»-товар вела в «Šādas lapas nav». */
type ShareLot = { id: string; sku: string; title: string; icon?: string; kind?: "auction" | "fixed" };
/** Подтверждение быстрой ставки из карточки: та же раскладка суммы, что в
 *  окне на странице лота. Саму ставку кладёт вызвавший через onConfirm —
 *  тосты об исходе тоже на его совести. */
type BidConfirm = { sku: string; title: string; marketCode: string; amountCents: number; onConfirm: () => Promise<void> };
type State = { scale: string | null; share: ShareLot | null; bid: BidConfirm | null };

const CLOSED: State = { scale: null, share: null, bid: null };
let setState: ((s: State) => void) | null = null;
export function openScale(grade: string) { setState?.({ ...CLOSED, scale: grade }); }
export function openShare(lot: ShareLot) { setState?.({ ...CLOSED, share: lot }); }
export function openBidConfirm(bid: BidConfirm) { setState?.({ ...CLOSED, bid }); }

const SCALE: Array<[string, string, string]> = [
  ["A+", "scale.aPlus", "scale.aPlusD"],
  ["A", "scale.a", "scale.aD"],
  ["A−", "scale.aMinus", "scale.aMinusD"],
  ["B", "scale.b", "scale.bD"],
  ["D", "scale.d", "scale.dD"],
];

const FOCUSABLE = 'a[href],button:not([disabled]),input,select,textarea,[tabindex]:not([tabindex="-1"])';

export function Modals() {
  const { t } = useT();
  const [state, set] = useState<State>(CLOSED);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const card = useRef<HTMLDivElement>(null);
  const restore = useRef<HTMLElement | null>(null);
  const open = state.scale !== null || state.share !== null || state.bid !== null;

  useEffect(() => { setState = set; return () => { setState = null; }; }, []);
  useEffect(() => { setBusy(false); }, [state.bid]);

  // Ловушка фокуса, Escape и возврат фокуса на кнопку, из которой открыли.
  useEffect(() => {
    if (!open) return;
    restore.current = document.activeElement as HTMLElement;
    document.body.classList.add("no-scroll");
    card.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { set(CLOSED); return; }
      if (e.key !== "Tab" || !card.current) return;
      const f = Array.from(card.current.querySelectorAll<HTMLElement>(FOCUSABLE))
        .filter((n) => n.offsetParent !== null);
      if (!f.length) return;
      const first = f[0]!, last = f[f.length - 1]!;
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.classList.remove("no-scroll");
      restore.current?.focus();
    };
  }, [open]);

  const close = () => set(CLOSED);

  if (state.scale !== null) {
    return (
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="m-scale-t">
        <div className="modal-bd" onClick={close} />
        <div className="modal-card" ref={card}>
          <div className="modal-head">
            <div>
              <h3 id="m-scale-t">{t("scale.title")}</h3>
              <p>{t("scale.intro")}</p>
            </div>
            <button className="modal-x" type="button" aria-label={t("nav.close")} onClick={close}><Icon name="x" /></button>
          </div>
          <div className="scale">
            {SCALE.map(([g, titleKey, descKey]) => (
              <div key={g} className={`scale-row${g === state.scale ? " on" : ""}`}>
                <span className="g" aria-hidden="true">{g}</span>
                <span>
                  <b>{t(titleKey)}{g === state.scale && <span className="this">{t("scale.thisLot")}</span>}</b>
                  <small>{t(descKey)}</small>
                </span>
              </div>
            ))}
          </div>
          <Link className="btn btn-primary btn-block" href="/conditions" onClick={close}>
            {t("scale.handbook")} <Icon name="arrow" size={16} />
          </Link>
        </div>
      </div>
    );
  }

  if (state.bid) {
    const b = state.bid;
    const inv = computeInvoice(b.amountCents, b.marketCode);
    const fees = marketFees(b.marketCode);
    const go = async () => {
      setBusy(true);
      try { await b.onConfirm(); } finally { setBusy(false); close(); }
    };
    return (
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="m-cbid-t">
        <div className="modal-bd" onClick={close} />
        <div className="modal-card" ref={card}>
          <div className="modal-head">
            <div>
              <span className="kicker">{t("lp.confirmKicker")} · {b.sku}</span>
              <h3 id="m-cbid-t">{b.title}</h3>
            </div>
            <button className="modal-x" type="button" aria-label={t("nav.close")} onClick={close}><Icon name="x" /></button>
          </div>
          <div className="sum">
            <p className="sum-lab">{t("lp.yourMaxBid")}</p>
            <p className="sum-amt tnum">{formatEur(b.amountCents)}</p>
          </div>
          <table className="fees"><tbody>
            <tr><th scope="row">{t("lp.ifYouWin")}</th><td className="tnum">{formatEur(inv.hammerCents)}</td></tr>
            <tr><th scope="row">{t("lp.premium", { n: fees.buyerPremiumBp / 100 })}</th><td className="tnum">{formatEur(inv.premiumCents)}</td></tr>
            <tr><th scope="row">PVN ({fees.vatRateBp / 100} %)</th><td className="tnum">{formatEur(inv.vatCents)}</td></tr>
            <tr className="tot"><th scope="row">{t("lp.totalIfWin")}</th><td className="tnum">{formatEur(inv.totalCents)}</td></tr>
          </tbody></table>
          <button className="btn btn-primary btn-block" type="button" disabled={busy} style={{ marginTop: 12 }}
                  onClick={() => void go()}>
            {busy ? t("lp.sending") : t("lp.confirmBid")}
          </button>
          <button className="btn btn-outline btn-block" type="button" style={{ marginTop: 8 }} onClick={close}>
            {t("nav.cancel")}
          </button>
          <p className="note" style={{ textAlign: "center", marginTop: 12 }}>{t("lp.bindingNote")}</p>
        </div>
      </div>
    );
  }

  if (state.share) {
    const path = state.share.kind === "fixed" ? "listing" : "auction";
    const url = typeof location !== "undefined"
      ? `${location.origin}/${path}/${state.share.id}` : `https://izsoli.lv/${path}/${state.share.id}`;
    const u = encodeURIComponent(url);
    const txt = encodeURIComponent(`${state.share.title} — Izsoli.lv`);
    const channels: Array<[string, string, string]> = [
      ["WhatsApp", "wa", `https://wa.me/?text=${txt}%20${u}`],
      ["Telegram", "tg", `https://t.me/share/url?url=${u}&text=${txt}`],
      ["Facebook", "fb", `https://www.facebook.com/sharer/sharer.php?u=${u}`],
      [t("share.email"), "mail", `mailto:?subject=${txt}&body=${u}`],
    ];
    return (
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="m-share-t">
        <div className="modal-bd" onClick={close} />
        <div className="modal-card" ref={card}>
          <div className="modal-head">
            <div className="share-lot">
              <span className="ic" aria-hidden="true"><Icon name={state.share.icon ?? "art"} /></span>
              <span>
                <span className="kicker">{t("share.kicker")} · {state.share.sku}</span>
                <h3 id="m-share-t">{state.share.title}</h3>
              </span>
            </div>
            <button className="modal-x" type="button" aria-label={t("nav.close")} onClick={close}><Icon name="x" /></button>
          </div>
          <div className="share-url">
            <span className="f">
              <Icon name="link" />
              <label className="sr" htmlFor="share-input">{t("share.linkLabel")}</label>
              <input id="share-input" readOnly value={url} />
            </span>
            <button
              className="btn btn-primary"
              type="button"
              onClick={() => {
                navigator.clipboard?.writeText(url).catch(() => {});
                setCopied(true);
                say(t("card.copied"));
                setTimeout(() => setCopied(false), 1800);
              }}
            >{copied ? t("share.copied") : t("share.copy")}</button>
          </div>
          <div className="share-grid">
            {channels.map(([label, icon, href]) => (
              <a key={label} className="share-btn" href={href}
                 target={icon === "mail" ? undefined : "_blank"}
                 rel={icon === "mail" ? undefined : "noopener noreferrer"}
                 onClick={() => { say(t("share.opening", { ch: label })); setTimeout(close, 150); }}>
                <Icon name={icon} />{label}
              </a>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return null;
}
