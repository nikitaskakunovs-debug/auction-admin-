"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { publicApi } from "@/lib/api";
import { cartList, myPromoCodes } from "@/lib/cart";
import { useT } from "@/lib/i18n";
import { formatEur } from "@/lib/types";

/**
 * Тихий баннер главной (MD §5a.4, §7.9 — мягкая замена exit-intent).
 *
 * Одна негромкая строка, никогда не поп-ап и не sticky: (1) «корзина ждёт»,
 * (2) баланс баллов, (3) неиспользованный личный код. Показывается по одному,
 * закрывается крестиком на сутки. Гость видит только корзину.
 */
const DISMISS_KEY = "izsoli_quiet_banner_v1";

type Msg =
  | { kind: "cart"; n: number }
  | { kind: "points"; cents: number }
  | { kind: "promo"; code: string; pct: number };

export function QuietBanner() {
  const { t } = useT();
  const [msg, setMsg] = useState<Msg | null>(null);

  useEffect(() => {
    try {
      const until = Number(localStorage.getItem(DISMISS_KEY) ?? 0);
      if (until > Date.now()) return;
    } catch { /* приватный режим — просто покажем */ }
    let cancelled = false;
    void (async () => {
      try {
        const cart = await cartList();
        if (!cancelled && cart.count > 0) { setMsg({ kind: "cart", n: cart.count }); return; }
        if (!publicApi.hasSession) return;
        const pts = await publicApi.get<{ balanceCents: number }>("/api/public/me/points");
        if (!cancelled && pts.balanceCents >= 100) { setMsg({ kind: "points", cents: pts.balanceCents }); return; }
        const codes = await myPromoCodes();
        const c = codes.codes.find((x) => x.type === "percent");
        if (!cancelled && c) setMsg({ kind: "promo", code: c.code, pct: c.value });
      } catch { /* тишина — баннер не обязан существовать */ }
    })();
    return () => { cancelled = true; };
  }, []);

  if (!msg) return null;
  const dismiss = () => {
    setMsg(null);
    try { localStorage.setItem(DISMISS_KEY, String(Date.now() + 86_400_000)); } catch { /* ignore */ }
  };

  return (
    <div className="wrap" style={{ paddingTop: 10 }}>
      <div role="status" style={{
        display: "flex", alignItems: "center", gap: 10, padding: "10px 14px",
        background: "var(--bg-2, #f2f5ef)", borderRadius: 10, fontSize: 14.5,
      }}>
        <span style={{ flex: 1 }}>
          {msg.kind === "cart" && (<>{t("qb.cart", { n: msg.n })} <Link href="/grozs">{t("cart.open")}</Link></>)}
          {msg.kind === "points" && (<>{t("qb.points", { sum: formatEur(msg.cents) })} <Link href="/punkti">{t("qb.more")}</Link></>)}
          {msg.kind === "promo" && (<>{t("qb.promo", { pct: msg.pct, code: msg.code })} <Link href="/katalogs?type=fixed">{t("kb.findLots")}</Link></>)}
        </span>
        <button type="button" aria-label={t("nav.close")} onClick={dismiss}
                style={{ background: "none", border: 0, cursor: "pointer", fontSize: 16, lineHeight: 1 }}>×</button>
      </div>
    </div>
  );
}
