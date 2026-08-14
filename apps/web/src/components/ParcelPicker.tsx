"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { publicApi } from "@/lib/api";
import type { ParcelLocation } from "@/lib/types";
import { useT } from "@/lib/i18n";
import { Icon } from "./Icon";

/** Выбор пакомата. Точки приходят из движка:
 *  GET /api/public/shipping/locations?country=LV&provider=omniva|dpd —
 *  это те же справочники, по которым потом создаётся отправление, поэтому
 *  выбранный id уходит в заказ как `machineId`.
 *
 *  Открывается модалкой: поиск по городу и адресу, группировка по городам,
 *  крупные строки под палец. */
export function ParcelPicker({
  provider, valueId, onPick, country = "LV",
}: {
  provider: "omniva" | "dpd";
  valueId: string;
  onPick: (l: ParcelLocation) => void;
  country?: string;
}) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const [all, setAll] = useState<ParcelLocation[] | null>(null);
  const [q, setQ] = useState("");
  const card = useRef<HTMLDivElement>(null);
  const restore = useRef<HTMLElement | null>(null);

  useEffect(() => {
    setAll(null);
    void publicApi
      .get<{ locations: ParcelLocation[] }>(`/api/public/shipping/locations?country=${country}&provider=${provider}`)
      .then((r) => setAll(r.locations))
      .catch(() => setAll([]));
  }, [provider, country]);

  useEffect(() => {
    if (!open) return;
    restore.current = document.activeElement as HTMLElement;
    document.body.classList.add("no-scroll");
    // На телефоне не открываем клавиатуру сразу — она закрыла бы список
    // пакоматов. Там сначала показываем города, поиск по тапу.
    if (matchMedia("(pointer:fine)").matches) {
      card.current?.querySelector<HTMLElement>("input")?.focus();
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.classList.remove("no-scroll");
      restore.current?.focus();
    };
  }, [open]);

  const chosen = all?.find((l) => l.id === valueId) ?? null;

  const groups = useMemo(() => {
    const rows = (all ?? []).filter((l) =>
      !q.trim() || `${l.city} ${l.name} ${l.address} ${l.zip}`.toLowerCase().includes(q.trim().toLowerCase()));
    const by = new Map<string, ParcelLocation[]>();
    for (const l of rows) {
      const k = l.city || "—";
      const arr = by.get(k);
      if (arr) arr.push(l); else by.set(k, [l]);
    }
    return [...by.entries()].sort((a, b) => a[0].localeCompare(b[0], "lv"));
  }, [all, q]);

  const shownCount = groups.reduce((n, g) => n + g[1].length, 0);
  const label = provider === "dpd" ? "DPD Pickup" : "Omniva";

  return (
    <>
      <button className="parcel-btn" type="button" onClick={() => setOpen(true)}
              aria-haspopup="dialog" aria-expanded={open}>
        <span className="ic" aria-hidden="true"><Icon name="pin" /></span>
        <span className="t">
          <span className="lab">{t("pp.provider", { p: label })}</span>
          <span className="v">{chosen ? `${chosen.city} — ${chosen.name}` : t("pp.pickParcel")}</span>
        </span>
        <Icon name="chev" className="chev" size={18} />
      </button>

      {open && (
        <div className="modal" role="dialog" aria-modal="true" aria-labelledby="parcel-t">
          <div className="modal-bd" onClick={() => setOpen(false)} />
          <div className="modal-card parcel-card" ref={card}>
            <div className="modal-head">
              <div>
                <span className="kicker">{label}</span>
                <h3 id="parcel-t">{t("pp.pickParcel")}</h3>
              </div>
              <button className="modal-x" type="button" aria-label={t("nav.close")}
                      onClick={() => setOpen(false)}><Icon name="x" /></button>
            </div>

            <div className="share-url">
              <span className="f">
                <Icon name="search" />
                <label className="sr" htmlFor="parcel-q">{t("pp.searchLabel")}</label>
                <input id="parcel-q" value={q} onChange={(e) => setQ(e.target.value)}
                       placeholder={t("pp.searchPh")} autoComplete="off" />
              </span>
            </div>

            <p className="note" style={{ margin: "0 0 8px" }} role="status" aria-live="polite">
              {all === null ? t("pp.loading") : t("pp.countN", { n: shownCount })}
            </p>

            <div className="parcel-list">
              {all !== null && shownCount === 0 && (
                <p className="note" style={{ padding: 16 }}>
                  {t("pp.nothing")}
                </p>
              )}
              {groups.map(([city, rows]) => (
                <section key={city}>
                  <h4>{city}</h4>
                  {rows.map((l) => (
                    <button key={l.id} type="button"
                            className={`parcel-row${l.id === valueId ? " on" : ""}`}
                            aria-pressed={l.id === valueId}
                            onClick={() => { onPick(l); setOpen(false); }}>
                      <span className="ic" aria-hidden="true"><Icon name="box" /></span>
                      <span className="t">
                        <b>{l.name}</b>
                        <small>{l.address}{l.zip ? ` · ${l.zip}` : ""}</small>
                      </span>
                      {l.id === valueId && <Icon name="check" size={18} />}
                    </button>
                  ))}
                </section>
              ))}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
