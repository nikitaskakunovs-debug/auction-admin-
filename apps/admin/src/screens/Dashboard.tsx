import { useEffect, useState } from "react";
import { api, type Auction, type DashboardStats } from "../api.js";
import type { Nav } from "../App.js";
import { formatEur } from "../format.js";
import { AT, AUCTION_STATUS_TONE } from "../theme.js";
import { ABadge, ACard, AEmpty, AStat, ATable, ATd, ATr, formatCountdown, useNowTick } from "../ui.js";
import { useAuctionEvents } from "../useAuctionEvents.js";

export function DashboardScreen({ nav }: { nav: Nav }) {
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
      <h1 style={{ fontFamily: AT.body, fontSize: 20, fontWeight: 700, color: AT.ink }}>Dashboard</h1>

      {stats && (
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <AStat label="Live auctions" value={stats.liveAuctions} tone="ok" onClick={() => nav.go("auctions")} />
          <AStat label="Ending soon" value={stats.endingSoon} sub="next 2 hours" tone={stats.endingSoon > 0 ? "warn" : undefined} onClick={() => nav.go("auctions")} />
          <AStat label="Scheduled" value={stats.scheduledAuctions} onClick={() => nav.go("auctions")} />
          <AStat
            label="Awaiting payment"
            value={stats.unpaidOrders.count}
            sub={formatEur(stats.unpaidOrders.totalCents)}
            tone={stats.unpaidOrders.count > 0 ? "warn" : undefined}
            onClick={() => nav.go("orders")}
          />
          <AStat label="GMV · 30 days" value={formatEur(stats.gmv30d.totalCents)} sub={`${stats.gmv30d.count} paid orders`} />
          <AStat label="Bids · 24h" value={stats.bids24h} />
        </div>
      )}

      {canSeeAuctions && (
        <ACard title="Live now" pad={false}>
          {live.length === 0 ? (
            <AEmpty text="No live auctions." />
          ) : (
            <ATable head={["Lot", "Current", "Bids", "Reserve", "Ends in", "Status"]}>
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
                      <span style={{ color: AT.inkSoft }}>none</span>
                    ) : a.reserveMet ? (
                      <ABadge tone="ok">met</ABadge>
                    ) : (
                      <ABadge tone="warn">not met</ABadge>
                    )}
                  </ATd>
                  <ATd mono>{formatCountdown(new Date(a.endsAt).getTime() - now)}</ATd>
                  <ATd>
                    <ABadge tone={AUCTION_STATUS_TONE[a.status]?.tone ?? "neutral"}>
                      {AUCTION_STATUS_TONE[a.status]?.label ?? a.status}
                    </ABadge>
                  </ATd>
                </ATr>
              ))}
            </ATable>
          )}
        </ACard>
      )}

      {stats && (
        <ACard title="Warehouse pipeline" pad={false}>
          <ATable head={["State", "Items"]}>
            {Object.entries(stats.itemsByStatus).map(([status, n]) => (
              <ATr key={status} onClick={() => nav.go("inventory")}>
                <ATd>{status.replace(/_/g, " ")}</ATd>
                <ATd right>{n}</ATd>
              </ATr>
            ))}
          </ATable>
        </ACard>
      )}
    </div>
  );
}
