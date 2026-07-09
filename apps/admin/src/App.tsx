import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useAuth } from "./auth.js";
import { AT } from "./theme.js";
import { ABtn, AIcon, AInput, type IconName } from "./ui.js";
import { DashboardScreen } from "./screens/Dashboard.js";
import { AuctionsScreen } from "./screens/Auctions.js";
import { AuctionMonitorScreen } from "./screens/AuctionMonitor.js";
import { ListingsScreen } from "./screens/Listings.js";
import { InventoryScreen } from "./screens/Inventory.js";
import { OrdersScreen } from "./screens/Orders.js";
import { CustomersScreen } from "./screens/Customers.js";
import { SettingsScreen } from "./screens/Settings.js";
import { ActivityScreen } from "./screens/Activity.js";
import { FinanceScreen } from "./screens/Finance.js";
import { ContentScreen } from "./screens/Content.js";

export interface Route {
  screen: string;
  param: string | null;
}

export interface Nav {
  route: Route;
  go: (screen: string, param?: string | null) => void;
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
  { id: "orders", label: "Orders", icon: "orders", permission: "orders.view", render: (nav) => <OrdersScreen nav={nav} /> },
  { id: "customers", label: "Bidders", icon: "users", permission: "customers.view", render: (nav) => <CustomersScreen nav={nav} /> },
  { id: "finance", label: "Finance", icon: "finance", permission: "invoices.view", render: (nav) => <FinanceScreen nav={nav} /> },
  { id: "content", label: "Content", icon: "list", permission: "content.view", render: (nav) => <ContentScreen nav={nav} /> },
  { id: "settings", label: "Settings", icon: "settings", permission: "settings.view", render: (nav) => <SettingsScreen nav={nav} /> },
  { id: "activity", label: "Activity", icon: "activity", permission: "audit.view", render: (nav) => <ActivityScreen nav={nav} /> },
];

function LoginScreen() {
  const { login } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await login(email.trim().toLowerCase(), password);
    } catch {
      setError("Invalid email or password.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ height: "100%", display: "grid", placeItems: "center", background: AT.side }}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        style={{ width: 360, background: AT.panel, borderRadius: AT.radius, padding: 26 }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
          <span style={{ width: 34, height: 34, borderRadius: 9, background: AT.ink, color: "#fff", display: "grid", placeItems: "center" }}>
            <AIcon name="gavel" size={18} color="#fff" />
          </span>
          <h1 style={{ fontFamily: AT.body, fontSize: 17, fontWeight: 700, color: AT.ink }}>Auction Admin</h1>
        </div>
        <p style={{ fontFamily: AT.body, fontSize: 12.5, color: AT.inkSoft, marginBottom: 18 }}>Baltic auction house · operations panel</p>
        <div style={{ display: "grid", gap: 10 }}>
          <AInput value={email} onChange={setEmail} placeholder="email@company.com" type="email" autoFocus />
          <AInput value={password} onChange={setPassword} placeholder="Password" type="password" />
          {error && <div style={{ fontFamily: AT.body, fontSize: 12.5, color: AT.danger }}>{error}</div>}
          <ABtn type="submit" kind="dark" full disabled={busy || !email || !password}>
            {busy ? "Signing in…" : "Sign in"}
          </ABtn>
        </div>
      </form>
    </div>
  );
}

export function App() {
  const { user, loading, can, logout } = useAuth();
  const [route, setRoute] = useState<Route>(parseHash);

  useEffect(() => {
    const onHash = () => setRoute(parseHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const nav: Nav = useMemo(
    () => ({
      route,
      go: (screen, param) => {
        location.hash = param ? `/${screen}/${param}` : `/${screen}`;
      },
    }),
    [route],
  );

  if (loading) return null;
  if (!user) return <LoginScreen />;

  const allowed = SCREENS.filter((s) => s.permission === null || can(s.permission));
  const active = allowed.find((s) => s.id === route.screen) ?? allowed[0]!;

  return (
    <div style={{ height: "100%", display: "flex", fontFamily: AT.body }}>
      {/* Sidebar */}
      <aside style={{ width: 216, background: AT.side, color: AT.sideInk, display: "flex", flexDirection: "column", flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 9, padding: "18px 16px 14px" }}>
          <span style={{ width: 28, height: 28, borderRadius: 8, background: AT.accent, display: "grid", placeItems: "center" }}>
            <AIcon name="gavel" size={15} color="#fff" />
          </span>
          <div>
            <div style={{ fontSize: 13.5, fontWeight: 700 }}>Auction Admin</div>
            <div style={{ fontSize: 10.5, color: AT.sideSoft }}>LV · EE · LT</div>
          </div>
        </div>
        <nav style={{ padding: "6px 10px", display: "grid", gap: 2, flex: 1 }}>
          {allowed.map((s) => {
            const isActive = s.id === active.id;
            return (
              <button key={s.id} onClick={() => nav.go(s.id)} style={{
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

      {/* Workspace */}
      <main style={{ flex: 1, minWidth: 0, overflowY: "auto", background: AT.app }}>
        <div style={{ maxWidth: 1280, margin: "0 auto", padding: "22px 26px 60px" }}>{active.render(nav)}</div>
      </main>
    </div>
  );
}
