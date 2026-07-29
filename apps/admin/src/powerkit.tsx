/**
 * A3 power-list kit — the Orders (A2) pattern extracted so Inventory,
 * Listings, Bidders, and Finance share one implementation: saved views,
 * filter chips, bulk bar, export menu, selection, debounce, and the small
 * styling helpers. Orders itself consumes this module too.
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { api, ApiError } from "./api.js";
import { AT } from "./theme.js";
import { AIcon, AInput, useConfirm, useToast, type IconName } from "./ui.js";

// ── Generic filter plumbing ──────────────────────────────────────────────────

export type FlatFilters = Record<string, string>;
/** Constraint that accepts plain interfaces (no index signature needed). */
type Filterish<F> = { [K in keyof F]: string };

/** Normalize an opaque blob (saved view / localStorage) onto the defaults. */
export function makeFilterTools<F extends Filterish<F>>(defaults: F) {
  const keys = Object.keys(defaults) as Array<keyof F & string>;
  const normalize = (blob: Record<string, unknown>): F => {
    const out = { ...defaults };
    for (const k of keys) {
      const v = (blob as Record<string, unknown>)[k];
      if (typeof v === "string") out[k] = v as F[keyof F & string];
    }
    return out;
  };
  const same = (a: F, b: F): boolean => keys.every((k) => a[k] === b[k]);
  const loadStored = (storageKey: string): F => {
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw) return normalize(JSON.parse(raw) as Record<string, unknown>);
    } catch {
      /* corrupted/private mode — defaults */
    }
    return { ...defaults };
  };
  return { keys, normalize, same, loadStored };
}

/** Persist filters to localStorage (per browser), debounce-free. */
export function useStoredFilters<F>(storageKey: string, filters: F): void {
  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(filters));
    } catch {
      /* private mode */
    }
  }, [storageKey, filters]);
}

/** 300ms trailing debounce for search inputs (input instant, query trails). */
export function useDebounced(value: string, apply: (v: string) => void, ms = 300): void {
  const fn = useRef(apply);
  fn.current = apply;
  useEffect(() => {
    const t = setTimeout(() => fn.current(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
}

// ── Saved views ──────────────────────────────────────────────────────────────

export interface SavedView {
  id: string;
  name: string;
  filters: Record<string, unknown>;
  position: number;
}

export interface ViewsBarData {
  views: SavedView[];
  activeView: SavedView | null;
  isDefault: boolean;
  lastView: SavedView | null;
  onApply: (v: SavedView) => void;
  onSave: () => void;
  onRename: (v: SavedView) => void;
  onUpdate: (v: SavedView) => void;
  onDelete: (v: SavedView) => void;
}

export interface SavedViewsApi {
  views: SavedView[];
  activeView: SavedView | null;
  isDefault: boolean;
  applyView: (v: SavedView) => void;
  ViewsBarProps: ViewsBarData;
}

/** The complete saved-views lifecycle for one screen slug. */
export function useSavedViews<F extends Filterish<F>>(opts: {
  screen: string;
  filters: F;
  defaults: F;
  normalize: (blob: Record<string, unknown>) => F;
  same: (a: F, b: F) => boolean;
  apply: (f: F) => void;
  /** UI noun — "view" (default) or "segment" on Bidders. */
  noun?: string;
}): SavedViewsApi {
  const toast = useToast();
  const confirm = useConfirm();
  const noun = opts.noun ?? "view";
  const [views, setViews] = useState<SavedView[]>([]);
  const [lastViewId, setLastViewId] = useState<string | null>(null);

  useEffect(() => {
    void api.get<{ views: SavedView[] }>(`/api/views?screen=${opts.screen}`).then((r) => setViews(r.views)).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opts.screen]);

  const isDefault = opts.same(opts.filters, opts.defaults);
  const activeView = views.find((v) => opts.same(opts.normalize(v.filters), opts.filters)) ?? null;
  const lastView = lastViewId ? views.find((v) => v.id === lastViewId) ?? null : null;

  const applyView = (v: SavedView) => {
    opts.apply(opts.normalize(v.filters));
    setLastViewId(v.id);
  };

  const onSave = async () => {
    const name = window.prompt(`Name this ${noun}:`, "");
    if (!name || !name.trim()) return;
    try {
      const r = await api.post<{ view: SavedView }>("/api/views", { screen: opts.screen, name: name.trim(), filters: opts.filters });
      setViews((vs) => [...vs, r.view]);
      setLastViewId(r.view.id);
      toast(`${noun[0]!.toUpperCase()}${noun.slice(1)} "${r.view.name}" saved`, "ok");
    } catch (err) {
      toast(err instanceof ApiError ? err.message : `Failed to save ${noun}`, "danger");
    }
  };

  const onRename = async (v: SavedView) => {
    const name = window.prompt(`Rename ${noun}:`, v.name);
    if (!name || !name.trim() || name.trim() === v.name) return;
    try {
      const r = await api.patch<{ view: SavedView }>(`/api/views/${v.id}`, { name: name.trim() });
      setViews((vs) => vs.map((x) => (x.id === v.id ? r.view : x)));
      toast("Renamed", "ok");
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Rename failed", "danger");
    }
  };

  const onUpdate = async (v: SavedView) => {
    try {
      const r = await api.patch<{ view: SavedView }>(`/api/views/${v.id}`, { filters: opts.filters });
      setViews((vs) => vs.map((x) => (x.id === v.id ? r.view : x)));
      toast(`"${v.name}" updated to current filters`, "ok");
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Update failed", "danger");
    }
  };

  const onDelete = async (v: SavedView) => {
    const r = await confirm({
      title: `Delete ${noun} "${v.name}"?`,
      body: `Only the saved filter preset is removed — no records are touched.`,
      danger: true,
      confirmLabel: `Delete ${noun}`,
    });
    if (!r.ok) return;
    try {
      await api.delete(`/api/views/${v.id}`);
      setViews((vs) => vs.filter((x) => x.id !== v.id));
      if (lastViewId === v.id) setLastViewId(null);
      toast("Deleted", "ok");
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Delete failed", "danger");
    }
  };

  return {
    views,
    activeView,
    isDefault,
    applyView,
    ViewsBarProps: {
      views, activeView, isDefault, lastView,
      onApply: applyView,
      onSave: () => void onSave(),
      onRename: (v) => void onRename(v),
      onUpdate: (v) => void onUpdate(v),
      onDelete: (v) => void onDelete(v),
    },
  };
}

export function ViewsBar({ views, activeView, isDefault, lastView, onApply, onSave, onRename, onUpdate, onDelete, label = "Views", saveLabel = "+ Save current as view" }: ViewsBarData & { label?: string; saveLabel?: string }) {
  if (views.length === 0 && isDefault) return null;
  return (
    <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
      <span style={{ fontFamily: AT.body, fontSize: 10.5, fontWeight: 700, color: AT.inkSoft, textTransform: "uppercase", letterSpacing: "0.07em", marginRight: 2 }}>
        {label}
      </span>
      {views.map((v) => {
        const active = activeView?.id === v.id;
        return (
          <span key={v.id} style={{ display: "inline-flex", alignItems: "center", gap: 3 }}>
            <button onClick={() => onApply(v)} style={viewPillStyle(active)}>{v.name}</button>
            {active && (
              <>
                <MiniBtn title="Rename" onClick={() => onRename(v)}>✎</MiniBtn>
                <MiniBtn title="Delete" onClick={() => onDelete(v)}>×</MiniBtn>
              </>
            )}
          </span>
        );
      })}
      {!isDefault && !activeView && lastView && (
        <button onClick={() => onUpdate(lastView)} style={dashedPillStyle}>Update “{lastView.name}”</button>
      )}
      {!isDefault && !activeView && (
        <button onClick={onSave} style={dashedPillStyle}>{saveLabel}</button>
      )}
    </div>
  );
}

// ── Filter chips ─────────────────────────────────────────────────────────────

export interface FilterChip {
  key: string;
  label: string;
  clear: () => void;
}

export function FilterChips({ chips, onClearAll }: { chips: FilterChip[]; onClearAll: () => void }) {
  if (chips.length === 0) return null;
  return (
    <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
      {chips.map((c) => (
        <button key={c.key} onClick={c.clear} title="Remove filter" style={{
          all: "unset", cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 6,
          padding: "4px 10px", borderRadius: 999, background: AT.accentSoft, color: AT.accent,
          fontFamily: AT.body, fontWeight: 600, fontSize: 12,
        }}>
          {c.label}
          <span style={{ fontWeight: 700 }}>×</span>
        </button>
      ))}
      <button onClick={onClearAll} style={{
        all: "unset", cursor: "pointer", padding: "4px 8px", fontFamily: AT.body,
        fontWeight: 600, fontSize: 12, color: AT.inkSoft, textDecoration: "underline",
      }}>
        Clear all
      </button>
    </div>
  );
}

// ── Search box ───────────────────────────────────────────────────────────────

export function SearchBox({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  return (
    <div style={{ position: "relative", flex: "1 1 220px", minWidth: 200, maxWidth: 340 }}>
      <span style={{ position: "absolute", left: 10, top: 10, color: AT.inkSoft }}>
        <AIcon name="search" size={15} />
      </span>
      <AInput value={value} onChange={onChange} placeholder={placeholder} style={{ paddingLeft: 32 }} />
    </div>
  );
}

// ── Selection ────────────────────────────────────────────────────────────────

export function useSelection<T extends { id: string }>(rows: T[]) {
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(rows.map((r) => r.id)));
  const toggleOne = (id: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const selectedRows = useMemo(() => rows.filter((r) => selected.has(r.id)), [rows, selected]);
  const clear = () => setSelected(new Set());
  return { selected, setSelected, allSelected, toggleAll, toggleOne, selectedRows, clear };
}

// ── Bulk bar ─────────────────────────────────────────────────────────────────

export function BulkBar({ count, children, onClear }: { count: number; children: ReactNode; onClear: () => void }) {
  if (count === 0) return null;
  return (
    <div style={{
      position: "fixed", bottom: 60, left: "50%", transform: "translateX(-50%)", zIndex: 50,
      background: AT.ink, color: "#fff", borderRadius: 12, padding: "9px 12px",
      display: "flex", alignItems: "center", gap: 8, boxShadow: "0 14px 40px rgba(0,0,0,0.28)",
      fontFamily: AT.body,
    }}>
      <span style={{ fontWeight: 700, fontSize: 13, padding: "0 4px" }}>{count} selected</span>
      {children}
      <span style={bulkDividerStyle} />
      <BulkBtn onClick={onClear}>Clear</BulkBtn>
    </div>
  );
}

export function BulkBtn({ children, onClick, danger }: { children: ReactNode; onClick: () => void; danger?: boolean }) {
  return (
    <button onClick={onClick} style={{
      all: "unset", cursor: "pointer", padding: "6px 10px", borderRadius: 8,
      fontFamily: AT.body, fontSize: 12.5, fontWeight: 700,
      color: danger ? "#FCA5A5" : "#fff", background: "rgba(255,255,255,0.12)",
      whiteSpace: "nowrap",
    }}>
      {children}
    </button>
  );
}

export const bulkDividerStyle: CSSProperties = { width: 1, height: 18, background: "rgba(255,255,255,0.22)" };

// ── Export menu ──────────────────────────────────────────────────────────────

export function ExportMenu({ count, scope, onPick, noun = "rows" }: {
  count: number;
  scope: "selected" | "filtered";
  onPick: (fmt: "csv" | "xls" | "pdf") => void;
  noun?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);
  const opts: Array<{ fmt: "xls" | "csv" | "pdf"; label: string; ext: string; icon: IconName }> = [
    { fmt: "xls", label: "Excel", ext: ".xls", icon: "finance" },
    { fmt: "csv", label: "CSV", ext: ".csv", icon: "list" },
    { fmt: "pdf", label: "PDF", ext: ".pdf", icon: "download" },
  ];
  return (
    <div ref={ref} style={{ position: "relative", flexShrink: 0 }}>
      <button onClick={() => setOpen((o) => !o)} style={{
        all: "unset", boxSizing: "border-box", cursor: "pointer", display: "inline-flex",
        alignItems: "center", gap: 7, height: 38, padding: "0 12px", borderRadius: AT.radiusSm,
        border: `1px solid ${AT.rule}`, background: AT.panel, color: AT.ink,
        fontFamily: AT.body, fontWeight: 600, fontSize: 12.5,
      }}>
        <AIcon name="download" size={15} color={AT.ink} />
        Export <span style={{ color: AT.inkSoft, fontFamily: AT.mono, fontSize: 11 }}>{count}</span>
        <span style={{ display: "inline-flex", transform: open ? "rotate(180deg)" : "none", transition: "transform .15s" }}>
          <AIcon name="chevDown" size={13} color={AT.inkSoft} />
        </span>
      </button>
      {open && (
        <div style={{
          position: "absolute", top: "calc(100% + 6px)", right: 0, zIndex: 60, minWidth: 210,
          background: AT.panel, border: `1px solid ${AT.rule}`, borderRadius: AT.radiusSm,
          boxShadow: "0 14px 40px rgba(0,0,0,0.16)", overflow: "hidden", padding: 5,
        }}>
          <div style={{
            padding: "7px 10px 6px", fontFamily: AT.body, fontSize: 10.5, fontWeight: 700,
            letterSpacing: "0.07em", textTransform: "uppercase", color: AT.inkSoft,
          }}>
            {scope === "selected" ? `Download ${count} selected` : `Download ${count} ${noun}`}
          </div>
          {opts.map((o) => (
            <button
              key={o.fmt}
              onClick={() => {
                setOpen(false);
                onPick(o.fmt);
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = AT.surfaceAlt; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
              style={{
                all: "unset", cursor: "pointer", boxSizing: "border-box", width: "100%",
                display: "flex", alignItems: "center", gap: 10, padding: "9px 10px",
                borderRadius: 8, fontFamily: AT.body, fontSize: 13, color: AT.ink,
              }}
            >
              <span style={{
                width: 28, height: 28, borderRadius: 7, background: AT.surfaceAlt,
                display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
              }}>
                <AIcon name={o.icon} size={15} color={AT.ink} />
              </span>
              <span style={{ flex: 1 }}>
                <span style={{ fontWeight: 700 }}>{o.label}</span>{" "}
                <span style={{ color: AT.inkSoft, fontFamily: AT.mono, fontSize: 11 }}>{o.ext}</span>
              </span>
              <AIcon name="download" size={14} color={AT.inkSoft} />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Small shared styles ──────────────────────────────────────────────────────

export const checkboxStyle: CSSProperties = { width: 15, height: 15, accentColor: AT.accent, cursor: "pointer", verticalAlign: "middle" };

export const dateInputStyle: CSSProperties = {
  height: 32, borderRadius: AT.radiusSm, border: `1px solid ${AT.rule}`, background: AT.panel,
  fontFamily: AT.body, fontSize: 12.5, color: AT.ink, padding: "0 8px",
};

export function viewPillStyle(active: boolean): CSSProperties {
  return {
    all: "unset", cursor: "pointer", padding: "5px 11px", borderRadius: 999,
    fontFamily: AT.body, fontWeight: 600, fontSize: 12,
    background: active ? AT.accent : AT.panel, color: active ? "#fff" : AT.ink,
    border: `1px solid ${active ? AT.accent : AT.rule}`,
  };
}

export const dashedPillStyle: CSSProperties = {
  all: "unset", cursor: "pointer", padding: "5px 11px", borderRadius: 999,
  fontFamily: AT.body, fontWeight: 600, fontSize: 12,
  background: "transparent", color: AT.inkSoft, border: `1px dashed ${AT.rule}`,
};

export function MiniBtn({ children, onClick, title }: { children: ReactNode; onClick: () => void; title: string }) {
  return (
    <button title={title} onClick={onClick} style={{
      all: "unset", cursor: "pointer", width: 22, height: 22, borderRadius: 999,
      display: "inline-flex", alignItems: "center", justifyContent: "center",
      fontFamily: AT.body, fontSize: 12, color: AT.inkSoft,
      background: AT.panel, border: `1px solid ${AT.rule}`,
    }}>
      {children}
    </button>
  );
}

// ── Bidder tag chips (shared by Bidders screen + Settings → Tags) ───────────

export interface TagDef {
  id: string;
  name: string;
  color: string;
  position: number;
  active: boolean;
}

/** Palette-key → chip colors, tuned to the operator theme. */
export const TAG_STYLES: Record<string, { bg: string; fg: string }> = {
  gold: { bg: "#FDF1D8", fg: "#9A6B0B" },
  green: { bg: "#E4F4EA", fg: "#1F8A4C" },
  blue: { bg: "#EAEEFF", fg: "#2D4BFF" },
  red: { bg: "#FBE3E3", fg: "#D0282E" },
  orange: { bg: "#FCEFD9", fg: "#C2410C" },
  grey: { bg: "#ECECE9", fg: "#6B6B68" },
};

export function TagChip({ tag, small }: { tag: TagDef; small?: boolean }) {
  const c = TAG_STYLES[tag.color] ?? TAG_STYLES.grey!;
  return (
    <span style={{
      display: "inline-block", background: c.bg, color: c.fg, borderRadius: 5,
      padding: small ? "0 6px" : "1px 8px", fontFamily: AT.body,
      fontSize: small ? 10.5 : 11.5, fontWeight: 700, whiteSpace: "nowrap",
      opacity: tag.active ? 1 : 0.5,
    }}>{tag.name}</span>
  );
}
