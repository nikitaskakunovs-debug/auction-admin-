import { useEffect, useMemo, useState } from "react";
import { api, type Auction, type Listing, ApiError } from "../api.js";
import type { Nav } from "../App.js";
import { useAuth } from "../auth.js";
import { formatDate, formatEur } from "../format.js";
import { AT, AUCTION_STATUS_TONE } from "../theme.js";
import {
  ABadge, ABtn, ACard, ADrawer, AEmpty, AField, AIcon, AInput, APills, ASelect,
  ATable, ATd, ATr, formatCountdown, useNowTick, useToast,
} from "../ui.js";
import { useAuctionEvents } from "../useAuctionEvents.js";

const FILTERS = [
  { id: "all", label: "All", statuses: null as string[] | null },
  { id: "live", label: "Live", statuses: ["live"] },
  { id: "scheduled", label: "Scheduled", statuses: ["scheduled"] },
  { id: "won", label: "Won", statuses: ["ended_won"] },
  { id: "reserve", label: "Reserve not met", statuses: ["ended_reserve_not_met"] },
  { id: "nobids", label: "No bids", statuses: ["ended_no_bids"] },
  { id: "cancelled", label: "Cancelled", statuses: ["cancelled"] },
];

function toLocalInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function AuctionsScreen({ nav }: { nav: Nav }) {
  const { can } = useAuth();
  const toast = useToast();
  const now = useNowTick();
  const [auctions, setAuctions] = useState<Auction[]>([]);
  const [filter, setFilter] = useState("all");
  const [scheduling, setScheduling] = useState(false);
  const [listings, setListings] = useState<Listing[]>([]);
  const [listingId, setListingId] = useState("");
  const [startsAt, setStartsAt] = useState(() => toLocalInput(new Date(Date.now() + 5 * 60_000)));
  const [endsAt, setEndsAt] = useState(() => toLocalInput(new Date(Date.now() + 7 * 86_400_000)));

  const load = () => {
    void api.get<{ auctions: Auction[] }>("/api/auctions").then((r) => setAuctions(r.auctions)).catch(() => undefined);
  };
  useEffect(load, []);
  useAuctionEvents("admin", () => load());

  const openScheduler = async () => {
    try {
      const r = await api.get<{ listings: Listing[] }>("/api/listings?status=published");
      const eligible = r.listings.filter((l) => l.type === "auction" && l.itemStatus === "listed");
      setListings(eligible);
      setListingId(eligible[0]?.id ?? "");
      setScheduling(true);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Failed to load listings", "danger");
    }
  };

  const schedule = async () => {
    try {
      await api.post("/api/auctions", {
        listingId,
        startsAt: new Date(startsAt).toISOString(),
        endsAt: new Date(endsAt).toISOString(),
      });
      toast("Auction scheduled", "ok");
      setScheduling(false);
      load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Failed to schedule", "danger");
    }
  };

  const counts = useMemo(() => {
    const map: Record<string, number> = { all: auctions.length };
    for (const f of FILTERS) {
      if (f.statuses) map[f.id] = auctions.filter((a) => f.statuses!.includes(a.status)).length;
    }
    return map;
  }, [auctions]);

  const active = FILTERS.find((f) => f.id === filter) ?? FILTERS[0]!;
  const visible = active.statuses ? auctions.filter((a) => active.statuses!.includes(a.status)) : auctions;

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <h1 style={{ fontFamily: AT.body, fontSize: 20, fontWeight: 700, color: AT.ink }}>Auctions</h1>
        {can("listings.publish") && (
          <ABtn onClick={() => void openScheduler()}>
            <AIcon name="plus" size={15} color="#fff" /> Schedule auction
          </ABtn>
        )}
      </div>

      <APills
        options={FILTERS.map((f) => ({ id: f.id, label: f.label, count: counts[f.id] ?? 0 }))}
        value={filter}
        onChange={setFilter}
      />

      <ACard pad={false}>
        {visible.length === 0 ? (
          <AEmpty text="No auctions match this filter." />
        ) : (
          <ATable head={["Lot", "Type", "Current", "Bids", "Reserve", "Ends", "Leader", "Status"]}>
            {visible.map((a) => {
              const msLeft = new Date(a.endsAt).getTime() - now;
              return (
                <ATr key={a.id} onClick={() => nav.go("auctions", a.id)}>
                  <ATd>
                    <div style={{ fontWeight: 600, maxWidth: 320, overflow: "hidden", textOverflow: "ellipsis" }}>{a.listingTitle}</div>
                    <div style={{ fontFamily: AT.mono, fontSize: 11, color: AT.inkSoft }}>{a.itemSku}</div>
                  </ATd>
                  <ATd><ABadge tone={a.listingType === "auction" ? "accent" : "neutral"}>{a.listingType}</ABadge></ATd>
                  <ATd mono right>{a.currentPriceCents === null ? "—" : formatEur(a.currentPriceCents)}</ATd>
                  <ATd right>{a.bidCount}</ATd>
                  <ATd>
                    {a.reserveCents == null ? (
                      <span style={{ color: AT.inkSoft, fontSize: 12 }}>none</span>
                    ) : a.reserveMet ? (
                      <ABadge tone="ok">met</ABadge>
                    ) : (
                      <ABadge tone="warn">not met</ABadge>
                    )}
                  </ATd>
                  <ATd>
                    <div style={{ fontSize: 12.5 }}>{formatDate(a.endsAt)}</div>
                    {a.status === "live" && (
                      <div style={{ fontFamily: AT.mono, fontSize: 11, color: msLeft < 120_000 ? AT.danger : AT.inkSoft }}>
                        {formatCountdown(msLeft)}
                      </div>
                    )}
                  </ATd>
                  <ATd>{a.leaderAlias ?? <span style={{ color: AT.inkSoft }}>—</span>}</ATd>
                  <ATd>
                    <ABadge tone={AUCTION_STATUS_TONE[a.status]?.tone ?? "neutral"}>
                      {AUCTION_STATUS_TONE[a.status]?.label ?? a.status}
                    </ABadge>
                  </ATd>
                </ATr>
              );
            })}
          </ATable>
        )}
      </ACard>

      {scheduling && (
        <ADrawer
          title="Schedule auction"
          onClose={() => setScheduling(false)}
          footer={
            <>
              <ABtn kind="ghost" onClick={() => setScheduling(false)}>Cancel</ABtn>
              <ABtn onClick={() => void schedule()} disabled={!listingId}>Schedule</ABtn>
            </>
          }
        >
          <div style={{ display: "grid", gap: 14 }}>
            {listings.length === 0 ? (
              <div style={{ fontFamily: AT.body, fontSize: 13, color: AT.inkSoft, lineHeight: 1.6 }}>
                No eligible listings. A listing must be <strong>published</strong>, of type <strong>auction</strong>, and its
                item in the <strong>listed</strong> state (no open auction). Publish one under Listings first.
              </div>
            ) : (
              <>
                <AField label="Listing">
                  <ASelect
                    value={listingId}
                    onChange={setListingId}
                    options={listings.map((l) => ({ value: l.id, label: `${l.title} (${l.itemSku})` }))}
                  />
                </AField>
                <AField label="Starts at">
                  <AInput type="datetime-local" value={startsAt} onChange={setStartsAt} />
                </AField>
                <AField label="Ends at" hint="Anti-snipe extensions can push the close later.">
                  <AInput type="datetime-local" value={endsAt} onChange={setEndsAt} />
                </AField>
              </>
            )}
          </div>
        </ADrawer>
      )}
    </div>
  );
}
