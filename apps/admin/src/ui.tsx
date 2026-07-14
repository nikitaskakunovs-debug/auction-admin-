/**
 * UI kit — a typed port of the Shhh admin design system (admin-ui.jsx):
 * icons, buttons, badges, stats, tables, pill filters, drawers, the
 * type-to-confirm dialog with required reason, and the toast system.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { AT, toneColors, type Tone } from "./theme.js";

// ── Icons ────────────────────────────────────────────────────────────────────

const strokeProps = (color: string, sw: number) => ({
  fill: "none",
  stroke: color,
  strokeWidth: sw,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
});

export type IconName =
  | "dashboard" | "orders" | "catalog" | "inventory" | "users" | "settings"
  | "search" | "chev" | "chevDown" | "plus" | "check" | "close" | "gavel"
  | "bolt" | "eye" | "bell" | "calendar" | "filter" | "list" | "trash"
  | "shield" | "tag" | "pkg" | "analytics" | "finance" | "logout" | "user"
  | "clock" | "activity" | "refund" | "download" | "warn";

export function AIcon({ name, size = 18, color = "currentColor", sw = 1.7 }: {
  name: IconName; size?: number; color?: string; sw?: number;
}) {
  const p = strokeProps(color, sw);
  const paths: Record<IconName, ReactNode> = {
    dashboard: <><rect x="3" y="3" width="7" height="9" rx="1.5" {...p} /><rect x="14" y="3" width="7" height="5" rx="1.5" {...p} /><rect x="14" y="12" width="7" height="9" rx="1.5" {...p} /><rect x="3" y="16" width="7" height="5" rx="1.5" {...p} /></>,
    orders: <><path d="M4 8L12 4L20 8V18L12 22L4 18V8Z" {...p} /><path d="M4 8L12 12L20 8" {...p} /><path d="M12 12V22" {...p} /></>,
    catalog: <path d="M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z" {...p} />,
    inventory: <><path d="M3 7l9-4 9 4-9 4-9-4Z" {...p} /><path d="M3 12l9 4 9-4M3 17l9 4 9-4" {...p} /></>,
    users: <><circle cx="9" cy="8" r="3.2" {...p} /><path d="M3.5 19a5.5 5.5 0 0 1 11 0" {...p} /><path d="M16 5.5a3 3 0 0 1 0 5.5M17.5 19a5.5 5.5 0 0 0-3-4.9" {...p} /></>,
    settings: <><circle cx="12" cy="12" r="3" {...p} /><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2" {...p} /></>,
    search: <><circle cx="11" cy="11" r="7" {...p} /><path d="M16.5 16.5L21 21" {...p} /></>,
    chev: <path d="M9 6l6 6-6 6" {...p} />,
    chevDown: <path d="M6 9l6 6 6-6" {...p} />,
    plus: <path d="M12 5v14M5 12h14" {...p} />,
    check: <path d="M5 12l5 5L19 7" {...p} />,
    close: <path d="M6 6l12 12M6 18L18 6" {...p} />,
    gavel: <><path d="M13 5l6 6M10 8l6 6M12.5 6.5L7 12l3 3 5.5-5.5" {...p} /><path d="M3 21l6-6" {...p} /></>,
    bolt: <path d="M13 3L5 14h6l-1 7 8-11h-6l1-7Z" {...p} />,
    eye: <><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" {...p} /><circle cx="12" cy="12" r="3" {...p} /></>,
    bell: <><path d="M6 9a6 6 0 0 1 12 0c0 5 2 6 2 6H4s2-1 2-6Z" {...p} /><path d="M10 20a2 2 0 0 0 4 0" {...p} /></>,
    calendar: <><rect x="3" y="5" width="18" height="16" rx="2" {...p} /><path d="M3 9h18M8 3v4M16 3v4" {...p} /></>,
    filter: <path d="M3 5h18l-7 8v6l-4-2v-4L3 5Z" {...p} />,
    list: <path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01" {...p} />,
    trash: <path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13" {...p} />,
    shield: <path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6l7-3Z" {...p} />,
    tag: <><path d="M3 12V5a2 2 0 0 1 2-2h7l9 9-9 9-9-9Z" {...p} /><circle cx="8" cy="8" r="1.4" fill={color} stroke="none" /></>,
    pkg: <><path d="M4 8l8-4 8 4v8l-8 4-8-4V8Z" {...p} /><path d="M4 8l8 4 8-4M12 12v8" {...p} /></>,
    analytics: <path d="M4 19V5M4 19h16M8 16v-4M12 16V9M16 16v-6" {...p} />,
    finance: <><rect x="3" y="6" width="18" height="13" rx="2" {...p} /><path d="M3 10h18M7 15h4" {...p} /></>,
    logout: <><path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3" {...p} /><path d="M10 17l-5-5 5-5M5 12h12" {...p} /></>,
    user: <><circle cx="12" cy="8" r="4" {...p} /><path d="M4 20a8 8 0 0 1 16 0" {...p} /></>,
    clock: <><circle cx="12" cy="12" r="9" {...p} /><path d="M12 7v5l3 2" {...p} /></>,
    activity: <path d="M3 12h4l3-8 4 16 3-8h4" {...p} />,
    refund: <><path d="M3 7v5h5" {...p} /><path d="M3.5 12a8.5 8.5 0 1 1 2 5.5" {...p} /><path d="M12 8v4l3 2" {...p} /></>,
    download: <><path d="M12 4v11M7 11l5 5 5-5" {...p} /><path d="M5 20h14" {...p} /></>,
    warn: <><path d="M12 3L2 20h20L12 3Z" {...p} /><path d="M12 10v4M12 17h.01" {...p} /></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" style={{ flexShrink: 0 }}>{paths[name]}</svg>;
}

// ── Buttons ──────────────────────────────────────────────────────────────────

export function ABtn({ children, onClick, kind = "primary", size = "md", full, style, disabled, type }: {
  children: ReactNode;
  onClick?: () => void;
  kind?: "primary" | "ghost" | "danger" | "dark" | "soft";
  size?: "sm" | "md" | "lg";
  full?: boolean;
  style?: CSSProperties;
  disabled?: boolean;
  type?: "submit" | "button";
}) {
  const h = size === "sm" ? 30 : size === "lg" ? 44 : 38;
  const kindStyle: CSSProperties = {
    primary: { background: AT.accent, color: "#fff", border: `1px solid ${AT.accent}` },
    ghost: { background: AT.panel, color: AT.ink, border: `1px solid ${AT.rule}` },
    danger: { background: "#fff", color: AT.danger, border: `1px solid ${AT.danger}` },
    dark: { background: AT.ink, color: "#fff", border: `1px solid ${AT.ink}` },
    soft: { background: AT.surfaceAlt, color: AT.ink, border: "1px solid transparent" },
  }[kind];
  return (
    <button type={type ?? "button"} onClick={disabled ? undefined : onClick} style={{
      all: "unset", boxSizing: "border-box", cursor: disabled ? "not-allowed" : "pointer",
      height: h, padding: size === "sm" ? "0 12px" : "0 16px", borderRadius: AT.radiusSm,
      fontFamily: AT.body, fontWeight: 600, fontSize: size === "sm" ? 12.5 : 13.5,
      display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 7,
      width: full ? "100%" : undefined, opacity: disabled ? 0.45 : 1, whiteSpace: "nowrap",
      ...kindStyle, ...style,
    }}>{children}</button>
  );
}

// ── Badges / stats / avatar ──────────────────────────────────────────────────

export function ABadge({ tone = "neutral", children }: { tone?: Tone; children: ReactNode }) {
  const c = toneColors[tone];
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 6, padding: "3px 9px 3px 8px",
      borderRadius: 999, background: c.bg, color: c.fg, fontFamily: AT.body,
      fontWeight: 700, fontSize: 11.5, whiteSpace: "nowrap",
    }}>
      <span style={{ width: 6, height: 6, borderRadius: 999, background: c.fg }} />
      {children}
    </span>
  );
}

export function AStat({ label, value, sub, tone, onClick }: {
  label: string; value: ReactNode; sub?: ReactNode; tone?: Tone; onClick?: () => void;
}) {
  return (
    <div onClick={onClick} style={{
      background: AT.panel, border: `1px solid ${AT.rule}`, borderRadius: AT.radius,
      padding: "14px 16px", flex: 1, minWidth: 150, cursor: onClick ? "pointer" : undefined,
    }}>
      <div style={{ fontFamily: AT.body, fontSize: 11.5, fontWeight: 700, color: AT.inkSoft, textTransform: "uppercase", letterSpacing: "0.06em" }}>{label}</div>
      <div style={{ fontFamily: AT.body, fontSize: 24, fontWeight: 700, color: tone ? toneColors[tone].fg : AT.ink, marginTop: 4, letterSpacing: "-0.02em" }}>{value}</div>
      {sub ? <div style={{ fontFamily: AT.body, fontSize: 12, color: AT.inkSoft, marginTop: 3 }}>{sub}</div> : null}
    </div>
  );
}

export function AAvatar({ name, size = 28 }: { name: string; size?: number }) {
  const initials = name.split(/[\s_.-]+/).slice(0, 2).map((s) => s[0]?.toUpperCase() ?? "").join("");
  const hue = [...name].reduce((a, ch) => a + ch.charCodeAt(0), 0) % 360;
  return (
    <span style={{
      width: size, height: size, borderRadius: 999, background: `hsl(${hue} 45% 88%)`,
      color: `hsl(${hue} 60% 30%)`, display: "inline-flex", alignItems: "center",
      justifyContent: "center", fontFamily: AT.body, fontWeight: 700, fontSize: size * 0.38, flexShrink: 0,
    }}>{initials || "?"}</span>
  );
}

// ── Panels / tables ──────────────────────────────────────────────────────────

export function ACard({ title, actions, children, pad = true, style }: {
  title?: ReactNode; actions?: ReactNode; children: ReactNode; pad?: boolean; style?: CSSProperties;
}) {
  return (
    <section style={{ background: AT.panel, border: `1px solid ${AT.rule}`, borderRadius: AT.radius, overflow: "hidden", ...style }}>
      {title !== undefined && (
        <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 16px", borderBottom: `1px solid ${AT.ruleSoft}` }}>
          <h3 style={{ fontFamily: AT.body, fontSize: 13.5, fontWeight: 700, color: AT.ink }}>{title}</h3>
          {actions}
        </header>
      )}
      <div style={pad ? { padding: 16 } : undefined}>{children}</div>
    </section>
  );
}

export function ATable({ head, children }: { head: ReactNode[]; children: ReactNode }) {
  return (
    <table style={{ width: "100%", borderCollapse: "collapse" }}>
      <thead>
        <tr>
          {head.map((h, i) => (
            <th key={i} style={{
              textAlign: "left", padding: "9px 12px", fontFamily: AT.body, fontSize: 11,
              fontWeight: 700, color: AT.inkSoft, textTransform: "uppercase",
              letterSpacing: "0.07em", borderBottom: `1px solid ${AT.rule}`, background: AT.surfaceAlt,
              whiteSpace: "nowrap",
            }}>{h}</th>
          ))}
        </tr>
      </thead>
      <tbody>{children}</tbody>
    </table>
  );
}

export function ATr({ children, onClick, active }: { children: ReactNode; onClick?: () => void; active?: boolean }) {
  const [hover, setHover] = useState(false);
  return (
    <tr
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        cursor: onClick ? "pointer" : undefined,
        background: active ? AT.accentSoft : hover && onClick ? AT.surfaceAlt : undefined,
      }}
    >{children}</tr>
  );
}

export function ATd({ children, mono, right, style }: { children: ReactNode; mono?: boolean; right?: boolean; style?: CSSProperties }) {
  return (
    <td style={{
      padding: "10px 12px", fontFamily: mono ? AT.mono : AT.body, fontSize: mono ? 12 : 13,
      color: AT.ink, borderBottom: `1px solid ${AT.ruleSoft}`, textAlign: right ? "right" : "left",
      whiteSpace: "nowrap", ...style,
    }}>{children}</td>
  );
}

export function AEmpty({ text }: { text: string }) {
  return <div style={{ padding: 36, textAlign: "center", fontFamily: AT.body, fontSize: 13, color: AT.inkSoft }}>{text}</div>;
}

// ── Filters: pills, select, search ───────────────────────────────────────────

export function APills<T extends string>({ options, value, onChange }: {
  options: Array<{ id: T; label: string; count?: number }>;
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
      {options.map((o) => {
        const active = o.id === value;
        return (
          <button key={o.id} onClick={() => onChange(o.id)} style={{
            all: "unset", cursor: "pointer", padding: "6px 12px", borderRadius: 999,
            fontFamily: AT.body, fontWeight: 600, fontSize: 12.5,
            background: active ? AT.ink : AT.panel, color: active ? "#fff" : AT.ink,
            border: `1px solid ${active ? AT.ink : AT.rule}`,
          }}>
            {o.label}
            {o.count !== undefined && (
              <span style={{ marginLeft: 6, opacity: 0.6, fontWeight: 700, fontSize: 11 }}>{o.count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

export function ASelect({ label, value, onChange, options }: {
  label?: string;
  value: string;
  onChange: (v: string) => void;
  options: Array<{ value: string; label: string }>;
}) {
  return (
    <label style={{ display: "inline-flex", alignItems: "center", gap: 7, fontFamily: AT.body, fontSize: 12.5, color: AT.inkSoft }}>
      {label}
      <select value={value} onChange={(e) => onChange(e.target.value)} style={{
        height: 32, borderRadius: AT.radiusSm, border: `1px solid ${AT.rule}`, background: AT.panel,
        fontFamily: AT.body, fontSize: 12.5, color: AT.ink, padding: "0 8px",
      }}>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </label>
  );
}

export function AInput({ value, onChange, placeholder, type = "text", style, autoFocus, inputRef }: {
  value: string; onChange: (v: string) => void; placeholder?: string; type?: string; style?: CSSProperties; autoFocus?: boolean;
  /** For focus management (e.g. rapid-entry forms that refocus after submit). */
  inputRef?: React.Ref<HTMLInputElement>;
}) {
  return (
    <input
      ref={inputRef}
      type={type}
      value={value}
      autoFocus={autoFocus}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      style={{
        height: 36, borderRadius: AT.radiusSm, border: `1px solid ${AT.rule}`, background: AT.panel,
        fontFamily: AT.body, fontSize: 13, color: AT.ink, padding: "0 11px", outline: "none",
        width: "100%", ...style,
      }}
    />
  );
}

export function AField({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label style={{ display: "block" }}>
      <div style={{ fontFamily: AT.body, fontSize: 12, fontWeight: 700, color: AT.ink, marginBottom: 5 }}>{label}</div>
      {children}
      {hint ? <div style={{ fontFamily: AT.body, fontSize: 11.5, color: AT.inkSoft, marginTop: 4 }}>{hint}</div> : null}
    </label>
  );
}

// ── Drawer ───────────────────────────────────────────────────────────────────

export function ADrawer({ title, onClose, children, width = 520, footer }: {
  title: ReactNode; onClose: () => void; children: ReactNode; width?: number; footer?: ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 60, display: "flex", justifyContent: "flex-end", background: "rgba(10,10,10,0.35)" }} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} style={{
        width, maxWidth: "94vw", height: "100%", background: AT.panel, display: "flex",
        flexDirection: "column", animation: "drawer-in 160ms ease-out",
      }}>
        <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 18px", borderBottom: `1px solid ${AT.rule}` }}>
          <h2 style={{ fontFamily: AT.body, fontSize: 15, fontWeight: 700, color: AT.ink }}>{title}</h2>
          <button onClick={onClose} style={{ all: "unset", cursor: "pointer", padding: 4, color: AT.inkSoft }}><AIcon name="close" size={16} /></button>
        </header>
        <div style={{ flex: 1, overflowY: "auto", padding: 18 }}>{children}</div>
        {footer ? <footer style={{ padding: "12px 18px", borderTop: `1px solid ${AT.rule}`, display: "flex", gap: 8, justifyContent: "flex-end" }}>{footer}</footer> : null}
      </div>
    </div>
  );
}

// ── Confirm dialog (type-to-confirm + required reason, Shhh pattern) ────────

export interface ConfirmOptions {
  title: string;
  body?: string;
  confirmLabel?: string;
  danger?: boolean;
  /** Require this exact text to be typed (e.g. an order ref). */
  typeToConfirm?: string;
  /** Require a free-text reason; passed to onConfirm. */
  requireReason?: boolean;
}

interface ConfirmState extends ConfirmOptions {
  resolve: (v: { ok: boolean; reason?: string }) => void;
}

const ConfirmContext = createContext<(opts: ConfirmOptions) => Promise<{ ok: boolean; reason?: string }>>(
  () => Promise.resolve({ ok: false }),
);
export const useConfirm = () => useContext(ConfirmContext);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<ConfirmState | null>(null);
  const [typed, setTyped] = useState("");
  const [reason, setReason] = useState("");

  const ask = useCallback((opts: ConfirmOptions) => {
    setTyped("");
    setReason("");
    return new Promise<{ ok: boolean; reason?: string }>((resolve) => setState({ ...opts, resolve }));
  }, []);

  const finish = (ok: boolean) => {
    state?.resolve({ ok, reason: reason.trim() || undefined });
    setState(null);
  };

  const blocked =
    (state?.typeToConfirm && typed !== state.typeToConfirm) ||
    (state?.requireReason && reason.trim().length < 3);

  return (
    <ConfirmContext.Provider value={ask}>
      {children}
      {state && (
        <div style={{ position: "fixed", inset: 0, zIndex: 80, display: "grid", placeItems: "center", background: "rgba(10,10,10,0.4)" }} onClick={() => finish(false)}>
          <div onClick={(e) => e.stopPropagation()} style={{ width: 420, maxWidth: "92vw", background: AT.panel, borderRadius: AT.radius, padding: 20 }}>
            <h2 style={{ fontFamily: AT.body, fontSize: 15.5, fontWeight: 700, color: state.danger ? AT.danger : AT.ink }}>{state.title}</h2>
            {state.body && <p style={{ fontFamily: AT.body, fontSize: 13, color: AT.inkSoft, marginTop: 8, lineHeight: 1.5 }}>{state.body}</p>}
            {state.typeToConfirm && (
              <div style={{ marginTop: 12 }}>
                <div style={{ fontFamily: AT.body, fontSize: 12, color: AT.inkSoft, marginBottom: 5 }}>
                  Type <strong style={{ color: AT.ink, fontFamily: AT.mono }}>{state.typeToConfirm}</strong> to confirm
                </div>
                <AInput value={typed} onChange={setTyped} autoFocus />
              </div>
            )}
            {state.requireReason && (
              <div style={{ marginTop: 12 }}>
                <div style={{ fontFamily: AT.body, fontSize: 12, color: AT.inkSoft, marginBottom: 5 }}>Reason (required, goes to the audit log)</div>
                <AInput value={reason} onChange={setReason} placeholder="Why?" autoFocus={!state.typeToConfirm} />
              </div>
            )}
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 18 }}>
              <ABtn kind="ghost" onClick={() => finish(false)}>Cancel</ABtn>
              <ABtn kind={state.danger ? "danger" : "primary"} disabled={!!blocked} onClick={() => finish(true)}>
                {state.confirmLabel ?? "Confirm"}
              </ABtn>
            </div>
          </div>
        </div>
      )}
    </ConfirmContext.Provider>
  );
}

// ── Toasts ───────────────────────────────────────────────────────────────────

interface Toast { id: number; text: string; tone: Tone }

const ToastContext = createContext<(text: string, tone?: Tone) => void>(() => undefined);
export const useToast = () => useContext(ToastContext);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);
  const push = useCallback((text: string, tone: Tone = "neutral") => {
    const id = nextId.current++;
    setToasts((t) => [...t, { id, text, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3200);
  }, []);
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div style={{ position: "fixed", bottom: 18, left: "50%", transform: "translateX(-50%)", zIndex: 100, display: "flex", flexDirection: "column", gap: 8, alignItems: "center" }}>
        {toasts.map((t) => (
          <div key={t.id} style={{
            background: AT.ink, color: "#fff", borderRadius: 10, padding: "10px 16px",
            fontFamily: AT.body, fontSize: 13, fontWeight: 600, animation: "toast-in 140ms ease-out",
            display: "flex", alignItems: "center", gap: 8, maxWidth: 480,
          }}>
            {t.tone === "danger" ? <AIcon name="warn" size={14} color="#FCA5A5" /> : t.tone === "ok" ? <AIcon name="check" size={14} color="#86EFAC" /> : null}
            {t.text}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

// ── Countdown ────────────────────────────────────────────────────────────────

export function useNowTick(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

export function formatCountdown(msLeft: number): string {
  if (msLeft <= 0) return "ended";
  const s = Math.floor(msLeft / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}
