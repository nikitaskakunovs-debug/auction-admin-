"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useT } from "@/lib/i18n";
import { Icon } from "./Icon";
import { say } from "./Toast";

/** Модалки макета: шкала состояния и «Поделиться».
 *  Открываются из любой карточки — состояние держим в модуле, чтобы не тащить
 *  контекст через всё дерево. */
type ShareLot = { id: string; sku: string; title: string; icon?: string };
type State = { scale: string | null; share: ShareLot | null };

let setState: ((s: State) => void) | null = null;
export function openScale(grade: string) { setState?.({ scale: grade, share: null }); }
export function openShare(lot: ShareLot) { setState?.({ scale: null, share: lot }); }

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
  const [state, set] = useState<State>({ scale: null, share: null });
  const [copied, setCopied] = useState(false);
  const card = useRef<HTMLDivElement>(null);
  const restore = useRef<HTMLElement | null>(null);
  const open = state.scale !== null || state.share !== null;

  useEffect(() => { setState = set; return () => { setState = null; }; }, []);

  // Ловушка фокуса, Escape и возврат фокуса на кнопку, из которой открыли.
  useEffect(() => {
    if (!open) return;
    restore.current = document.activeElement as HTMLElement;
    document.body.classList.add("no-scroll");
    card.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { set({ scale: null, share: null }); return; }
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

  const close = () => set({ scale: null, share: null });

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

  if (state.share) {
    const url = typeof location !== "undefined"
      ? `${location.origin}/auction/${state.share.id}` : `https://izsoli.lv/auction/${state.share.id}`;
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
