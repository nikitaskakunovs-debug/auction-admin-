/**
 * W4 — the counter workstation ("Lete"). One search box answers the desk's
 * real question ("what do I do with this person?"): who they are, what they
 * can take home now, what they still owe, and what blocks them — with the
 * actions attached to that one card.
 */
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { api, ApiError } from "../api.js";
import type { Nav } from "../App.js";
import { useAuth } from "../auth.js";
import { formatDate, formatEur } from "../format.js";
import { orderStatusLabel, useT, type TKey } from "../i18n.js";
import { AT } from "../theme.js";
import { openLabelWindow as openPrintWindow } from "../labels.js";
import {
  AAvatar, ABadge, ABtn, ACard, ADrawer, AEmpty, AField, AIcon, AInput, ATable, ATd, ATr,
  useConfirm, useToast,
} from "../ui.js";
import { useIsMobile } from "../useMobile.js";

interface DeskOrder {
  id: string;
  ref: string;
  totalCents: number;
  status: string;
  fulfilment: string;
  paymentDeadlineAt: string | null;
  pickupDeadlineAt: string | null;
  itemTitle: string;
  itemSku: string;
  location: string;
  /** Last two digits only — the full code is behind an audited reveal. */
  pickupCodeMasked?: string | null;
}

interface DeskFee {
  id: string;
  amountCents: number;
  type: string;
  orderRef: string;
  note: string | null;
}

interface DeskMatch {
  id: string;
  alias: string;
  name: string | null;
  email: string;
  blocked: boolean;
}

/** The client's live queue ticket, when they are already in the room. */
interface DeskTicket {
  id: string;
  number: number;
  status: string;
  checkedInAt: string;
}

interface DeskResult {
  matches: DeskMatch[];
  ticket?: DeskTicket | null;
  customer?: {
    id: string;
    alias: string;
    name: string | null;
    email: string;
    country: string | null;
    strikes: number;
    blocked: boolean;
    blockedReason: string | null;
    tags: string[];
  };
  collectable?: DeskOrder[];
  awaitingPayment?: DeskOrder[];
  fees?: DeskFee[];
  dueCents?: number;
}

type Method = "cash" | "card_terminal";

// ── R2: returns at the counter ───────────────────────────────────────────────
// The client is standing here with the item in their hands, so the whole flow
// lives on this card: what they took home, why it came back, and — for whoever
// holds orders.refund — the decision, with their earlier returns in view.

/** One collected line the client could bring back (GET /api/desk/returnable). */
interface ReturnLine {
  orderId: string;
  orderRef: string;
  itemId: string;
  sku: string;
  title: string;
  totalCents: number;
  refundableCents: number;
  deliveredAt: string | null;
  daysLeft: number;
  withinWindow: boolean;
  alreadyReturned: boolean;
}

type ReturnReason = "not_as_described" | "damaged" | "changed_mind" | "other";
type Decision = "refund_full" | "refund_partial" | "rejected";
type Destination = "quarantine" | "stock" | "write_off" | "kept_by_buyer";

interface ReturnCase {
  id: string;
  ref: string;
  status?: string;
  decision?: Decision | null;
  refundCents?: number | null;
  destination?: Destination | null;
  resolvedAt?: string | null;
}

interface ReturnDetail {
  case: ReturnCase;
  item: { sku: string; title: string } | null;
  order: { ref?: string; totalCents: number; refundedCents: number };
  /** Everything this customer has sent back before — the reason this screen exists. */
  history: Array<{ ref: string; itemTitle: string; decision: string; resolvedAt: string | null }>;
}

const REASONS: Array<{ id: ReturnReason; label: TKey }> = [
  { id: "not_as_described", label: "fd.ret.r.not_as_described" },
  { id: "damaged", label: "fd.ret.r.damaged" },
  { id: "changed_mind", label: "fd.ret.r.changed_mind" },
  { id: "other", label: "fd.ret.r.other" },
];

/** Quarantine leads: an item came back for a reason, so it gets one check
 * before it is offered to the next bidder. */
const DESTINATIONS: Array<{ id: Destination; label: TKey }> = [
  { id: "quarantine", label: "fd.ret.dst.quarantine" },
  { id: "stock", label: "fd.ret.dst.stock" },
  { id: "write_off", label: "fd.ret.dst.write_off" },
  { id: "kept_by_buyer", label: "fd.ret.dst.kept_by_buyer" },
];

const DECISION_LABEL: Record<string, TKey> = {
  refund_full: "fd.ret.d.refund_full",
  refund_partial: "fd.ret.d.refund_partial",
  rejected: "fd.ret.d.rejected",
};

const decisionLabel = (t: (k: TKey) => string, decision: string): string => {
  const key = DECISION_LABEL[decision];
  return key ? t(key) : decision.replace(/_/g, " ");
};

const destinationLabel = (t: (k: TKey) => string, id: Destination): string =>
  t(DESTINATIONS.find((d) => d.id === id)?.label ?? "fd.ret.dst.quarantine");

/** The server's named failure, or "" for anything that isn't one. */
const errCode = (err: unknown): string =>
  err instanceof ApiError && typeof err.body.error === "string" ? err.body.error : "";

/** Joins sentence fragments, dropping the ones a language leaves empty. */
const words = (...parts: string[]): string => parts.filter((p) => p !== "").join(" ");

const eurToCents = (v: string): number => Math.round(parseFloat(v.replace(",", ".")) * 100);

const areaStyle: CSSProperties = {
  width: "100%", borderRadius: AT.radiusSm, border: `1px solid ${AT.rule}`, fontFamily: AT.body,
  fontSize: 13, color: AT.ink, padding: 10, resize: "vertical",
};

export function FrontDeskScreen({ nav }: { nav: Nav }) {
  const { t } = useT();
  const { can } = useAuth();
  const toast = useToast();
  const confirm = useConfirm();
  const mobile = useIsMobile();
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<DeskResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [paying, setPaying] = useState(false);
  const [method, setMethod] = useState<Method>("cash");
  const [picked, setPicked] = useState<{ orders: Set<string>; fees: Set<string> }>({ orders: new Set(), fees: new Set() });
  const box = useRef<HTMLDivElement>(null);
  // R2 — returns live inside the same customer payload.
  const [returnable, setReturnable] = useState<ReturnLine[]>([]);
  const [returnsFailed, setReturnsFailed] = useState(false);
  const [starting, setStarting] = useState<ReturnLine | null>(null);
  const [openCase, setOpenCase] = useState<{ id: string; line: ReturnLine | null } | null>(null);

  const canTakeMoney = can("orders.mark_paid");
  const canReturn = can("pickup.operate");
  const canDecide = can("orders.refund");
  const customerId = result?.customer?.id ?? null;

  // The desk always starts ready to type — a scanner "types" the code too.
  useEffect(() => {
    box.current?.querySelector("input")?.focus();
  }, []);

  const search = async (q: string, quiet = false) => {
    if (q.trim().length < 2) return;
    setBusy(true);
    try {
      const r = await api.get<DeskResult>(`/api/desk/search?q=${encodeURIComponent(q.trim())}`);
      setResult(r);
      // Preselect everything owed — the common case is "pay it all".
      setPicked({
        orders: new Set((r.awaitingPayment ?? []).map((o) => o.id)),
        fees: new Set((r.fees ?? []).map((f) => f.id)),
      });
      if (!quiet && r.matches.length === 0) toast(t("fd.noMatch"), "warn");
    } catch (err) {
      toast(err instanceof ApiError ? err.message : t("c.error"), "danger");
    } finally {
      setBusy(false);
    }
  };

  const openPerson = (id: string) => void search(id === "" ? query : id);

  const checkIn = async () => {
    if (!result?.customer) return;
    try {
      const r = await api.post<{ number: number; alreadyCheckedIn: boolean }>("/api/pickup/checkin", {
        customerId: result.customer.id,
      });
      toast(`${t("fd.ticket")} ${r.number}${r.alreadyCheckedIn ? ` · ${t("fd.alreadyIn")}` : ""}`, "ok");
      nav.go("pickup");
    } catch (err) {
      toast(err instanceof ApiError ? err.message : t("c.error"), "danger");
    }
  };

  const selectedCents =
    (result?.awaitingPayment ?? []).filter((o) => picked.orders.has(o.id)).reduce((n, o) => n + o.totalCents, 0) +
    (result?.fees ?? []).filter((f) => picked.fees.has(f.id)).reduce((n, f) => n + f.amountCents, 0);

  const takePayment = async () => {
    if (selectedCents === 0) return;
    setBusy(true);
    try {
      const r = await api.post<{ ok: boolean; takenCents: number; failed: Array<{ reason: string }> }>("/api/desk/pay", {
        orderIds: [...picked.orders],
        feeIds: [...picked.fees],
        method,
      });
      toast(`${t("fd.taken")} ${formatEur(r.takenCents)}`, r.ok ? "ok" : "warn");
      setPaying(false);
      await search(result?.customer?.id ?? query, true);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : t("c.error"), "danger");
    } finally {
      setBusy(false);
    }
  };

  const receipt = (orderId: string) => {
    void openPrintWindow(`/api/desk/orders/${orderId}/receipt`, (m) => toast(m, "danger"));
  };

  const loadReturnable = useCallback(async (id: string) => {
    try {
      const r = await api.get<{ lines: ReturnLine[] }>(`/api/desk/returnable?customerId=${encodeURIComponent(id)}`);
      setReturnable(r.lines ?? []);
      setReturnsFailed(false);
    } catch {
      // A returns hiccup must not take the rest of the desk down with it.
      setReturnable([]);
      setReturnsFailed(true);
    }
  }, []);

  useEffect(() => {
    if (!customerId || !canReturn) {
      setReturnable([]);
      setReturnsFailed(false);
      return;
    }
    void loadReturnable(customerId);
  }, [customerId, canReturn, loadReturnable]);

  /** A return moves money and stock — re-read the payload so what the desk
   * shows as owed and collectable is still true afterwards. */
  const refreshAfterReturn = async () => {
    if (!customerId) return;
    await search(customerId, true);
    await loadReturnable(customerId);
  };

  const c = result?.customer;
  const collectable = result?.collectable ?? [];
  const ticket = result?.ticket ?? null;

  /** Show one order's collection code. Every reveal is written to the audit
   * trail with the reason, so helping a client is easy and quiet misuse is
   * not possible. */
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  const revealCode = async (orderId: string) => {
    const res = await confirm({
      title: t("fd.revealTitle"),
      body: t("fd.revealBody"),
      requireReason: true,
      confirmLabel: t("fd.revealBtn"),
    });
    if (!res.ok) return;
    try {
      const r = await api.post<{ pickupCode: string }>(`/api/desk/orders/${orderId}/reveal-code`, { reason: res.reason });
      setRevealed((m) => ({ ...m, [orderId]: r.pickupCode }));
    } catch (err) {
      toast((err as Error).message || t("wh.actionFailed"), "danger");
    }
  };
  const awaiting = result?.awaitingPayment ?? [];
  const fees = result?.fees ?? [];

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <h1 style={{ fontFamily: AT.body, fontSize: 20, fontWeight: 700, color: AT.ink, flex: 1 }}>{t("fd.title")}</h1>
        <ABtn kind="ghost" size="sm" onClick={() => nav.go("pickup")}>
          <AIcon name="activity" size={13} /> {t("fd.toQueue")}
        </ABtn>
      </div>

      {/* One box: surname, alias, email, order ref or the client's code. */}
      <div
        ref={box}
        onKeyDown={(e) => {
          // Enter submits — a hardware scanner types the code then Enter too.
          if (e.key === "Enter") void search(query);
        }}
        style={{ display: "flex", gap: 8, alignItems: "center" }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <AInput value={query} onChange={setQuery} placeholder={t("fd.searchPlaceholder")} autoFocus />
        </div>
        <ABtn onClick={() => void search(query)} disabled={busy || query.trim().length < 2}>
          {busy ? t("c.loading") : t("c.search")}
        </ABtn>
      </div>

      {/* Several people can share a surname — pick one. */}
      {result && result.matches.length > 1 && (
        <ACard title={t("fd.several")} pad={false}>
          <ATable head={[t("fd.person"), t("ms.k.email"), ""]}>
            {result.matches.map((m) => (
              <ATr key={m.id} onClick={() => openPerson(m.id)}>
                <ATd>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                    <AAvatar name={m.alias} size={22} />
                    <span style={{ fontWeight: 600 }}>{m.name || m.alias}</span>
                  </span>
                </ATd>
                <ATd>{m.email}</ATd>
                <ATd right>{m.blocked ? <ABadge tone="danger">{t("cust.st.blocked")}</ABadge> : null}</ATd>
              </ATr>
            ))}
          </ATable>
        </ACard>
      )}

      {/* "Not found" is usually "that person isn't a client" — say so, and
          point at the two things staff actually do next. */}
      {result && result.matches.length === 0 && (
        <ACard>
          <div style={{ display: "grid", gap: 10, padding: "18px 4px", justifyItems: "center", textAlign: "center" }}>
            <div style={{ fontFamily: AT.body, fontSize: 14, fontWeight: 600, color: AT.ink }}>{t("fd.noMatch")}</div>
            <div style={{ fontFamily: AT.body, fontSize: 12.5, color: AT.inkSoft, maxWidth: 460 }}>{t("fd.noMatchHint")}</div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "center", marginTop: 4 }}>
              <ABtn kind="ghost" size="sm" onClick={() => nav.go("customers")}>{t("fd.openBidders")}</ABtn>
            </div>
          </div>
        </ACard>
      )}

      {c && (
        <>
          {/* The number the client was given, in the size they said it out
              loud. Anyone walking up says "I am 119" — this is the answer. */}
          {ticket && (
            <ACard>
              <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
                <div style={{
                  minWidth: 96, padding: "10px 18px", borderRadius: 12, background: AT.accentSoft,
                  display: "grid", justifyItems: "center",
                }}>
                  <span style={{ fontSize: 11, letterSpacing: ".12em", color: AT.accent, fontFamily: AT.body, fontWeight: 700 }}>
                    {t("fd.ticketWord")}
                  </span>
                  <span style={{ fontFamily: AT.mono, fontSize: 34, fontWeight: 800, color: AT.accent, lineHeight: 1.1 }}>
                    #{ticket.number}
                  </span>
                </div>
                <div style={{ flex: 1, minWidth: 160, display: "grid", gap: 4, justifyItems: "start" }}>
                  <ABadge tone={ticket.status === "delivering" ? "ok" : ticket.status === "picking" ? "neutral" : "warn"}>
                    {t(ticket.status === "delivering" ? "wh.status.delivering" : ticket.status === "picking" ? "wh.status.picking" : "wh.status.waiting")}
                  </ABadge>
                  <span style={{ fontSize: 12.5, color: AT.inkSoft, fontFamily: AT.body }}>
                    {t("fd.inQueueSince")} {formatDate(ticket.checkedInAt)}
                  </span>
                </div>
                <ABtn kind="ghost" size="sm" onClick={() => nav.go("pickup")}>{t("fd.openQueue")}</ABtn>
              </div>
            </ACard>
          )}

          <ACard>
            <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
              <AAvatar name={c.alias} size={40} />
              <div style={{ flex: 1, minWidth: 160 }}>
                <div style={{ fontSize: 15.5, fontWeight: 700, color: AT.ink }}>
                  {c.name || c.alias} <span style={{ fontFamily: AT.mono, fontSize: 12, color: AT.inkSoft }}>{c.alias}</span>
                </div>
                <div style={{ fontSize: 12.5, color: AT.inkSoft }}>
                  {c.email}
                  {c.country ? ` · ${c.country}` : ""}
                  {c.strikes > 0 ? ` · ${t("cust.th.strikes")}: ${c.strikes}` : ""}
                </div>
              </div>
              {c.blocked && <ABadge tone="danger">{t("cust.st.blocked")}</ABadge>}
              {(result?.dueCents ?? 0) > 0 && <ABadge tone="warn">{t("fd.due")} {formatEur(result!.dueCents!)}</ABadge>}
            </div>
            {c.blocked && c.blockedReason && (
              <div style={{ marginTop: 10, fontSize: 12.5, color: AT.danger }}>{c.blockedReason}</div>
            )}
          </ACard>

          <ACard title={`${t("fd.collectable")} · ${collectable.length}`} pad={false}>
            {collectable.length === 0 ? (
              <AEmpty text={t("fd.nothingToCollect")} />
            ) : (
              <ATable head={[t("ord.thOrder"), t("c.title"), t("c.location"), t("fd.code"), ""]}>
                {collectable.map((o) => (
                  <ATr key={o.id}>
                    <ATd mono>{o.ref}</ATd>
                    <ATd>
                      <div style={{ fontWeight: 600 }}>{o.itemTitle}</div>
                      <div style={{ fontFamily: AT.mono, fontSize: 11, color: AT.inkSoft }}>{o.itemSku}</div>
                    </ATd>
                    <ATd mono>{o.location || "—"}</ATd>
                    <ATd>
                      {revealed[o.id] ? (
                        <span style={{ fontFamily: AT.mono, fontWeight: 800, fontSize: 15, color: AT.ink, letterSpacing: ".08em" }}>
                          {revealed[o.id]}
                        </span>
                      ) : o.pickupCodeMasked ? (
                        <span style={{ display: "inline-flex", alignItems: "center", gap: 7 }}>
                          <span style={{ fontFamily: AT.mono, color: AT.inkSoft }}>{o.pickupCodeMasked}</span>
                          <ABtn kind="ghost" size="sm" onClick={() => void revealCode(o.id)}>{t("fd.reveal")}</ABtn>
                        </span>
                      ) : (
                        "—"
                      )}
                    </ATd>
                    <ATd right>
                      <ABtn kind="ghost" size="sm" onClick={() => receipt(o.id)}>{t("fd.receipt")}</ABtn>
                    </ATd>
                  </ATr>
                ))}
              </ATable>
            )}
          </ACard>

          {(awaiting.length > 0 || fees.length > 0) && (
            <ACard title={t("fd.toSettle")} pad={false}>
              <ATable head={["", t("ord.thOrder"), t("c.title"), t("c.status"), t("c.total")]}>
                {awaiting.map((o) => (
                  <ATr key={o.id}>
                    <ATd style={{ width: 34 }}>
                      <input
                        type="checkbox"
                        checked={picked.orders.has(o.id)}
                        onChange={() =>
                          setPicked((p) => {
                            const next = new Set(p.orders);
                            next.has(o.id) ? next.delete(o.id) : next.add(o.id);
                            return { ...p, orders: next };
                          })
                        }
                        aria-label={o.ref}
                      />
                    </ATd>
                    <ATd mono>{o.ref}</ATd>
                    <ATd>
                      <div style={{ fontWeight: 600 }}>{o.itemTitle}</div>
                      {o.paymentDeadlineAt && (
                        <div style={{ fontSize: 11, color: AT.inkSoft }}>
                          {t("ms.k.deadline")}: {formatDate(o.paymentDeadlineAt)}
                        </div>
                      )}
                    </ATd>
                    <ATd><ABadge tone="warn">{orderStatusLabel(o.status)}</ABadge></ATd>
                    <ATd mono right><strong>{formatEur(o.totalCents)}</strong></ATd>
                  </ATr>
                ))}
                {fees.map((f) => (
                  <ATr key={f.id}>
                    <ATd style={{ width: 34 }}>
                      <input
                        type="checkbox"
                        checked={picked.fees.has(f.id)}
                        onChange={() =>
                          setPicked((p) => {
                            const next = new Set(p.fees);
                            next.has(f.id) ? next.delete(f.id) : next.add(f.id);
                            return { ...p, fees: next };
                          })
                        }
                        aria-label={f.orderRef}
                      />
                    </ATd>
                    <ATd mono>{f.orderRef}</ATd>
                    <ATd>{t("fd.restockFee")}</ATd>
                    <ATd><ABadge tone="danger">{t("fd.blocksAccount")}</ABadge></ATd>
                    <ATd mono right><strong>{formatEur(f.amountCents)}</strong></ATd>
                  </ATr>
                ))}
              </ATable>
            </ACard>
          )}

          {/* R2 — what this client could bring back, and the case that starts here. */}
          {canReturn && (
            <ACard title={`${t("fd.ret.section")} · ${returnable.length}`} pad={false}>
              {returnsFailed ? (
                <AEmpty text={t("fd.ret.loadFailed")} />
              ) : returnable.length === 0 ? (
                <AEmpty text={t("fd.ret.none")} />
              ) : (
                <ATable head={[t("ord.thOrder"), t("c.title"), t("fd.ret.paid"), t("fd.ret.window"), ""]}>
                  {returnable.map((l) => {
                    // Done is done: a returned line stays visible (staff ask
                    // about it) but reads as history and can't be reopened.
                    const dim: CSSProperties | undefined = l.alreadyReturned ? { opacity: 0.5 } : undefined;
                    return (
                      <ATr key={`${l.orderId}:${l.itemId}`}>
                        <ATd mono style={dim}>{l.orderRef}</ATd>
                        <ATd style={dim}>
                          <div style={{ fontWeight: 600 }}>{l.title}</div>
                          <div style={{ fontFamily: AT.mono, fontSize: 11, color: AT.inkSoft }}>{l.sku}</div>
                        </ATd>
                        <ATd mono style={dim}>{formatEur(l.totalCents)}</ATd>
                        <ATd style={dim}><WindowPill daysLeft={l.daysLeft} /></ATd>
                        <ATd right>
                          {l.alreadyReturned ? (
                            <span style={{ fontFamily: AT.body, fontSize: 12, color: AT.inkSoft }}>{t("fd.ret.already")}</span>
                          ) : (
                            <ABtn kind="ghost" size="sm" onClick={() => setStarting(l)}>{t("fd.ret.start")}</ABtn>
                          )}
                        </ATd>
                      </ATr>
                    );
                  })}
                </ATable>
              )}
            </ACard>
          )}

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", position: mobile ? "sticky" : "static", bottom: 0 }}>
            <ABtn size="lg" onClick={() => void checkIn()} disabled={collectable.length === 0}>
              {t("fd.checkIn")}
            </ABtn>
            {canTakeMoney && selectedCents > 0 && (
              <ABtn kind="dark" size="lg" onClick={() => setPaying(true)}>
                {t("fd.takePayment")} {formatEur(selectedCents)}
              </ABtn>
            )}
            <ABtn kind="ghost" size="lg" onClick={() => nav.go("customers")}>{t("fd.openProfile")}</ABtn>
          </div>
        </>
      )}

      {paying && (
        <PayDialog
          amountCents={selectedCents}
          method={method}
          setMethod={setMethod}
          busy={busy}
          onCancel={() => setPaying(false)}
          onConfirm={() => void takePayment()}
        />
      )}

      {starting && (
        <StartReturnDrawer
          line={starting}
          onClose={() => setStarting(null)}
          onOpened={(id, line) => {
            setStarting(null);
            setOpenCase({ id, line });
            void refreshAfterReturn();
          }}
        />
      )}

      {openCase && (
        <ReturnCaseDrawer
          caseId={openCase.id}
          line={openCase.line}
          canDecide={canDecide}
          onClose={() => setOpenCase(null)}
          onResolved={() => {
            setOpenCase(null);
            void refreshAfterReturn();
          }}
        />
      )}
    </div>
  );
}

/** How much of the 14-day window is left — the one fact that decides whether
 * this is a routine return or one that needs a manager's justification. */
function WindowPill({ daysLeft }: { daysLeft: number }) {
  const { t } = useT();
  if (daysLeft < 0) {
    const over = -daysLeft;
    return (
      <ABadge tone="danger">
        {over === 1 ? t("fd.ret.overdueOne") : words(t("fd.ret.overduePre"), String(over), t("fd.ret.overduePost"))}
      </ABadge>
    );
  }
  if (daysLeft === 0) return <ABadge tone="ok">{t("fd.ret.lastDay")}</ABadge>;
  if (daysLeft === 1) return <ABadge tone="ok">{t("fd.ret.daysLeftOne")}</ABadge>;
  return <ABadge tone="ok">{words(t("fd.ret.daysLeftPre"), String(daysLeft), t("fd.ret.daysLeftPost"))}</ABadge>;
}

/** Selectable chip — same vocabulary as the payment-method buttons below. */
function Chip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        all: "unset", cursor: "pointer", padding: "8px 14px", borderRadius: 999,
        fontFamily: AT.body, fontSize: 13, fontWeight: 700,
        background: active ? AT.ink : AT.panel, color: active ? "#fff" : AT.ink,
        border: `1px solid ${active ? AT.ink : AT.rule}`,
      }}
    >
      {label}
    </button>
  );
}

function FieldError({ text }: { text: string }) {
  return <div style={{ fontFamily: AT.body, fontSize: 11.5, color: AT.danger, marginTop: 4 }}>{text}</div>;
}

function Fact({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div>
      <div style={{
        fontFamily: AT.body, fontSize: 10.5, fontWeight: 700, color: AT.inkSoft,
        textTransform: "uppercase", letterSpacing: "0.06em",
      }}>{label}</div>
      <div style={{ fontFamily: AT.mono, fontSize: 13, fontWeight: strong ? 800 : 600, color: AT.ink, marginTop: 2 }}>{value}</div>
    </div>
  );
}

/**
 * Starting a case asks two questions: why the item came back and — only when
 * the window has already closed — why we are taking it anyway. The second
 * answer is what a manager reads later, so it can't be skipped.
 */
function StartReturnDrawer({ line, onClose, onOpened }: {
  line: ReturnLine;
  onClose: () => void;
  onOpened: (caseId: string, line: ReturnLine) => void;
}) {
  const { t } = useT();
  const toast = useToast();
  const [reason, setReason] = useState<ReturnReason | null>(null);
  const [note, setNote] = useState("");
  const [override, setOverride] = useState("");
  const [overrideErr, setOverrideErr] = useState(false);
  const [busy, setBusy] = useState(false);

  const late = !line.withinWindow;

  const submit = async () => {
    if (!reason) return;
    if (late && override.trim().length === 0) {
      setOverrideErr(true);
      return;
    }
    setBusy(true);
    try {
      const r = await api.post<{ case: ReturnCase }>("/api/returns", {
        orderId: line.orderId,
        itemId: line.itemId,
        reason,
        ...(note.trim() ? { note: note.trim() } : {}),
        ...(late ? { overrideReason: override.trim() } : {}),
      });
      toast(t("fd.ret.started"), "ok");
      onOpened(r.case.id, line);
    } catch (err) {
      const code = errCode(err);
      if (code === "override_reason_required") {
        setOverrideErr(true);
        toast(t("fd.ret.lateRequired"), "danger");
      } else if (code === "already_open") {
        toast(t("fd.ret.alreadyOpen"), "warn");
      } else {
        toast(err instanceof ApiError ? err.message : t("fd.ret.startFailed"), "danger");
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <ADrawer
      title={`${t("fd.ret.start")} · ${line.sku}`}
      onClose={onClose}
      footer={
        <>
          <ABtn kind="ghost" onClick={onClose}>{t("c.cancel")}</ABtn>
          <ABtn kind="dark" disabled={busy || !reason} onClick={() => void submit()}>
            {busy ? t("c.saving") : t("fd.ret.start")}
          </ABtn>
        </>
      }
    >
      <div style={{ display: "grid", gap: 16 }}>
        <div style={{ background: AT.surfaceAlt, borderRadius: AT.radiusSm, padding: "12px 14px" }}>
          <div style={{ fontFamily: AT.body, fontSize: 13.5, fontWeight: 700, color: AT.ink }}>{line.title}</div>
          <div style={{ fontFamily: AT.mono, fontSize: 11.5, color: AT.inkSoft, marginTop: 3 }}>
            {line.sku} · {line.orderRef} · {formatEur(line.totalCents)}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
            <WindowPill daysLeft={line.daysLeft} />
            <span style={{ fontFamily: AT.body, fontSize: 11.5, color: AT.inkSoft }}>{formatDate(line.deliveredAt)}</span>
          </div>
        </div>

        <div>
          <div style={{ fontFamily: AT.body, fontSize: 12, fontWeight: 700, color: AT.ink, marginBottom: 8 }}>{t("fd.ret.why")}</div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {REASONS.map((r) => (
              <Chip key={r.id} label={t(r.label)} active={reason === r.id} onClick={() => setReason(r.id)} />
            ))}
          </div>
        </div>

        <AField label={t("fd.ret.note")}>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={3}
            placeholder={t("fd.ret.notePlaceholder")}
            style={areaStyle}
          />
        </AField>

        {late && (
          <AField label={`${t("fd.ret.lateTitle")} · ${t("c.required")}`} hint={t("fd.ret.lateHint")}>
            <AInput
              value={override}
              onChange={(v) => {
                setOverride(v);
                if (v.trim()) setOverrideErr(false);
              }}
              style={overrideErr ? { border: `1px solid ${AT.danger}` } : undefined}
            />
            {overrideErr && <FieldError text={t("fd.ret.lateRequired")} />}
          </AField>
        )}
      </div>
    </ADrawer>
  );
}

/** Where the item goes. A rejected claim leaves it with the buyer — the other
 * destinations stay visible but unselectable so staff see why. */
function DestPicker({ value, lockedTo, onChange }: {
  value: Destination;
  lockedTo: Destination | null;
  onChange: (d: Destination) => void;
}) {
  const { t } = useT();
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as Destination)}
      style={{
        height: 36, width: "100%", borderRadius: AT.radiusSm, border: `1px solid ${AT.rule}`,
        background: AT.panel, fontFamily: AT.body, fontSize: 13, color: AT.ink, padding: "0 9px",
      }}
    >
      {DESTINATIONS.map((d) => (
        <option key={d.id} value={d.id} disabled={lockedTo !== null && d.id !== lockedTo}>{t(d.label)}</option>
      ))}
    </select>
  );
}

/**
 * The decision. Money and stock both move here, so the case shows what was
 * paid, what is still refundable and — the part that actually settles most
 * arguments — everything this customer has returned before.
 */
function ReturnCaseDrawer({ caseId, line, canDecide, onClose, onResolved }: {
  caseId: string;
  line: ReturnLine | null;
  canDecide: boolean;
  onClose: () => void;
  onResolved: () => void;
}) {
  const { t } = useT();
  const toast = useToast();
  const confirm = useConfirm();
  const [detail, setDetail] = useState<ReturnDetail | null>(null);
  const [failed, setFailed] = useState(false);
  const [decision, setDecision] = useState<Decision | null>(null);
  const [amount, setAmount] = useState("");
  const [amountErr, setAmountErr] = useState(false);
  const [destination, setDestination] = useState<Destination>("quarantine");
  const [note, setNote] = useState("");
  const [providerBlocked, setProviderBlocked] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    void api
      .get<ReturnDetail>(`/api/returns/${caseId}`)
      .then((d) => {
        if (live) setDetail(d);
      })
      .catch(() => {
        if (live) setFailed(true);
      });
    return () => {
      live = false;
    };
  }, [caseId]);

  // Never offer more than the order still has left, nor more than this line was
  // worth — a partial refund above either would just bounce back as 422.
  const orderLeft = detail ? Math.max(0, detail.order.totalCents - detail.order.refundedCents) : 0;
  const refundableCents = Math.min(orderLeft, line?.refundableCents ?? orderLeft);
  const paidCents = line?.totalCents ?? detail?.order.totalCents ?? 0;
  const orderRef = detail?.order.ref ?? line?.orderRef ?? "—";
  const itemTitle = detail?.item?.title ?? line?.title ?? "";
  const itemSku = detail?.item?.sku ?? line?.sku ?? "";

  useEffect(() => {
    setAmount(refundableCents > 0 ? (refundableCents / 100).toFixed(2) : "");
  }, [refundableCents]);

  const cents = eurToCents(amount);
  const amountOk = Number.isFinite(cents) && cents > 0 && cents <= refundableCents;
  const showAmountErr = decision === "refund_partial" && (amountErr || (amount !== "" && !amountOk));
  const effDest: Destination = decision === "rejected" ? "kept_by_buyer" : destination;
  const plannedCents =
    decision === "refund_full" ? refundableCents : decision === "refund_partial" && amountOk ? cents : 0;

  const resolve = async (viaProvider: boolean, ask: boolean) => {
    if (!decision) return;
    if (decision === "refund_partial" && !amountOk) {
      setAmountErr(true);
      return;
    }
    const dest = destinationLabel(t, effDest);
    if (ask) {
      const r = await confirm({
        title: t("fd.ret.confirmTitle"),
        body:
          decision === "rejected"
            ? `${t("fd.ret.confirmNoRefund")} ${t("fd.ret.confirmDestPre")} ${dest}.`
            : `${t("fd.ret.confirmRefundPre")} ${formatEur(plannedCents)}. ${t("fd.ret.confirmDestPre")} ${dest}.`,
        confirmLabel: t("fd.ret.confirm"),
        danger: decision === "rejected",
      });
      if (!r.ok) return;
    }
    setBusy(true);
    try {
      const res = await api.post<{ case: ReturnCase; refund: { amountCents?: number } | null }>(
        `/api/returns/${caseId}/resolve`,
        {
          decision,
          ...(decision === "refund_partial" ? { refundCents: cents } : {}),
          destination: effDest,
          ...(decision === "rejected" ? {} : { viaProvider }),
          ...(note.trim() ? { note: note.trim() } : {}),
        },
      );
      const moved = res.refund?.amountCents ?? plannedCents;
      toast(
        decision === "rejected"
          ? `${t("fd.ret.resolvedRejected")} · ${dest}`
          : `${t("fd.ret.resolvedPre")} ${formatEur(moved)} · ${dest}`,
        "ok",
      );
      onResolved();
    } catch (err) {
      const code = errCode(err);
      if (code === "provider_refund_unsupported") {
        // Not a dead end: the money goes back in Inbank's portal, then gets
        // recorded here. Say that, and offer the button that does it.
        setProviderBlocked(true);
      } else if (code === "invalid_amount") {
        setAmountErr(true);
        toast(t("fd.ret.amountBad"), "danger");
      } else if (code === "payments_unavailable") {
        toast(t("fd.ret.paymentsDown"), "danger");
      } else if (code === "klix_refund_failed") {
        toast(t("fd.ret.klixFailed"), "danger");
      } else {
        toast(err instanceof ApiError ? err.message : t("fd.ret.resolveFailed"), "danger");
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <ADrawer
      title={t("fd.ret.caseTitle")}
      width={560}
      onClose={onClose}
      footer={
        canDecide && detail ? (
          <>
            <ABtn kind="ghost" onClick={onClose}>{t("c.cancel")}</ABtn>
            <ABtn kind="dark" disabled={busy || !decision} onClick={() => void resolve(true, true)}>
              {busy ? t("c.saving") : t("fd.ret.confirm")}
            </ABtn>
          </>
        ) : (
          <ABtn kind="ghost" onClick={onClose}>{t("c.close")}</ABtn>
        )
      }
    >
      {failed ? (
        <AEmpty text={t("fd.ret.caseLoadFailed")} />
      ) : !detail ? (
        <AEmpty text={t("c.loading")} />
      ) : (
        <div style={{ display: "grid", gap: 16 }}>
          <div style={{ background: AT.surfaceAlt, borderRadius: AT.radiusSm, padding: "12px 14px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <span style={{ fontFamily: AT.mono, fontSize: 13, fontWeight: 700, color: AT.ink }}>{detail.case.ref}</span>
              {line && <WindowPill daysLeft={line.daysLeft} />}
            </div>
            <div style={{ fontFamily: AT.body, fontSize: 13.5, fontWeight: 700, color: AT.ink, marginTop: 6 }}>{itemTitle}</div>
            <div style={{ fontFamily: AT.mono, fontSize: 11.5, color: AT.inkSoft, marginTop: 2 }}>{itemSku}</div>
            <div style={{ display: "flex", gap: 20, flexWrap: "wrap", marginTop: 10 }}>
              <Fact label={t("fd.ret.order")} value={orderRef} />
              <Fact label={t("fd.ret.paid")} value={formatEur(paidCents)} />
              <Fact label={t("fd.ret.refundable")} value={formatEur(refundableCents)} strong />
            </div>
          </div>

          {/* The whole reason this lives at the desk: is this the first time? */}
          <div>
            <div style={{ fontFamily: AT.body, fontSize: 12, fontWeight: 700, color: AT.ink, marginBottom: 8 }}>{t("fd.ret.history")}</div>
            {detail.history.length === 0 ? (
              <div style={{ fontFamily: AT.body, fontSize: 12.5, color: AT.inkSoft }}>{t("fd.ret.historyNone")}</div>
            ) : (
              <div style={{ border: `1px solid ${AT.rule}`, borderRadius: AT.radiusSm, overflow: "hidden" }}>
                {detail.history.map((h, i) => (
                  <div
                    key={`${h.ref}:${i}`}
                    style={{
                      display: "flex", gap: 10, alignItems: "baseline", padding: "8px 12px",
                      borderTop: i === 0 ? undefined : `1px solid ${AT.ruleSoft}`,
                    }}
                  >
                    <span style={{ fontFamily: AT.mono, fontSize: 11.5, color: AT.inkSoft }}>{h.ref}</span>
                    <span style={{ fontFamily: AT.body, fontSize: 12.5, color: AT.ink, flex: 1, minWidth: 0 }}>{h.itemTitle}</span>
                    <span style={{
                      fontFamily: AT.body, fontSize: 12, fontWeight: 700,
                      color: h.decision === "rejected" ? AT.danger : AT.ink, whiteSpace: "nowrap",
                    }}>{decisionLabel(t, h.decision)}</span>
                    <span style={{ fontFamily: AT.body, fontSize: 11.5, color: AT.inkSoft, whiteSpace: "nowrap" }}>{formatDate(h.resolvedAt)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {!canDecide ? (
            <div style={{
              fontFamily: AT.body, fontSize: 12.5, color: AT.inkSoft,
              background: AT.surfaceAlt, borderRadius: AT.radiusSm, padding: "10px 12px",
            }}>
              {t("fd.ret.managerDecides")}
            </div>
          ) : (
            <>
              <div>
                <div style={{ fontFamily: AT.body, fontSize: 12, fontWeight: 700, color: AT.ink, marginBottom: 8 }}>{t("fd.ret.decision")}</div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <ABtn kind={decision === "refund_full" ? "dark" : "ghost"} onClick={() => setDecision("refund_full")}>
                    {t("fd.ret.d.refund_full")}
                  </ABtn>
                  <ABtn kind={decision === "refund_partial" ? "dark" : "ghost"} onClick={() => setDecision("refund_partial")}>
                    {t("fd.ret.d.refund_partial")}
                  </ABtn>
                  <ABtn kind={decision === "rejected" ? "danger" : "ghost"} onClick={() => setDecision("rejected")}>
                    {t("fd.ret.d.rejected")}
                  </ABtn>
                </div>
              </div>

              {decision === "refund_partial" && (
                <AField label={t("fd.ret.amount")}>
                  {/* Text, not number: a number input silently swallows "12,50". */}
                  <AInput
                    value={amount}
                    onChange={(v) => {
                      setAmount(v);
                      setAmountErr(false);
                    }}
                    style={showAmountErr ? { border: `1px solid ${AT.danger}` } : undefined}
                  />
                  {showAmountErr && <FieldError text={t("fd.ret.amountBad")} />}
                </AField>
              )}

              <AField label={t("fd.ret.dest")} hint={decision === "rejected" ? t("fd.ret.destLocked") : t("fd.ret.destHint")}>
                <DestPicker
                  value={effDest}
                  lockedTo={decision === "rejected" ? "kept_by_buyer" : null}
                  onChange={setDestination}
                />
              </AField>

              <AField label={`${t("fd.ret.resolveNote")} · ${t("c.optional")}`}>
                <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} style={areaStyle} />
              </AField>

              {providerBlocked && (
                <div style={{
                  border: `1px solid ${AT.warn}`, background: AT.warnSoft, borderRadius: AT.radiusSm,
                  padding: "12px 14px", display: "grid", gap: 8,
                }}>
                  <div style={{ fontFamily: AT.body, fontSize: 13, fontWeight: 700, color: AT.warn }}>{t("fd.ret.inbankTitle")}</div>
                  <div style={{ fontFamily: AT.body, fontSize: 12.5, lineHeight: 1.5, color: AT.ink }}>{t("fd.ret.inbankBody")}</div>
                  <div>
                    <ABtn kind="dark" size="sm" disabled={busy} onClick={() => void resolve(false, false)}>
                      {t("fd.ret.recordWithoutRefund")}
                    </ABtn>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </ADrawer>
  );
}

/** Cash / card-terminal money moves outside the system — this records who
 * took it, how much, and how, so the drawer reconciles at the end of the day. */
function PayDialog({
  amountCents, method, setMethod, busy, onCancel, onConfirm,
}: {
  amountCents: number;
  method: Method;
  setMethod: (m: Method) => void;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useT();
  const options: Array<{ id: Method; label: string }> = [
    { id: "cash", label: t("fd.cash") },
    { id: "card_terminal", label: t("fd.cardTerminal") },
  ];
  return (
    <div
      onClick={onCancel}
      style={{ position: "fixed", inset: 0, zIndex: 70, background: "rgba(10,10,10,0.4)", display: "grid", placeItems: "center", padding: 16 }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ width: "min(460px, 96vw)", background: AT.panel, borderRadius: 14, overflow: "hidden" }}
      >
        <header style={{ padding: "14px 18px", borderBottom: `1px solid ${AT.rule}`, display: "flex", alignItems: "center", gap: 10 }}>
          <h2 style={{ fontFamily: AT.body, fontSize: 15.5, fontWeight: 700, color: AT.ink, flex: 1 }}>{t("fd.payTitle")}</h2>
          <span style={{ fontFamily: AT.mono, fontSize: 17, fontWeight: 800, color: AT.ink }}>{formatEur(amountCents)}</span>
        </header>
        <div style={{ padding: 18, display: "grid", gap: 14 }}>
          <div>
            <div style={{ fontFamily: AT.body, fontSize: 12.5, fontWeight: 700, color: AT.ink, marginBottom: 8 }}>{t("fd.howPaying")}</div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {options.map((o) => (
                <button
                  key={o.id}
                  onClick={() => setMethod(o.id)}
                  style={{
                    all: "unset", cursor: "pointer", padding: "10px 16px", borderRadius: 8,
                    fontFamily: AT.body, fontSize: 13.5, fontWeight: 700,
                    background: method === o.id ? AT.ink : AT.panel,
                    color: method === o.id ? "#fff" : AT.ink,
                    border: `1px solid ${method === o.id ? AT.ink : AT.rule}`,
                  }}
                >
                  {o.label}
                </button>
              ))}
            </div>
          </div>
          <div style={{ fontSize: 12.5, color: AT.inkSoft }}>{t("fd.payNote")}</div>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <ABtn kind="ghost" onClick={onCancel}>{t("c.cancel")}</ABtn>
            <ABtn kind="dark" onClick={onConfirm} disabled={busy}>
              {busy ? t("c.saving") : `${t("fd.confirmPaid")} ${formatEur(amountCents)}`}
            </ABtn>
          </div>
        </div>
      </div>
    </div>
  );
}
