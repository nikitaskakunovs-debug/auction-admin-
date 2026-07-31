/**
 * W4 — the counter workstation ("Lete"). One search box answers the desk's
 * real question ("what do I do with this person?"): who they are, what they
 * can take home now, what they still owe, and what blocks them — with the
 * actions attached to that one card.
 */
import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "../api.js";
import type { Nav } from "../App.js";
import { useAuth } from "../auth.js";
import { formatDate, formatEur } from "../format.js";
import { orderStatusLabel, useT } from "../i18n.js";
import { AT } from "../theme.js";
import { openLabelWindow as openPrintWindow } from "../labels.js";
import { AAvatar, ABadge, ABtn, ACard, AEmpty, AIcon, AInput, ATable, ATd, ATr, useToast } from "../ui.js";
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

interface DeskResult {
  matches: DeskMatch[];
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

export function FrontDeskScreen({ nav }: { nav: Nav }) {
  const { t } = useT();
  const { can } = useAuth();
  const toast = useToast();
  const mobile = useIsMobile();
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<DeskResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [paying, setPaying] = useState(false);
  const [method, setMethod] = useState<Method>("cash");
  const [picked, setPicked] = useState<{ orders: Set<string>; fees: Set<string> }>({ orders: new Set(), fees: new Set() });
  const box = useRef<HTMLDivElement>(null);

  const canTakeMoney = can("orders.mark_paid");

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

  const c = result?.customer;
  const collectable = result?.collectable ?? [];
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
              <ATable head={[t("ord.thOrder"), t("c.title"), t("c.location"), ""]}>
                {collectable.map((o) => (
                  <ATr key={o.id}>
                    <ATd mono>{o.ref}</ATd>
                    <ATd>
                      <div style={{ fontWeight: 600 }}>{o.itemTitle}</div>
                      <div style={{ fontFamily: AT.mono, fontSize: 11, color: AT.inkSoft }}>{o.itemSku}</div>
                    </ATd>
                    <ATd mono>{o.location || "—"}</ATd>
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
    </div>
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
