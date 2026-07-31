import { useCallback, useEffect, useState } from "react";
import { api, ApiError, type Auction, type BidRow, type Item, type Listing } from "../api.js";
import type { Nav } from "../App.js";
import { useAuth } from "../auth.js";
import { formatDate, formatEur } from "../format.js";
import { auctionStatusLabel, useT } from "../i18n.js";
import { AT, AUCTION_STATUS_TONE } from "../theme.js";
import {
  AAvatar, ABadge, ABtn, ACard, AEmpty, AIcon, ASelect, ATable, ATd, ATr,
  formatCountdown, useConfirm, useNowTick, useToast,
} from "../ui.js";
import { useAuctionEvents } from "../useAuctionEvents.js";

interface Detail {
  auction: Auction;
  listing: Listing;
  item: Item;
  bids: BidRow[];
}

const RELISTABLE = ["ended_reserve_not_met", "ended_no_bids", "cancelled"];

export function AuctionMonitorScreen({ nav, auctionId }: { nav: Nav; auctionId: string }) {
  const { can } = useAuth();
  const { t } = useT();
  const toast = useToast();
  const confirm = useConfirm();
  const now = useNowTick();
  const [detail, setDetail] = useState<Detail | null>(null);
  const [extendMinutes, setExtendMinutes] = useState("15");

  const load = useCallback(() => {
    void api.get<Detail>(`/api/auctions/${auctionId}`).then(setDetail).catch(() => setDetail(null));
  }, [auctionId]);
  useEffect(load, [load]);

  useAuctionEvents(auctionId, (ev) => {
    if (ev.type === "bid" && ev.data && detail) {
      const d = ev.data as { currentPriceCents?: number; leaderAlias?: string; bidCount?: number; endsAt?: string; reserveMet?: boolean };
      setDetail((prev) =>
        prev
          ? {
              ...prev,
              auction: {
                ...prev.auction,
                currentPriceCents: d.currentPriceCents ?? prev.auction.currentPriceCents,
                leaderAlias: d.leaderAlias ?? prev.auction.leaderAlias,
                bidCount: d.bidCount ?? prev.auction.bidCount,
                endsAt: d.endsAt ?? prev.auction.endsAt,
                reserveMet: d.reserveMet ?? prev.auction.reserveMet,
              },
            }
          : prev,
      );
    }
    load(); // pull the fresh ledger / status
  });

  if (!detail) return <AEmpty text={t("auc.notFound")} />;
  const { auction, listing, item, bids } = detail;
  const msLeft = new Date(auction.endsAt).getTime() - now;
  const isLive = auction.status === "live";
  const statusMeta = AUCTION_STATUS_TONE[auction.status] ?? { label: auction.status, tone: "neutral" as const };

  const doExtend = async () => {
    const r = await confirm({
      title: `${t("auc.extendTitle1")} ${extendMinutes} ${t("auc.extendTitle2")}`,
      body: t("auc.extendBody"),
      requireReason: true,
      confirmLabel: t("auc.extend"),
    });
    if (!r.ok) return;
    try {
      await api.post(`/api/auctions/${auctionId}/extend`, { minutes: Number(extendMinutes), reason: r.reason });
      toast(t("auc.extended"), "ok");
      load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : t("auc.extendFailed"), "danger");
    }
  };

  const doCancel = async () => {
    const r = await confirm({
      title: t("auc.cancelTitle"),
      body: `${auction.bidCount} ${t("auc.cancelBody")}`,
      danger: true,
      typeToConfirm: item.sku,
      requireReason: true,
      confirmLabel: t("auc.cancelAuction"),
    });
    if (!r.ok) return;
    try {
      await api.post(`/api/auctions/${auctionId}/cancel`, { reason: r.reason });
      toast(t("auc.cancelledToast"), "ok");
      nav.go("auctions");
    } catch (err) {
      toast(err instanceof ApiError ? err.message : t("auc.cancelFailed"), "danger");
    }
  };

  const doRelist = async () => {
    const r = await confirm({
      title: t("auc.relistTitle"),
      body: t("auc.relistBody"),
      confirmLabel: t("auc.relist"),
    });
    if (!r.ok) return;
    try {
      const res = await api.post<{ auction: { id: string } }>(`/api/auctions/${auctionId}/relist`, {
        startsAt: new Date(Date.now() + 3_600_000).toISOString(),
        endsAt: new Date(Date.now() + 73 * 3_600_000).toISOString(),
      });
      toast(t("auc.relisted"), "ok");
      nav.go("auctions", res.auction.id);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : t("auc.relistFailed"), "danger");
    }
  };

  const doVoid = async (b: BidRow) => {
    const r = await confirm({
      title: `${t("auc.voidTitlePre")} ${b.alias}${t("auc.voidTitleSuf")}`,
      body: t("auc.voidBody"),
      danger: true,
      requireReason: true,
      confirmLabel: t("auc.voidConfirm"),
    });
    if (!r.ok) return;
    try {
      await api.post(`/api/auctions/${auctionId}/bids/${b.id}/void`, { reason: r.reason });
      toast(t("auc.voidedToast"), "ok");
      load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : t("auc.voidFailed"), "danger");
    }
  };

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <ABtn kind="ghost" size="sm" onClick={() => nav.go("auctions")}>← {t("auc.title")}</ABtn>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h1 style={{ fontFamily: AT.body, fontSize: 19, fontWeight: 700, color: AT.ink, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {listing.title}
          </h1>
          <div style={{ fontFamily: AT.mono, fontSize: 11.5, color: AT.inkSoft }}>{item.sku} · {listing.marketCode}</div>
        </div>
        {isLive && (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontFamily: AT.body, fontSize: 12, fontWeight: 700, color: AT.ok }}>
            <span style={{ width: 8, height: 8, borderRadius: 999, background: AT.ok, animation: "pulse 1.6s infinite" }} />
            LIVE
          </span>
        )}
        <ABadge tone={statusMeta.tone}>{auctionStatusLabel(auction.status)}</ABadge>
      </div>

      <div style={{ display: "flex", gap: 14, alignItems: "flex-start", flexWrap: "wrap" }}>
        {/* Left: price + ledger */}
        <div style={{ flex: 2, minWidth: 420, display: "grid", gap: 14 }}>
          <ACard>
            <div style={{ display: "flex", gap: 26, alignItems: "flex-end", flexWrap: "wrap" }}>
              <div>
                <div style={{ fontFamily: AT.body, fontSize: 11.5, fontWeight: 700, color: AT.inkSoft, textTransform: "uppercase", letterSpacing: "0.06em" }}>{t("auc.currentPrice")}</div>
                <div style={{ fontFamily: AT.body, fontSize: 34, fontWeight: 700, color: AT.ink, letterSpacing: "-0.02em" }}>
                  {auction.currentPriceCents === null ? t("auc.noBidsBig") : formatEur(auction.currentPriceCents)}
                </div>
              </div>
              <div>
                <div style={{ fontFamily: AT.body, fontSize: 11.5, fontWeight: 700, color: AT.inkSoft, textTransform: "uppercase", letterSpacing: "0.06em" }}>
                  {isLive ? t("auc.endsIn") : t("auc.ended")}
                </div>
                <div style={{ fontFamily: AT.mono, fontSize: 22, fontWeight: 700, color: isLive && msLeft < 120_000 ? AT.danger : AT.ink }}>
                  {isLive ? (msLeft <= 0 ? t("auc.endedLower") : formatCountdown(msLeft)) : formatDate(auction.closedAt ?? auction.endsAt)}
                </div>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                {auction.leaderAlias ? (
                  <>
                    <AAvatar name={auction.leaderAlias} size={30} />
                    <div>
                      <div style={{ fontFamily: AT.body, fontSize: 13, fontWeight: 700 }}>{auction.leaderAlias}</div>
                      <div style={{ fontFamily: AT.body, fontSize: 11, color: AT.inkSoft }}>{t("auc.leading")}</div>
                    </div>
                  </>
                ) : null}
              </div>
              <div style={{ marginLeft: "auto", textAlign: "right" }}>
                <div style={{ fontFamily: AT.body, fontSize: 12.5, color: AT.inkSoft }}>{auction.bidCount} {t("auc.bidsWord")} · {auction.extensions} {t("auc.extensionsWord")}</div>
                {listing.reserveCents != null && (
                  <div style={{ marginTop: 6, display: "flex", gap: 7, alignItems: "center", justifyContent: "flex-end" }}>
                    <span style={{ fontFamily: AT.body, fontSize: 12, color: AT.inkSoft }}>
                      {t("auc.reserveWord")} {formatEur(listing.reserveCents)} <span style={{ fontSize: 10.5 }}>{t("auc.hiddenFromBidders")}</span>
                    </span>
                    {auction.reserveMet ? <ABadge tone="ok">{t("auc.reserveMet")}</ABadge> : <ABadge tone="warn">{t("auc.reserveNotMet")}</ABadge>}
                  </div>
                )}
              </div>
            </div>
          </ACard>

          <ACard title={`Bid ledger (${bids.length})`} pad={false}>
            {bids.length === 0 ? (
              <AEmpty text="No bids yet." />
            ) : (
              <ATable head={["Time", "Bidder", "Amount", "", ""]}>
                {bids.map((b) => (
                  <ATr key={b.id}>
                    <ATd mono>{formatDate(b.createdAt)}</ATd>
                    <ATd>
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                        <AAvatar name={b.alias} size={22} />
                        <span style={{ textDecoration: b.voidedAt ? "line-through" : undefined }}>{b.alias}</span>
                      </span>
                    </ATd>
                    <ATd mono right>
                      <span style={{ textDecoration: b.voidedAt ? "line-through" : undefined, fontWeight: b.outbid || b.voidedAt ? 400 : 700 }}>
                        {formatEur(b.amountCents)}
                      </span>
                    </ATd>
                    <ATd>
                      <span style={{ display: "inline-flex", gap: 5 }}>
                        {b.auto && <ABadge tone="accent">proxy</ABadge>}
                        {b.outbid && !b.voidedAt && <ABadge tone="neutral">outbid</ABadge>}
                        {b.voidedAt && <span title={b.voidReason ?? ""}><ABadge tone="danger">voided</ABadge></span>}
                      </span>
                    </ATd>
                    <ATd right>
                      {!b.voidedAt && isLive && can("auctions.void_bid") && (
                        <ABtn kind="ghost" size="sm" onClick={() => void doVoid(b)}>Void</ABtn>
                      )}
                    </ATd>
                  </ATr>
                ))}
              </ATable>
            )}
          </ACard>
        </div>

        {/* Right: actions + facts */}
        <div style={{ flex: 1, minWidth: 260, display: "grid", gap: 14 }}>
          <ACard title="Actions">
            <div style={{ display: "grid", gap: 10 }}>
              {isLive && can("auctions.extend") && (
                <div style={{ display: "flex", gap: 8 }}>
                  <ASelect
                    value={extendMinutes}
                    onChange={setExtendMinutes}
                    options={["5", "15", "30", "60"].map((m) => ({ value: m, label: `${m} min` }))}
                  />
                  <ABtn kind="ghost" onClick={() => void doExtend()} full><AIcon name="clock" size={14} /> Extend</ABtn>
                </div>
              )}
              {(isLive || auction.status === "scheduled") && can("auctions.cancel") && (
                <ABtn kind="danger" full onClick={() => void doCancel()}>Cancel auction</ABtn>
              )}
              {RELISTABLE.includes(auction.status) && can("auctions.relist") && (
                <ABtn kind="dark" full onClick={() => void doRelist()}>Relist lot</ABtn>
              )}
              {!isLive && auction.status !== "scheduled" && !RELISTABLE.includes(auction.status) && (
                <div style={{ fontFamily: AT.body, fontSize: 12.5, color: AT.inkSoft }}>No actions available for this state.</div>
              )}
            </div>
          </ACard>
          <ACard title="Listing">
            <div style={{ display: "grid", gap: 9, fontFamily: AT.body, fontSize: 13 }}>
              <Row k="Start price" v={listing.startPriceCents != null ? formatEur(listing.startPriceCents) : "—"} />
              <Row k="Anti-snipe" v={`${listing.antiSnipeSec ?? "market default"}${listing.antiSnipeSec != null ? "s" : ""}`} />
              <Row k="Market" v={listing.marketCode} />
              <Row k="Started" v={formatDate(auction.startsAt)} />
              <Row k="Condition" v={item.condition} />
              <Row k="Location" v={item.location || "—"} />
            </div>
          </ACard>
        </div>
      </div>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
      <span style={{ color: AT.inkSoft }}>{k}</span>
      <span style={{ fontWeight: 600, textAlign: "right" }}>{v}</span>
    </div>
  );
}
