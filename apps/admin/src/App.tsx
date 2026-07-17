import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useAuth } from "./auth.js";
import { isWarehouseHost } from "./host.js";
import { LoginScreen } from "./Login.js";
import { SearchPalette, type SearchTarget } from "./shell/SearchPalette.js";
import { TabBar, type Tab } from "./shell/TabBar.js";
import { AT } from "./theme.js";
import { AIcon, type IconName } from "./ui.js";
import { DashboardScreen } from "./screens/Dashboard.js";
import { AuctionsScreen } from "./screens/Auctions.js";
import { AuctionMonitorScreen } from "./screens/AuctionMonitor.js";
import { ListingsScreen } from "./screens/Listings.js";
import { InventoryScreen } from "./screens/Inventory.js";
import { OrdersScreen } from "./screens/Orders.js";
import { PickupScreen } from "./screens/Pickup.js";
import { ReceivingScreen } from "./screens/Receiving.js";
import { BoardScreen } from "./screens/Board.js";
import { CustomersScreen } from "./screens/Customers.js";
import { SettingsScreen } from "./screens/Settings.js";
import { ActivityScreen } from "./screens/Activity.js";
import { FinanceScreen } from "./screens/Finance.js";
import { ContentScreen } from "./screens/Content.js";
import { NotificationsScreen } from "./screens/Notifications.js";
import { SecurityScreen } from "./screens/Security.js";
import { WarehouseMode } from "./wh/Warehouse.js";

export interface Route {
  screen: string;
  param: string | null;
}

export interface Nav {
  route: Route;
  go: (screen: string, param?: string | null) => void;
  /** Open a record in a NEW tab (cross-links) — the current view stays put. */
  openTab?: (screen: string, param?: string | null) => void;
}

function parseHash(): Route {
  const [screen = "dashboard", param = null] = location.hash.replace(/^#\/?/, "").split("/");
  return { screen: screen || "dashboard", param };
}

interface ScreenDef {
  id: string;
  label: string;
  icon: IconName;
  /** Permission required to see this screen; null = every signed-in admin. */
  permission: string | null;
  render: (nav: Nav) => ReactNode;
}

const SCREENS: ScreenDef[] = [
  { id: "dashboard", label: "Dashboard", icon: "dashboard", permission: null, render: (nav) => <DashboardScreen nav={nav} /> },
  { id: "auctions", label: "Auctions", icon: "gavel", permission: "auctions.view", render: (nav) => nav.route.param ? <AuctionMonitorScreen nav={nav} auctionId={nav.route.param} /> : <AuctionsScreen nav={nav} /> },
  { id: "listings", label: "Listings", icon: "tag", permission: "listings.view", render: (nav) => <ListingsScreen nav={nav} /> },
  { id: "inventory", label: "Inventory", icon: "inventory", permission: "items.view", render: (nav) => <InventoryScreen nav={nav} /> },
  { id: "receiving", label: "Receiving", icon: "inventory", permission: "warehouse.manage", render: (nav) => <ReceivingScreen nav={nav} /> },
  { id: "orders", label: "Orders", icon: "orders", permission: "orders.view", render: (nav) => <OrdersScreen nav={nav} /> },
  { id: "pickup", label: "Pickup", icon: "inventory", permission: "pickup.view", render: (nav) => <PickupScreen nav={nav} /> },
  { id: "customers", label: "Bidders", icon: "users", permission: "customers.view", render: (nav) => <CustomersScreen nav={nav} /> },
  { id: "finance", label: "Finance", icon: "finance", permission: "invoices.view", render: (nav) => <FinanceScreen nav={nav} /> },
  { id: "content", label: "Content", icon: "list", permission: "content.view", render: (nav) => <ContentScreen nav={nav} /> },
  { id: "settings", label: "Settings", icon: "settings", permission: "settings.view", render: (nav) => <SettingsScreen nav={nav} /> },
  { id: "notifications", label: "Notifications", icon: "bell", permission: "audit.view", render: (nav) => <NotificationsScreen nav={nav} /> },
  { id: "activity", label: "Activity", icon: "activity", permission: "audit.view", render: (nav) => <ActivityScreen nav={nav} /> },
  // Personal account security — available to every signed-in admin.
  { id: "security", label: "Security", icon: "shield", permission: null, render: () => <SecurityScreen /> },
];

// ── Tab/split shell state (persisted per browser, like Shhh) ─────────────────

const SHELL_KEY = "adminShell.v1";

interface ShellState {
  tabs: Tab[];
  activeId: string;
  split: boolean;
  splitId: string | null;
}

const newId = () => Math.random().toString(36).slice(2, 9);

function bootShell(): ShellState {
  try {
    const raw = localStorage.getItem(SHELL_KEY);
    if (raw) {
      const s = JSON.parse(raw) as ShellState;
      if (Array.isArray(s.tabs) && s.tabs.length > 0 && s.tabs.every((t) => t.id && t.screen)) {
        // The URL wins over the stored active tab so deep links keep working.
        const here = parseHash();
        if (location.hash && here.screen !== "dashboard") {
          const active = s.tabs.find((t) => t.id === s.activeId);
          if (active) {
            active.screen = here.screen;
            active.param = here.param;
          }
        }
        return { ...s, split: Boolean(s.split && s.splitId && s.tabs.some((t) => t.id === s.splitId)) };
      }
    }
  } catch {
    /* corrupted state — start fresh */
  }
  const here = parseHash();
  const first: Tab = { id: newId(), screen: here.screen, param: here.param };
  return { tabs: [first], activeId: first.id, split: false, splitId: null };
}

export function App() {
  const { user, loading, can, logout } = useAuth();
  const [shell, setShell] = useState<ShellState>(bootShell);
  const [focused, setFocused] = useState<"a" | "b">("a");
  const [palette, setPalette] = useState(false);

  const { tabs, activeId, split, splitId } = shell;
  const activeTab = tabs.find((t) => t.id === activeId) ?? tabs[0]!;
  const splitTab = split ? tabs.find((t) => t.id === splitId) ?? null : null;

  // Persist + mirror the pane-A route into the hash (deep links, back button).
  useEffect(() => {
    try {
      localStorage.setItem(SHELL_KEY, JSON.stringify(shell));
    } catch {
      /* private mode */
    }
    const want = activeTab.param ? `#/${activeTab.screen}/${activeTab.param}` : `#/${activeTab.screen}`;
    if (location.hash !== want) history.replaceState(null, "", want);
  }, [shell, activeTab]);

  // Back/forward or a manually-typed hash updates the active tab.
  useEffect(() => {
    const onHash = () => {
      const here = parseHash();
      setShell((s) => ({
        ...s,
        tabs: s.tabs.map((t) => (t.id === s.activeId ? { ...t, screen: here.screen, param: here.param } : t)),
      }));
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  // ⌘K / Ctrl-K opens the palette anywhere; "/" too when not typing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test((e.target as HTMLElement)?.tagName ?? "");
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPalette((p) => !p);
      } else if (e.key === "/" && !typing && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        setPalette(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const paneTargetId = focused === "b" && split && splitId ? splitId : activeId;

  /** Navigate within one pane's tab. */
  const goInTab = useCallback((tabId: string, screen: string, param?: string | null) => {
    setShell((s) => ({
      ...s,
      tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, screen, param: param ?? null } : t)),
    }));
  }, []);

  /** Open a new tab and focus it in pane A. */
  const openTab = useCallback((screen: string, param?: string | null) => {
    setShell((s) => {
      const tab: Tab = { id: newId(), screen, param: param ?? null };
      const idx = s.tabs.findIndex((t) => t.id === s.activeId);
      const tabs2 = [...s.tabs.slice(0, idx + 1), tab, ...s.tabs.slice(idx + 1)];
      return { ...s, tabs: tabs2, activeId: tab.id };
    });
    setFocused("a");
  }, []);

  const selectTab = (id: string) =>
    setShell((s) => {
      // Selecting the tab that lives in pane B swaps the panes instead of
      // showing the same tab twice.
      if (s.split && s.splitId === id) return { ...s, activeId: id, splitId: s.activeId };
      return { ...s, activeId: id };
    });

  const closeTab = (id: string) => {
    setShell((s) => {
      if (s.tabs.length <= 1) return s;
      const idx = s.tabs.findIndex((t) => t.id === id);
      const tabs2 = s.tabs.filter((t) => t.id !== id);
      const nextActive = s.activeId === id ? (tabs2[Math.max(0, idx - 1)]?.id ?? tabs2[0]!.id) : s.activeId;
      let split2 = s.split;
      let splitId2 = s.splitId;
      if (s.splitId === id) {
        const other = tabs2.find((t) => t.id !== nextActive);
        if (other) splitId2 = other.id;
        else {
          split2 = false;
          splitId2 = null;
        }
      }
      return { tabs: tabs2, activeId: nextActive, split: split2, splitId: splitId2 };
    });
  };

  const reorderTabs = (from: number, to: number) => {
    setShell((s) => {
      const tabs2 = [...s.tabs];
      const [moved] = tabs2.splice(from, 1);
      tabs2.splice(to, 0, moved!);
      return { ...s, tabs: tabs2 };
    });
  };

  const toggleSplit = () => {
    setShell((s) => {
      if (s.split) return { ...s, split: false, splitId: null };
      let second = s.tabs.find((t) => t.id !== s.activeId);
      let tabs2 = s.tabs;
      if (!second) {
        second = { id: newId(), screen: "dashboard", param: null };
        tabs2 = [...s.tabs, second];
      }
      return { ...s, tabs: tabs2, split: true, splitId: second.id };
    });
    setFocused("a");
  };

  // On wh.<domain> the SPA is locked to warehouse mode — workers can't wander
  // into the full admin from that host (it lives on admin.<domain>).
  const whHost = isWarehouseHost();
  const bootRoute = activeTab; // for board detection below

  // Waiting-room TVs render without a login: #/board shows only the
  // PII-free public board payload (ticket numbers, progress, zone counts).
  if (!whHost && bootRoute.screen === "board") return <BoardScreen view={bootRoute.param} />;

  if (loading) return null;
  if (!user) return <LoginScreen />;

  // Phone-first PWA shell for storage workers — own layout, same session/RBAC.
  if (whHost || bootRoute.screen === "wh") return <WarehouseMode />;

  const allowed = SCREENS.filter((s) => s.permission === null || can(s.permission));
  const allowedIds = new Set(allowed.map((s) => s.id));

  const renderPane = (tab: Tab, pane: "a" | "b") => {
    const nav: Nav = {
      route: { screen: tab.screen, param: tab.param },
      go: (screen, param) => goInTab(tab.id, screen, param),
      openTab,
    };
    const def = allowed.find((s) => s.id === tab.screen) ?? allowed[0]!;
    const isFocused = !split || focused === pane;
    return (
      <div
        onMouseDownCapture={() => setFocused(pane)}
        style={{
          flex: 1,
          minWidth: 0,
          overflowY: "auto",
          background: AT.app,
          outline: split && isFocused ? `2px solid ${AT.accent}` : "none",
          outlineOffset: -2,
          borderRight: split && pane === "a" ? `1px solid ${AT.rule}` : "none",
        }}
      >
        {split && (
          <div style={{
            position: "sticky", top: 0, zIndex: 4, fontFamily: AT.body, fontSize: 10.5, fontWeight: 800,
            letterSpacing: "0.06em", padding: "4px 12px",
            background: isFocused ? AT.accentSoft : AT.surfaceAlt,
            color: isFocused ? AT.accent : AT.inkSoft,
          }}>
            PANE {pane.toUpperCase()}{isFocused ? " · FOCUSED" : ""}
          </div>
        )}
        <div style={{ maxWidth: split ? undefined : 1280, margin: "0 auto", padding: "22px 26px 60px" }}>
          {def.render(nav)}
        </div>
      </div>
    );
  };

  const sidebarNav: Nav = {
    route: { screen: activeTab.screen, param: activeTab.param },
    go: (screen, param) => goInTab(paneTargetId, screen, param),
    openTab,
  };

  const onSearchOpen = (target: SearchTarget) => {
    if (!allowedIds.has(target.screen)) return;
    openTab(target.screen, target.param);
  };

  return (
    <div style={{ height: "100%", display: "flex", fontFamily: AT.body }}>
      {/* Sidebar */}
      <aside style={{ width: 216, background: AT.side, color: AT.sideInk, display: "flex", flexDirection: "column", flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 9, padding: "18px 16px 10px" }}>
          <span style={{ width: 28, height: 28, borderRadius: 8, background: AT.accent, display: "grid", placeItems: "center" }}>
            <AIcon name="gavel" size={15} color="#fff" />
          </span>
          <div>
            <div style={{ fontSize: 13.5, fontWeight: 700 }}>Izsoli.lv</div>
            <div style={{ fontSize: 10.5, color: AT.sideSoft }}>LV · EE · LT</div>
          </div>
        </div>
        <button onClick={() => setPalette(true)} style={{
          all: "unset", cursor: "pointer", margin: "2px 10px 8px", padding: "8px 10px", borderRadius: 8,
          display: "flex", alignItems: "center", gap: 8, fontSize: 12, fontWeight: 600,
          color: AT.sideSoft, background: "rgba(255,255,255,0.06)", border: `1px solid ${AT.sideRule}`,
        }}>
          🔍 Search…
          <span style={{ marginLeft: "auto", fontFamily: AT.mono, fontSize: 9.5, border: `1px solid ${AT.sideRule}`, borderRadius: 4, padding: "1px 5px" }}>⌘K</span>
        </button>
        <nav style={{ padding: "0 10px", display: "grid", gap: 2, flex: 1, overflowY: "auto" }}>
          {allowed.map((s) => {
            const isActive = s.id === (split && focused === "b" && splitTab ? splitTab.screen : activeTab.screen);
            return (
              <button key={s.id} onClick={() => sidebarNav.go(s.id)} style={{
                all: "unset", cursor: "pointer", display: "flex", alignItems: "center", gap: 10,
                padding: "9px 10px", borderRadius: 8, fontSize: 13, fontWeight: 600,
                color: isActive ? "#fff" : AT.sideSoft,
                background: isActive ? "rgba(255,255,255,0.10)" : "transparent",
              }}>
                <AIcon name={s.icon} size={16} color={isActive ? "#fff" : "rgba(255,255,255,0.55)"} />
                {s.label}
              </button>
            );
          })}
        </nav>
        {(can("warehouse.manage") || can("pickup.operate")) && (
          <button onClick={() => sidebarNav.go("wh")} style={{
            all: "unset", cursor: "pointer", margin: "0 10px 8px", padding: "9px 10px", borderRadius: 8,
            fontSize: 12.5, fontWeight: 700, color: AT.sideSoft, border: `1px dashed ${AT.sideRule}`, textAlign: "center",
          }}>
            📦 Warehouse mode
          </button>
        )}
        <div style={{ padding: 12, borderTop: `1px solid ${AT.sideRule}`, display: "flex", alignItems: "center", gap: 9 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 12.5, fontWeight: 700, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{user.name}</div>
            <div style={{ fontSize: 10.5, color: AT.sideSoft }}>{user.role.replace(/_/g, " ")}</div>
          </div>
          <button title="Sign out" onClick={() => void logout()} style={{ all: "unset", cursor: "pointer", padding: 5, color: AT.sideSoft }}>
            <AIcon name="logout" size={16} />
          </button>
        </div>
      </aside>

      {/* Workspace: tab strip + one or two panes */}
      <main style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", background: AT.app }}>
        <TabBar
          tabs={tabs}
          activeId={activeId}
          splitId={splitId}
          split={split}
          onSelect={selectTab}
          onClose={closeTab}
          onNew={() => openTab("dashboard")}
          onReorder={reorderTabs}
          onToggleSplit={toggleSplit}
        />
        <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
          {renderPane(activeTab, "a")}
          {split && splitTab && renderPane(splitTab, "b")}
        </div>
      </main>

      {palette && <SearchPalette allowedScreens={allowedIds} onOpen={onSearchOpen} onClose={() => setPalette(false)} />}
    </div>
  );
}
