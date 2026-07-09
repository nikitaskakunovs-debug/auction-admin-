import { useEffect, useRef } from "react";
import { api } from "./api.js";

export interface AuctionEvent {
  type: "bid" | "extended" | "opened" | "closed" | "cancelled" | "bid_voided" | "subscribed";
  auctionId?: string;
  at?: string;
  data?: Record<string, unknown>;
}

/**
 * Live auction events over WebSocket. Subscribe to one auction or, with
 * auctionId === "admin", to the all-auctions firehose. Auto-reconnects.
 */
export function useAuctionEvents(auctionId: string | null, onEvent: (ev: AuctionEvent) => void): void {
  const handler = useRef(onEvent);
  handler.current = onEvent;

  useEffect(() => {
    if (!auctionId || !api.accessToken) return;
    let ws: WebSocket | null = null;
    let closed = false;
    let retry = 0;

    const connect = () => {
      if (closed) return;
      const proto = location.protocol === "https:" ? "wss" : "ws";
      ws = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(api.accessToken!)}`);
      ws.onopen = () => {
        retry = 0;
        ws?.send(JSON.stringify(auctionId === "admin" ? { type: "subscribe_admin" } : { type: "subscribe", auctionId }));
      };
      ws.onmessage = (e) => {
        try {
          handler.current(JSON.parse(String(e.data)) as AuctionEvent);
        } catch {
          // ignore malformed frames
        }
      };
      ws.onclose = () => {
        if (!closed) setTimeout(connect, Math.min(1000 * 2 ** retry++, 10_000));
      };
    };
    connect();

    return () => {
      closed = true;
      ws?.close();
    };
  }, [auctionId]);
}
