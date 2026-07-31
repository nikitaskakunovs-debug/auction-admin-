import { useEffect, useState } from "react";
import { api, type Auction, type DashboardStats } from "../api.js";
import type { Nav } from "../App.js";
import { formatEur } from "../format.js";
import { auctionStatusLabel, itemStatusLabel, useT } from "../i18n.js";
import { AT, AUCTION_STATUS_TONE } from "../theme.js";
import { ABadge, ACard, AEmpty, AStat, ATable, ATd, ATr, formatCountdown, useNowTick } from "../ui.js";
import { useAuctionEvents } from "../useAuctionEvents.js";

export function DashboardScreen({ nav }: { nav: Nav }) {
  const { t } = useT();
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [live, setLive] = useState<Auction[]>([]);
  const [canSeeAuctions, setCanSeeAuctions] = useState(true);
  const now = useNowTick();

  const load = () => {
    void api.get<DashboardStats>("/api/dashboard").then(setStats).catch(() => undefined);
    api
      .get<{ auctions: Auction[] }>("/api/auctions?status=live")
      .then((r) => setLive(r.auctions))
      .catch(() => setCanSeeAuctions(false));
  };
  useEffect(load, []);

  // Refresh on any live event from the admin firehose.
  useAuctionEvents(canSeeAuctions ? "admin" : null, () => load());

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <h1 style={{ fontFamily: AT.body, fontSize: 20, fontWeight: 700, color: AT.ink }}>{t("dash.title")}</h1>

      {stats && (
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <AStat label={t("dash.liveAuctions")} value={stats.liveAuctions} tone="ok" onClick={() => nav.go("auctions")} />
          <AStat label={t("dash.endingSoon")} value={stats.endingSoon} sub={t("dash.next2h")} tone={stats.endingSoon > 0 ? "warn" : undefined} onClick={() => nav.go("auctions")} />
          <AStat label={t("dash.scheduled")} value={stats.scheduledAuctions} onClick={() => nav.go("auctions")} />
          <AStat
            label={t("dash.awaitingPayment")}
            value={stats.unpaidOrders.count}
            sub={formatEur(stats.unpaidOrders.totalCents)}
            tone={stats.unpaidOrders.count > 0 ? "warn" : undefined}
            onClick={() => nav.go("orders")}
          />
          <AStat label={t("dash.gmv30d")} value={formatEur(stats.gmv30d.totalCents)} sub={`${stats.gmv30d.count} ${t("dash.paidOrders")}`} />
          <AStat label={t("dash.bids24h")} value={stats.bids24h} />
        </div>
      )}

      {canSeeAuctions && (
        <ACard title={t("dash.liveNow")} pad={false}>
          {live.length === 0 ? (
            <AEmpty text={t("dash.noLive")} />
          ) : (
            <ATable head={[t("dash.lot"), t("dash.current"), t("dash.bids"), t("dash.reserve"), t("dash.endsIn"), t("c.status")]}>
              {live.map((a) => (
                <ATr key={a.id} onClick={() => nav.go("auctions", a.id)}>
                  <ATd>
                    <div style={{ fontWeight: 600 }}>{a.listingTitle}</div>
                    <div style={{ fontFamily: AT.mono, fontSize: 11, color: AT.inkSoft }}>{a.itemSku}</div>
                  </ATd>
                  <ATd mono right>
                    {a.currentPriceCents === null ? "—" : formatEur(a.currentPriceCents)}
                  </ATd>
                  <ATd right>{a.bidCount}</ATd>
                  <ATd>
                    {a.reserveCents == null ? (
                      <span style={{ color: AT.inkSoft }}>{t("dash.reserveNone")}</span>
                    ) : a.reserveMet ? (
                      <ABadge tone="ok">{t("dash.reserveMet")}</ABadge>
                    ) : (
                      <ABadge tone="warn">{t("dash.reserveNotMet")}</ABadge>
                    )}
                  </ATd>
                  <ATd mono>
                    {new Date(a.endsAt).getTime() - now <= 0 ? t("dash.ended") : formatCountdown(new Date(a.endsAt).getTime() - now)}
                  </ATd>
                  <ATd>
                    <ABadge tone={AUCTION_STATUS_TONE[a.status]?.tone ?? "neutral"}>
                      {auctionStatusLabel(a.status)}
                    </ABadge>
                  </ATd>
                </ATr>
              ))}
            </ATable>
          )}
        </ACard>
      )}

      {stats && (
        <ACard title={t("dash.whPipeline")} pad={false}>
          <ATable head={[t("dash.state"), t("dash.items")]}>
            {Object.entries(stats.itemsByStatus).map(([status, n]) => (
              <ATr key={status} onClick={() => nav.go("inventory")}>
                <ATd>{itemStatusLabel(status)}</ATd>
                <ATd right>{n}</ATd>
              </ATr>
            ))}
          </ATable>
        </ACard>
      )}
    </div>
  );
}
