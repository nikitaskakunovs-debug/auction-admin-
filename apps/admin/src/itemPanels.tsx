/**
 * Phase W2 shared item panels — the per-item conversation ("Saruna") and the
 * audit+movements timeline ("Vēsture"), used by BOTH the warehouse item card
 * and the admin Inventory drawer. Styled with the shared tokens only, so the
 * same components sit naturally on either surface. Text-only controls (owner
 * rule: no icons in mobile controls).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api.js";
import { useAuth } from "./auth.js";
import { useT, type Lang, type TKey } from "./i18n.js";
import { AT } from "./theme.js";
import { useAuctionEvents } from "./useAuctionEvents.js";

const LOCALE: Record<Lang, string> = { lv: "lv-LV", ru: "ru-RU", en: "en-GB" };

export interface ItemComment {
  id: string;
  userId: string;
  authorLabel: string;
  body: string;
  createdAt: string;
}

export interface ActivityEvent {
  at: string;
  actor: string;
  kind: "audit" | "move";
  action: string;
  detail: Record<string, unknown> | null;
  fromLabel: string | null;
  toLabel: string | null;
}

/** "5 min ago" in the UI language; falls back to the date beyond a week. */
export function relTime(iso: string, lang: Lang): string {
  const locale = LOCALE[lang];
  const min = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto", style: "narrow" });
  if (min < 1) return rtf.format(0, "minute");
  if (min < 60) return rtf.format(-min, "minute");
  const h = Math.round(min / 60);
  if (h < 24) return rtf.format(-h, "hour");
  const d = Math.round(h / 24);
  if (d < 7) return rtf.format(-d, "day");
  return new Date(iso).toLocaleDateString(locale, { day: "2-digit", month: "2-digit" });
}

/**
 * One WS subscription per mounted caller: unread badge counts plus a `bump`
 * counter that ticks on every 'item_comment' event so open threads refetch.
 */
export function useCommentsLive(): { unread: Map<string, number>; bump: number; refreshUnread: () => void } {
  const [unread, setUnread] = useState<Map<string, number>>(() => new Map());
  const [bump, setBump] = useState(0);
  const refreshUnread = useCallback(() => {
    void api
      .get<{ unread: Array<{ itemId: string; sku: string; count: number }> }>("/api/comments/unread")
      .then((r) => setUnread(new Map(r.unread.map((u) => [u.itemId, u.count]))))
      .catch(() => undefined);
  }, []);
  useEffect(refreshUnread, [refreshUnread]);
  useAuctionEvents("admin", (ev) => {
    if (ev.type === "item_comment") {
      setBump((b) => b + 1);
      refreshUnread();
    }
  });
  return { unread, bump, refreshUnread };
}

/**
 * The "Saruna" thread: chronological comments, own messages accent-marked and
 * right-aligned, optimistic composer at the bottom. Opening (mounting) marks
 * the thread read; a `bump` change (live 'item_comment' event) refetches and
 * re-marks while the thread stays open.
 */
export function CommentsThread({ itemId, bump = 0, onRead }: {
  itemId: string;
  bump?: number;
  onRead?: () => void;
}) {
  const { user } = useAuth();
  const { t, lang } = useT();
  const [comments, setComments] = useState<ItemComment[] | null>(null);
  const [text, setText] = useState("");
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const listRef = useRef<HTMLDivElement | null>(null);
  const onReadRef = useRef(onRead);
  onReadRef.current = onRead;

  useEffect(() => {
    let alive = true;
    void api
      .get<{ comments: ItemComment[] }>(`/api/items/${itemId}/comments`)
      .then((r) => {
        if (!alive) return;
        setComments(r.comments);
        void api.post(`/api/items/${itemId}/comments/read`).then(() => onReadRef.current?.()).catch(() => undefined);
      })
      .catch(() => alive && setComments([]));
    return () => {
      alive = false;
    };
  }, [itemId, bump]);

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [comments?.length]);

  const send = async () => {
    const body = text.trim();
    if (!body || busy) return;
    const temp: ItemComment = {
      id: `tmp-${Date.now()}`,
      userId: user?.id ?? "",
      authorLabel: user?.name ?? "",
      body,
      createdAt: new Date().toISOString(),
    };
    setComments((c) => [...(c ?? []), temp]);
    setText("");
    setFailed(false);
    setBusy(true);
    try {
      const r = await api.post<{ comment: ItemComment }>(`/api/items/${itemId}/comments`, { body });
      setComments((c) => (c ?? []).map((x) => (x.id === temp.id ? r.comment : x)));
    } catch {
      setComments((c) => (c ?? []).filter((x) => x.id !== temp.id));
      setText(body); // give the draft back
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: "grid", gap: 10 }}>
      <div ref={listRef} style={{ maxHeight: 320, overflowY: "auto", display: "grid", gap: 8 }}>
        {comments === null && <div style={{ color: AT.inkSoft, fontSize: 13, fontFamily: AT.body }}>…</div>}
        {comments !== null && comments.length === 0 && (
          <div style={{ color: AT.inkSoft, fontSize: 13, fontFamily: AT.body }}>{t("wh.chatEmpty")}</div>
        )}
        {comments?.map((c) => {
          const mine = c.userId === user?.id;
          return (
            <div key={c.id} style={{ display: "grid", justifyItems: mine ? "end" : "start" }}>
              <div style={{
                maxWidth: "88%", borderRadius: 10, padding: "7px 11px", fontFamily: AT.body,
                background: mine ? AT.accentSoft : AT.surfaceAlt,
                border: `1px solid ${mine ? "rgba(45,75,255,0.28)" : AT.ruleSoft}`,
              }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: mine ? AT.accent : AT.inkSoft, display: "flex", gap: 8, alignItems: "baseline" }}>
                  <span>{c.authorLabel}</span>
                  <span style={{ fontWeight: 500 }}>{relTime(c.createdAt, lang)}</span>
                </div>
                <div style={{ fontSize: 13.5, color: AT.ink, lineHeight: 1.45, whiteSpace: "pre-wrap", overflowWrap: "anywhere", marginTop: 2 }}>
                  {c.body}
                </div>
              </div>
            </div>
          );
        })}
      </div>
      {failed && <div style={{ fontSize: 12, fontWeight: 700, color: AT.danger, fontFamily: AT.body }}>{t("wh.sendFailed")}</div>}
      <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={2}
          maxLength={2000}
          placeholder={t("wh.chatPlaceholder")}
          style={{
            flex: 1, boxSizing: "border-box", borderRadius: 10, border: `1.5px solid ${AT.rule}`,
            fontFamily: AT.body, fontSize: 14, color: AT.ink, padding: 10, resize: "vertical", minHeight: 48,
            outline: "none", background: "#fff",
          }}
        />
        <button
          onClick={() => void send()}
          disabled={busy || text.trim().length === 0}
          style={{
            all: "unset", boxSizing: "border-box", cursor: "pointer", borderRadius: 10, padding: "0 16px",
            minHeight: 48, display: "inline-flex", alignItems: "center", fontFamily: AT.body,
            fontSize: 13.5, fontWeight: 700, background: AT.ink, color: "#fff",
            opacity: busy || text.trim().length === 0 ? 0.5 : 1,
          }}
        >{t("wh.send")}</button>
      </div>
    </div>
  );
}

/**
 * The "Vēsture" timeline — GET /api/items/:id/activity (audit + stock
 * movements merged, newest first), with the W2 grading events rendered
 * readably: graded → grade, edited → was → now, rejected → reason.
 */
export function ActivityTimeline({ itemId, limit = 30 }: { itemId: string; limit?: number }) {
  const { t, lang } = useT();
  const [events, setEvents] = useState<ActivityEvent[] | null>(null);

  useEffect(() => {
    setEvents(null);
    void api
      .get<{ events: ActivityEvent[] }>(`/api/items/${itemId}/activity`)
      .then((r) => setEvents(r.events))
      .catch(() => setEvents([]));
  }, [itemId]);

  const verb = (e: ActivityEvent): string => {
    try {
      return t(`act.${e.action}` as TKey);
    } catch {
      return e.action.replace(/_/g, " ");
    }
  };

  const extra = (e: ActivityEvent): string => {
    const d = e.detail;
    if (e.kind === "move" && (e.fromLabel || e.toLabel)) return ` ${e.fromLabel ?? "—"} → ${e.toLabel ?? "—"}`;
    if (e.action === "transition" && d) return ` ${String(d.from ?? "")} → ${String(d.to ?? "")}`;
    if (e.action === "photos_added" && d?.count) return ` (${String(d.count)})`;
    if (e.action === "graded" && d?.condition) return ` — ${String(d.condition).replace(/_/g, " ")}`;
    if (e.action === "grade_approved" && d?.condition) return ` — ${String(d.condition).replace(/_/g, " ")}`;
    if (e.action === "grade_edited" && d) {
      const was = (d.old as { condition?: string } | undefined)?.condition;
      const now = (d.new as { condition?: string } | undefined)?.condition;
      if (was || now) return ` — ${String(was ?? "?").replace(/_/g, " ")} → ${String(now ?? "?").replace(/_/g, " ")}`;
    }
    if (e.action === "grade_rejected" && d?.reason) return ` — ${String(d.reason)}`;
    return "";
  };

  const fmt = (iso: string) =>
    new Date(iso).toLocaleString(LOCALE[lang], { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

  return (
    <div style={{ display: "grid", fontFamily: AT.body }}>
      {events === null && <div style={{ color: AT.inkSoft, fontSize: 13 }}>…</div>}
      {events !== null && events.length === 0 && <div style={{ color: AT.inkSoft, fontSize: 13 }}>{t("wh.historyEmpty")}</div>}
      {events !== null && events.slice(0, limit).map((e, i) => (
        <div key={`${e.at}-${i}`} style={{
          display: "flex", gap: 10, alignItems: "baseline", padding: "8px 0",
          borderTop: i === 0 ? "none" : `1px solid ${AT.ruleSoft}`,
        }}>
          <span style={{ fontFamily: AT.mono, fontSize: 11.5, color: AT.inkSoft, flexShrink: 0 }}>{fmt(e.at)}</span>
          <span style={{ fontSize: 13, lineHeight: 1.4 }}>
            <b>{e.actor}</b> {verb(e)}
            <span style={{ fontFamily: AT.mono, fontSize: 12 }}>{extra(e)}</span>
          </span>
        </div>
      ))}
    </div>
  );
}
