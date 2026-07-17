import { useState } from "react";
import { AT } from "../theme.js";

/**
 * Browser-style tab strip (ported from the Shhh admin's ATabBar): click to
 * select, × or middle-click to close (the last tab can't close), + opens a
 * dashboard tab, HTML5 drag-and-drop reorders, Split toggles the two-pane
 * layout. Tabs persist across reloads (see App.tsx).
 */

export interface Tab {
  id: string;
  screen: string;
  param: string | null;
}

/** Human tab title per screen — param-aware for record tabs. */
export function tabTitle(tab: Tab): string {
  const names: Record<string, string> = {
    dashboard: "Dashboard", auctions: "Auctions", listings: "Listings", inventory: "Inventory",
    receiving: "Receiving", orders: "Orders", pickup: "Pickup", customers: "Bidders",
    finance: "Finance", content: "Content", settings: "Settings", notifications: "Notifications",
    activity: "Activity", security: "Security",
  };
  const base = names[tab.screen] ?? tab.screen;
  return tab.param ? `${base} · ${tab.param.slice(0, 14)}` : base;
}

export function TabBar({ tabs, activeId, splitId, split, onSelect, onClose, onNew, onReorder, onToggleSplit }: {
  tabs: Tab[];
  activeId: string;
  splitId: string | null;
  split: boolean;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onNew: () => void;
  onReorder: (fromIdx: number, toIdx: number) => void;
  onToggleSplit: () => void;
}) {
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [overIdx, setOverIdx] = useState<number | null>(null);

  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 2, background: "#E9E9E6",
      padding: "6px 10px 0", borderBottom: `1px solid ${AT.rule}`, flexShrink: 0, overflowX: "auto",
    }}>
      {tabs.map((tab, i) => {
        const active = tab.id === activeId;
        const inSplit = split && tab.id === splitId;
        return (
          <div
            key={tab.id}
            draggable
            onDragStart={() => setDragIdx(i)}
            onDragOver={(e) => { e.preventDefault(); setOverIdx(i); }}
            onDrop={() => { if (dragIdx !== null && dragIdx !== i) onReorder(dragIdx, i); setDragIdx(null); setOverIdx(null); }}
            onDragEnd={() => { setDragIdx(null); setOverIdx(null); }}
            onClick={() => onSelect(tab.id)}
            onAuxClick={(e) => { if (e.button === 1 && tabs.length > 1) onClose(tab.id); }}
            style={{
              display: "flex", alignItems: "center", gap: 7, cursor: "pointer", userSelect: "none",
              fontFamily: AT.body, fontSize: 12.5, fontWeight: 700, whiteSpace: "nowrap",
              color: active ? AT.ink : AT.inkSoft,
              background: active ? AT.app : "transparent",
              boxShadow: active ? `inset 0 2px 0 ${AT.accent}` : "none",
              borderRadius: "9px 9px 0 0", padding: "8px 12px",
              outline: overIdx === i && dragIdx !== null && dragIdx !== i ? `2px dashed ${AT.accent}` : "none",
            }}
          >
            {inSplit && <span style={{ fontSize: 9.5, fontWeight: 800, color: AT.accent }}>B</span>}
            {tabTitle(tab)}
            {tabs.length > 1 && (
              <span
                onClick={(e) => { e.stopPropagation(); onClose(tab.id); }}
                style={{ color: "#9a9a97", fontWeight: 400, padding: "0 2px" }}
                title="Close tab"
              >×</span>
            )}
          </div>
        );
      })}
      <button onClick={onNew} title="New tab" style={{
        all: "unset", cursor: "pointer", color: AT.inkSoft, fontSize: 15, fontWeight: 700, padding: "4px 10px",
      }}>+</button>
      <button onClick={onToggleSplit} style={{
        all: "unset", cursor: "pointer", marginLeft: "auto", flexShrink: 0,
        fontFamily: AT.body, fontSize: 11.5, fontWeight: 700,
        color: split ? "#fff" : AT.inkSoft, background: split ? AT.ink : "#fff",
        border: `1px solid ${split ? AT.ink : "rgba(10,10,10,0.14)"}`, borderRadius: 8, padding: "5px 11px",
      }}>◫ Split</button>
    </div>
  );
}
