"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { publicApi, PublicApiError } from "@/lib/api";
import { conditionLabel } from "@/lib/conditions";
import { PUBLIC_API_URL } from "@/lib/config";
import { useT } from "@/lib/i18n";
import { PhotoGallery } from "./PhotoGallery";
import { formatEur, type AuctionDetail } from "@/lib/types";
import { KlixPayLater } from "@/components/KlixPayLater";
import { Countdown } from "./Countdown";

export function LiveAuction({ initial }: { initial: AuctionDetail }) {
  const { t, lang } = useT();
  const [detail, setDetail] = useState(initial);
  const [signedIn, setSignedIn] = useState(false);
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ text: string; tone: "ok" | "warn" | "err" } | null>(null);

  const a = detail.auction;
  const live = a.status === "live";
  const myLatest = detail.bids.find((b) => b.isYou);
  const iLead = myLatest !== undefined && detail.bids[0]?.isYou === true && !detail.bids[0]?.outbid;

  const reload = useCallback(async () => {
    try {
      const fresh = await publicApi.get<AuctionDetail>(`/api/public/auctions/${a.id}`);
      setDetail(fresh);
    } catch {
      // transient — keep current view
    }
  }, [a.id]);

  useEffect(() => {
    setSignedIn(publicApi.hasSession);
    const fn = () => setSignedIn(publicApi.hasSession);
    publicApi.listeners.add(fn);
    return () => {
      publicApi.listeners.delete(fn);
    };
  }, []);

  // Live updates over WebSocket (anonymous allowed), reconnecting.
  const reloadRef = useRef(reload);
  reloadRef.current = reload;
  useEffect(() => {
    let ws: WebSocket | null = null;
    let closed = false;
    let retry = 0;
    const connect = () => {
      if (closed) return;
      ws = new WebSocket(`${PUBLIC_API_URL.replace(/^http/, "ws")}/ws`);
      ws.onopen = () => {
        retry = 0;
        ws?.send(JSON.stringify({ type: "subscribe", auctionId: a.id }));
      };
      ws.onmessage = () => void reloadRef.current();
      ws.onclose = () => {
        if (!closed) setTimeout(connect, Math.min(1000 * 2 ** retry++, 10_000));
      };
    };
    connect();
    return () => {
      closed = true;
      ws?.close();
    };
  }, [a.id]);

  const placeBid = async () => {
    const cents = Math.round(parseFloat(amount.replace(",", ".")) * 100);
    if (!Number.isFinite(cents) || cents <= 0) {
      setNotice({ text: t("a.minBid") + ": " + formatEur(detail.minNextBidCents), tone: "warn" });
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      const r = await publicApi.post<{ youLead: boolean; currentPriceCents: number; extended: boolean }>(
        `/api/public/auctions/${a.id}/bids`,
        { maxCents: cents },
      );
      setNotice(
        r.youLead
          ? { text: t("a.youLead"), tone: "ok" }
          : { text: `${t("a.outbid")} — ${formatEur(r.currentPriceCents)}`, tone: "warn" },
      );
      if (r.extended) setNotice((n) => ({ text: `${t("a.extended")}${n ? " · " + n.text : ""}`, tone: n?.tone ?? "ok" }));
      setAmount("");
      await reload();
    } catch (err) {
      if (err instanceof PublicApiError && typeof err.body.minAcceptableCents === "number") {
        setNotice({ text: `${t("a.minBid")}: ${formatEur(err.body.minAcceptableCents)}`, tone: "err" });
      } else if (err instanceof PublicApiError && err.body.code === "FEES_OUTSTANDING") {
        setNotice({ text: t("fees.blockedShort"), tone: "err" });
      } else {
        setNotice({ text: err instanceof Error ? err.message : "error", tone: "err" });
      }
    } finally {
      setBusy(false);
    }
  };

  const noticeColors = { ok: ["#E4F4EA", "#1F8A4C"], warn: ["#FCEFD9", "#9A5B00"], err: ["#FBE3E3", "#B0282C"] } as const;

  return (
    <div style={{ display: "grid", gap: 20 }}>
      <div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {live && (
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, fontWeight: 700, color: "#1F8A4C" }}>
              <span style={{ width: 8, height: 8, borderRadius: 99, background: "#1F8A4C" }} /> LIVE
            </span>
          )}
          <span style={{ fontSize: 12, color: "#6B6B68" }}>
            {a.sku} · <a href="/conditions" style={{ color: "inherit", textDecoration: "underline dotted" }}>{conditionLabel(a.condition, t)}</a> · {a.marketCode}
          </span>
        </div>
        <h1 style={{ margin: "6px 0 0", fontSize: 26, fontWeight: 700, letterSpacing: "-0.02em" }}>{a.title}</h1>
        {a.conditionNotes && (
          <div style={{ marginTop: 8, maxWidth: 720, background: "#FCEFD9", border: "1px solid #EAD3A8", borderRadius: 10, padding: "9px 12px", fontSize: 13, color: "#6B4A00" }}>
            <strong>{t("cond.notes")}:</strong> {a.conditionNotes}
          </div>
        )}
        {a.description && <p style={{ color: "#454542", fontSize: 14, lineHeight: 1.6, maxWidth: 720 }}>{a.description}</p>}
      </div>

      {a.photos.length > 0 && <PhotoGallery photos={a.photos} alt={a.title} />}

      <div style={{ display: "flex", gap: 18, flexWrap: "wrap", alignItems: "flex-start" }}>
        {/* Price + bid box */}
        <div style={{ flex: "1 1 340px", maxWidth: 460, background: "#fff", border: "1px solid rgba(10,10,10,0.10)", borderRadius: 16, padding: 22 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end" }}>
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, color: "#6B6B68", textTransform: "uppercase", letterSpacing: "0.06em" }}>
                {a.currentPriceCents !== null ? t("card.currentBid") : t("card.startPrice")}
              </div>
              <div style={{ fontSize: 34, fontWeight: 700, letterSpacing: "-0.02em" }} suppressHydrationWarning>
                {formatEur(a.currentPriceCents ?? a.startPriceCents ?? 0)}
              </div>
              <div style={{ fontSize: 12.5, color: "#6B6B68" }}>
                {a.bidCount} {t("card.bids")}{a.leaderAlias ? ` · ${t("a.leader")}: ${a.leaderAlias}` : ""}
              </div>
            </div>
            {live && (
              <div style={{ textAlign: "right" }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: "#6B6B68", textTransform: "uppercase", letterSpacing: "0.06em" }}>{t("card.endsIn")}</div>
                <div style={{ fontSize: 22 }}><Countdown endsAt={a.endsAt} /></div>
              </div>
            )}
          </div>

          {a.hasReserve && (
            <div style={{
              marginTop: 12, fontSize: 12, fontWeight: 700, borderRadius: 8, padding: "7px 10px",
              background: a.reserveMet ? "#E4F4EA" : "#FCEFD9", color: a.reserveMet ? "#1F8A4C" : "#9A5B00",
            }}>
              {a.reserveMet ? t("a.reserveMet") : t("a.reserveNotMet")}
            </div>
          )}

          {/* Pay Later monthly-payment calculator on the full cost of the
              current price (premium + VAT included). Renders only when Klix
              is enabled; the numbers come from Klix's financing API. */}
          <div style={{ marginTop: 12 }}>
            <KlixPayLater amountCents={detail.estimatedTotalCents} view="product" />
          </div>

          {live && (
            <div style={{ marginTop: 16, borderTop: "1px solid rgba(10,10,10,0.08)", paddingTop: 16 }}>
              {signedIn ? (
                <>
                  {iLead && (
                    <div style={{ marginBottom: 10, fontSize: 12.5, fontWeight: 700, color: "#1F8A4C" }}>{t("a.youLead")}</div>
                  )}
                  <label style={{ display: "block", fontSize: 12, fontWeight: 700, marginBottom: 6 }}>
                    {t("a.yourMax")} · {t("a.minBid")} {formatEur(detail.minNextBidCents)}
                  </label>
                  <div style={{ display: "flex", gap: 8 }}>
                    <input
                      value={amount}
                      onChange={(e) => setAmount(e.target.value)}
                      placeholder={(detail.minNextBidCents / 100).toFixed(2)}
                      inputMode="decimal"
                      style={{
                        flex: 1, height: 44, borderRadius: 10, border: "1px solid rgba(10,10,10,0.15)",
                        fontSize: 16, padding: "0 12px", outline: "none",
                      }}
                    />
                    <button
                      onClick={() => void placeBid()}
                      disabled={busy}
                      style={{
                        all: "unset", cursor: busy ? "wait" : "pointer", background: "#2D4BFF", color: "#fff",
                        fontWeight: 700, fontSize: 14.5, borderRadius: 10, padding: "0 22px",
                        display: "inline-flex", alignItems: "center", opacity: busy ? 0.6 : 1,
                      }}
                    >{t("a.placeBid")}</button>
                  </div>
                  <p style={{ fontSize: 11.5, color: "#6B6B68", lineHeight: 1.5, marginBottom: 0 }}>{t("a.proxyNote")}</p>
                </>
              ) : (
                <a href="/login" style={{
                  display: "block", textAlign: "center", background: "#0A0A0A", color: "#fff", fontWeight: 700,
                  fontSize: 14, borderRadius: 10, padding: "12px 0", textDecoration: "none",
                }}>{t("a.signinToBid")}</a>
              )}
              {notice && (
                <div style={{
                  marginTop: 10, fontSize: 12.5, fontWeight: 700, borderRadius: 8, padding: "8px 10px",
                  background: noticeColors[notice.tone][0], color: noticeColors[notice.tone][1],
                }}>{notice.text}</div>
              )}
            </div>
          )}
        </div>

        {/* Ledger */}
        <div style={{ flex: "1 1 300px", background: "#fff", border: "1px solid rgba(10,10,10,0.10)", borderRadius: 16, overflow: "hidden" }}>
          <div style={{ padding: "12px 16px", borderBottom: "1px solid rgba(10,10,10,0.06)", fontWeight: 700, fontSize: 13.5 }}>
            {t("a.bidHistory")} ({detail.bids.length})
          </div>
          {detail.bids.length === 0 ? (
            <div style={{ padding: 24, color: "#6B6B68", fontSize: 13, textAlign: "center" }}>—</div>
          ) : (
            <div>
              {detail.bids.map((b) => (
                <div key={b.seq} style={{
                  display: "flex", alignItems: "center", gap: 10, padding: "9px 16px",
                  borderBottom: "1px solid rgba(10,10,10,0.05)", fontSize: 13,
                  opacity: b.outbid ? 0.62 : 1,
                }}>
                  <span style={{ fontWeight: 600 }}>
                    {b.alias}
                    {b.isYou && <span style={{ color: "#2D4BFF", fontWeight: 700 }}> · {t("a.you")}</span>}
                  </span>
                  {b.auto && (
                    <span style={{ fontSize: 10, fontWeight: 700, background: "#EAEEFF", color: "#2D4BFF", borderRadius: 99, padding: "1px 7px" }}>
                      {t("a.proxy")}
                    </span>
                  )}
                  <span style={{ marginLeft: "auto", fontFamily: '"Geist Mono", ui-monospace, monospace', fontWeight: b.outbid ? 400 : 700 }}>
                    {formatEur(b.amountCents)}
                  </span>
                  <span suppressHydrationWarning style={{ fontSize: 11, color: "#6B6B68", width: 74, textAlign: "right" }}>
                    {new Date(b.createdAt).toLocaleTimeString(lang === "en" ? "en-GB" : "lv-LV", { hour: "2-digit", minute: "2-digit" })}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
