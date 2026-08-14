"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { PUBLIC_API_URL } from "@/lib/config";
import { CATEGORY_CODES } from "@/lib/categories";
import { useT } from "@/lib/i18n";
import type { PublicAuction } from "@/lib/types";
import { Icon } from "./Icon";

/** Разворот каталога — то, что открывается кнопкой «Katalogs» в шапке.
 *  Слева срезы каталога, по центру все категории со счётчиками,
 *  справа коллекции и подборки. */
const CAT_ICON: Record<string, string> = {
  electronics: "tv", appliances: "coffee", furniture: "chair", tools: "tools",
  home_garden: "home", jewellery_watches: "watch", art_antiques: "art",
  sports_outdoors: "bike", kids_toys: "card", fashion: "box",
  food_household: "box", other: "art",
};

const SLICES: Array<[string, string, string]> = [
  ["rail.live", "bolt", "/tiesraide"],
  ["rail.closing", "timer", "/katalogs?closing=1h"],
  ["rail.noReserve", "tag", "/katalogs?reserve=no"],
  ["cm.new", "plus", "/katalogs"],
  ["nav.results", "gavel", "/rezultati"],
];

const COLLECTIONS: Array<[string, string, string]> = [
  ["coll.premium", "coll.premiumD", "/katalogs"],
  ["coll.stock", "coll.stockD", "/katalogs?reserve=no"],
  ["coll.estate", "coll.estateD", "/katalogs"],
  ["coll.signature", "coll.signatureD", "/katalogs"],
];

export function CatalogMenu({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useT();
  const [counts, setCounts] = useState<Record<string, number> | null>(null);
  const [total, setTotal] = useState(0);
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open || counts) return;
    void fetch(`${PUBLIC_API_URL}/api/public/auctions?limit=100`)
      .then((r) => r.json() as Promise<{ auctions: PublicAuction[] }>)
      .then((r) => {
        const c: Record<string, number> = {};
        for (const a of r.auctions) c[a.category] = (c[a.category] ?? 0) + 1;
        setCounts(c);
        setTotal(r.auctions.length);
      })
      .catch(() => setCounts({}));
  }, [open, counts]);

  // Escape, клик мимо и ловушка фокуса — как у остальных наложений макета.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { onClose(); return; }
      if (e.key !== "Tab" || !panel.current) return;
      const f = Array.from(panel.current.querySelectorAll<HTMLElement>("a,button"))
        .filter((n) => n.offsetParent !== null);
      if (!f.length) return;
      const first = f[0]!, last = f[f.length - 1]!;
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKey);
    document.body.classList.add("no-scroll");
    panel.current?.querySelector<HTMLElement>("a,button")?.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.classList.remove("no-scroll");
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <>
      <div className="cmenu-bd" onClick={onClose} />
      <div className="cmenu" ref={panel} role="dialog" aria-modal="true" aria-label={t("nav.catalogue")}>
        <div className="wrap cmenu-in">
          <div className="cmenu-col">
            <h3>{t("srch.quickViews")}</h3>
            <ul>
              {SLICES.map(([key, icon, href]) => (
                <li key={key}>
                  <Link href={href} onClick={onClose}>
                    <span className="ic"><Icon name={icon} /></span>{t(key)}
                  </Link>
                </li>
              ))}
            </ul>
          </div>

          <div className="cmenu-col cmenu-cats">
            <h3>{t("nav.allCategories")}</h3>
            <div className="cmenu-grid">
              {CATEGORY_CODES.map((c) => (
                <Link key={c} href={`/katalogs?category=${c}`} onClick={onClose}>
                  <span className="ic"><Icon name={CAT_ICON[c] ?? "art"} /></span>
                  <span className="nm">{t(`cat.${c}`)}</span>
                  {counts && <span className="c">{counts[c] ?? 0}</span>}
                </Link>
              ))}
            </div>
          </div>

          <div className="cmenu-col">
            <h3>{t("cm.collections")}</h3>
            <ul className="cmenu-colls">
              {COLLECTIONS.map(([key, subKey, href]) => (
                <li key={key}>
                  <Link href={href} onClick={onClose}>
                    <b>{t(key)}</b><small>{t(subKey)}</small>
                  </Link>
                </li>
              ))}
            </ul>
            <Link className="btn btn-primary btn-block" href="/katalogs" onClick={onClose}>
              {t("cm.openAll")}{total ? ` · ${total}` : ""} <Icon name="arrow" size={16} />
            </Link>
            <Link className="link" href="/zimoli" onClick={onClose} style={{ marginTop: 12 }}>
              {t("cm.byBrand")} <Icon name="arrow" size={14} />
            </Link>
          </div>
        </div>
      </div>
    </>
  );
}
