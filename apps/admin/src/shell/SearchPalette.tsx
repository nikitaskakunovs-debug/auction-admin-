import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api.js";
import { AT, toneColors } from "../theme.js";

/**
 * ⌘K command palette — one debounced query against /api/search, grouped
 * results (lots / auctions / orders / bidders) that the API already
 * role-gated, full keyboard navigation, Enter/click opens the record in a
 * NEW tab so whatever you were doing stays put.
 */

interface LotHit { id: string; sku: string; title: string; status: string }
interface AuctionHit { id: string; sku: string; title: string; status: string; currentPriceCents: number | null }
interface OrderHit { id: string; ref: string; customerAlias: string; status: string; totalCents: number }
interface BidderHit { id: string; alias: string; email: string; blocked: boolean; strikes: number }
interface Group { kind: string; results: unknown[] }

export interface SearchTarget {
  screen: string;
  param: string | null;
}

interface Row {
  key: string;
  group: string;
  title: string;
  meta: string;
  mono: string;
  target: SearchTarget;
}

const eur = (c: number | null | undefined) => (c == null ? "" : `€${(c / 100).toFixed(2)}`);

function flatten(groups: Group[]): Row[] {
  const rows: Row[] = [];
  for (const g of groups) {
    if (g.kind === "lots") {
      for (const r of g.results as LotHit[]) {
        rows.push({ key: `lot-${r.id}`, group: "Lots", mono: r.sku, title: r.title, meta: r.status.replace(/_/g, " "), target: { screen: "inventory", param: r.id } });
      }
    } else if (g.kind === "auctions") {
      for (const r of g.results as AuctionHit[]) {
        rows.push({ key: `auc-${r.id}`, group: "Auctions", mono: r.sku, title: r.title, meta: `${r.status.replace(/_/g, " ")}${r.currentPriceCents != null ? ` · ${eur(r.currentPriceCents)}` : ""}`, target: { screen: "auctions", param: r.id } });
      }
    } else if (g.kind === "orders") {
      for (const r of g.results as OrderHit[]) {
        rows.push({ key: `ord-${r.id}`, group: "Orders", mono: r.ref, title: r.customerAlias, meta: `${r.status.replace(/_/g, " ")} · ${eur(r.totalCents)}`, target: { screen: "orders", param: r.id } });
      }
    } else if (g.kind === "bidders") {
      for (const r of g.results as BidderHit[]) {
        rows.push({ key: `cus-${r.id}`, group: "Bidders", mono: r.alias, title: r.email, meta: r.blocked ? "blocked" : r.strikes > 0 ? `${r.strikes} strikes` : "", target: { screen: "customers", param: r.id } });
      }
    }
  }
  return rows;
}

/** Screens the palette can jump to directly (filtered by nav permissions upstream). */
const GO_TO: Array<{ label: string; screen: string }> = [
  { label: "Dashboard", screen: "dashboard" }, { label: "Auctions", screen: "auctions" },
  { label: "Listings", screen: "listings" }, { label: "Inventory", screen: "inventory" },
  { label: "Receiving", screen: "receiving" }, { label: "Orders", screen: "orders" },
  { label: "Pickup", screen: "pickup" }, { label: "Bidders", screen: "customers" },
  { label: "Finance", screen: "finance" }, { label: "Content", screen: "content" },
  { label: "Settings", screen: "settings" }, { label: "Activity", screen: "activity" },
];

export function SearchPalette({ allowedScreens, onOpen, onClose }: {
  allowedScreens: Set<string>;
  onOpen: (target: SearchTarget) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const [groups, setGroups] = useState<Group[]>([]);
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const seq = useRef(0);

  useEffect(() => inputRef.current?.focus(), []);

  useEffect(() => {
    const trimmed = q.trim();
    if (trimmed.length < 2) {
      setGroups([]);
      return;
    }
    const mine = ++seq.current;
    const t = setTimeout(() => {
      void api.get<{ groups: Group[] }>(`/api/search?q=${encodeURIComponent(trimmed)}`).then((r) => {
        if (seq.current === mine) {
          setGroups(r.groups);
          setCursor(0);
        }
      }).catch(() => undefined);
    }, 180);
    return () => clearTimeout(t);
  }, [q]);

  const rows = useMemo(() => {
    const hits = flatten(groups);
    const nav = GO_TO
      .filter((g) => allowedScreens.has(g.screen))
      .filter((g) => !q.trim() || g.label.toLowerCase().includes(q.trim().toLowerCase()))
      .map((g): Row => ({ key: `go-${g.screen}`, group: "Go to", mono: "→", title: g.label, meta: "screen", target: { screen: g.screen, param: null } }));
    return [...hits, ...nav];
  }, [groups, q, allowedScreens]);

  const pick = (row: Row | undefined) => {
    if (!row) return;
    onOpen(row.target);
    onClose();
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") onClose();
    else if (e.key === "ArrowDown") { e.preventDefault(); setCursor((c) => Math.min(c + 1, rows.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setCursor((c) => Math.max(c - 1, 0)); }
    else if (e.key === "Enter") { e.preventDefault(); pick(rows[cursor]); }
  };

  let lastGroup = "";

  return (
    <div onMouseDown={onClose} style={{ position: "fixed", inset: 0, zIndex: 60, background: "rgba(10,10,10,0.45)", display: "grid", placeItems: "start center", paddingTop: "12vh" }}>
      <div onMouseDown={(e) => e.stopPropagation()} onKeyDown={onKey} style={{
        width: "min(580px, 92vw)", background: "#fff", borderRadius: 14, overflow: "hidden",
        boxShadow: "0 24px 70px rgba(10,10,10,0.30)", border: `1px solid ${AT.ruleSoft}`, fontFamily: AT.body,
      }}>
        <div style={{ display: "flex", gap: 10, alignItems: "center", padding: "13px 16px", borderBottom: `1px solid ${AT.ruleSoft}` }}>
          <span style={{ color: AT.inkSoft, fontSize: 14 }}>🔍</span>
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search lots, orders, bidders…"
            style={{ flex: 1, border: "none", outline: "none", fontSize: 15, fontFamily: AT.body, color: AT.ink, background: "transparent" }}
          />
          <span style={{ fontFamily: AT.mono, fontSize: 10, background: AT.app, border: `1px solid ${AT.rule}`, borderRadius: 5, padding: "1px 6px", color: AT.inkSoft }}>esc</span>
        </div>
        <div style={{ maxHeight: "52vh", overflowY: "auto", paddingBottom: 6 }}>
          {rows.length === 0 && (
            <div style={{ padding: "18px 16px", fontSize: 13, color: AT.inkSoft }}>
              {q.trim().length < 2 ? "Type at least 2 characters — diacritics optional (skruvgriezis finds skrūvgriezis)." : "Nothing matches."}
            </div>
          )}
          {rows.map((row, i) => {
            const header = row.group !== lastGroup ? row.group : null;
            lastGroup = row.group;
            const on = i === cursor;
            return (
              <div key={row.key}>
                {header && (
                  <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: "0.08em", textTransform: "uppercase", color: AT.inkSoft, padding: "10px 16px 4px" }}>{header}</div>
                )}
                <div
                  onMouseEnter={() => setCursor(i)}
                  onClick={() => pick(row)}
                  style={{
                    display: "flex", gap: 10, alignItems: "baseline", padding: "8px 16px", cursor: "pointer",
                    background: on ? toneColors.accent.bg : "transparent", fontSize: 13, color: AT.ink,
                  }}
                >
                  <b style={{ fontFamily: AT.mono, fontSize: 12.5, flexShrink: 0 }}>{row.mono}</b>
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{row.title}</span>
                  <span style={{ marginLeft: "auto", fontSize: 11, color: AT.inkSoft, flexShrink: 0 }}>{row.meta}</span>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
