import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "../api.js";
import { useAuth } from "../auth.js";
import { formatDate, formatEur } from "../format.js";
import { useT, type TKey } from "../i18n.js";
import { AT, type Tone } from "../theme.js";
import {
  ABadge, ABtn, ACard, AEmpty, AField, AInput, APills, ASelect, ATable, ATd, ATr, useConfirm, useToast,
} from "../ui.js";

/**
 * Финансовый слой (fin-architecture) — вкладки внутри экрана «Finanses»:
 * Karodziņi / Apstiprināšana / Atmaksas / Grāmatojumi / Fin. iestatījumi.
 * RBAC — по матрице раздела 13; каждая вкладка отвечает своему pravu.
 */

// ── Karodziņi ────────────────────────────────────────────────────────────────

interface FinFlag {
  id: string;
  type: string;
  title: string;
  amountCents: number | null;
  status: string;
  resolutionNote: string | null;
  resolvedBy: string | null;
  createdAt: string;
}

const FLAG_TONE: Record<string, Tone> = {
  clearing_overdue: "warn",
  refund_pending: "warn",
  eu_threshold: "danger",
  dual_approval_wait: "neutral",
  bank_mismatch: "danger",
  partner_mismatch: "warn",
  carrier_mismatch: "warn",
};

export function FlagsTab() {
  const { t } = useT();
  const { can } = useAuth();
  const toast = useToast();
  const confirm = useConfirm();
  const [pill, setPill] = useState<"open" | "resolved">("open");
  const [flags, setFlags] = useState<FinFlag[]>([]);
  const [openCount, setOpenCount] = useState(0);

  const load = useCallback(() => {
    api.get<{ flags: FinFlag[]; openCount: number }>(`/api/fin/flags?status=${pill}`)
      .then((r) => { setFlags(r.flags); setOpenCount(r.openCount); })
      .catch(() => undefined);
  }, [pill]);
  useEffect(load, [load]);

  const resolve = async (f: FinFlag) => {
    const r = await confirm({ title: t("f2.fl.resolve"), body: f.title, requireReason: true, confirmLabel: t("f2.fl.resolve") });
    if (!r.ok || !r.reason) return;
    try {
      await api.post(`/api/fin/flags/${f.id}/resolve`, { note: r.reason });
      toast(t("f2.fl.resolvedToast"), "ok");
      load();
    } catch { toast(t("f2.errSave"), "danger"); }
  };

  const typeKey = (ty: string): TKey => (`f2.ft.${ty}` as TKey);
  return (
    <div style={{ display: "grid", gap: 12 }}>
      <APills
        options={[
          { id: "open" as const, label: t("f2.fl.open"), count: openCount },
          { id: "resolved" as const, label: t("f2.fl.resolvedPill") },
        ]}
        value={pill}
        onChange={setPill}
      />
      {flags.length === 0 ? <AEmpty text={t("f2.fl.empty")} /> : (
        <ACard pad={false}>
          <ATable head={[t("f2.fl.type"), t("f2.fl.what"), t("f2.fl.amount"), t("f2.fl.created"), ""]}>
            {flags.map((f) => (
              <ATr key={f.id}>
                <ATd><ABadge tone={FLAG_TONE[f.type] ?? "neutral"}>{t(typeKey(f.type))}</ABadge></ATd>
                <ATd>{f.title}{f.status === "resolved" && f.resolutionNote ? (
                  <div style={{ fontSize: 11.5, color: AT.inkSoft }}>{t("f2.fl.resolvedBy")}: {f.resolvedBy} — {f.resolutionNote}</div>
                ) : null}</ATd>
                <ATd right mono>{f.amountCents != null ? formatEur(f.amountCents) : "—"}</ATd>
                <ATd>{formatDate(f.createdAt)}</ATd>
                <ATd right>{f.status === "open" && can("fin.flags_resolve") ? (
                  <ABtn size="sm" kind="soft" onClick={() => void resolve(f)}>{t("f2.fl.resolve")}</ABtn>
                ) : null}</ATd>
              </ATr>
            ))}
          </ATable>
        </ACard>
      )}
    </div>
  );
}

// ── Apstiprināšana ───────────────────────────────────────────────────────────

interface ApprovalInvoice {
  id: string;
  number: string;
  supplierName: string;
  amountCents: number;
  approvalStatus: string;
  approvalRuleNote: string | null;
  approvedBy: string | null;
  secondApprovedBy: string | null;
  rejectedReason: string | null;
  fileKey: string | null;
  dueDate: string;
  createdAt: string;
}

interface ApprovalRule {
  id: string;
  minCents: number;
  maxCents: number | null;
  approver: string;
  dual: boolean;
  position: number;
  isActive: boolean;
}

const APPROVER_OPTIONS = ["auto", "role:super_admin", "role:operations", "role:sales_manager", "role:listing_manager", "role:finance"];

export function ApprovalsTab() {
  const { t } = useT();
  const { can } = useAuth();
  const toast = useToast();
  const confirm = useConfirm();
  const [pill, setPill] = useState<"pending" | "approved" | "auto" | "rejected">("pending");
  const [invoices, setInvoices] = useState<ApprovalInvoice[]>([]);
  const [rules, setRules] = useState<ApprovalRule[]>([]);
  const [tgCode, setTgCode] = useState<{ code: string; enabled: boolean } | null>(null);

  const load = useCallback(() => {
    api.get<{ invoices: ApprovalInvoice[] }>(`/api/fin/approvals?status=${pill}`).then((r) => setInvoices(r.invoices)).catch(() => undefined);
    api.get<{ rules: ApprovalRule[] }>("/api/fin/rules").then((r) => setRules(r.rules)).catch(() => undefined);
  }, [pill]);
  useEffect(load, [load]);

  const approve = async (inv: ApprovalInvoice) => {
    try {
      const r = await api.post<{ ok: true; final: boolean }>(`/api/fin/approvals/${inv.id}/approve`);
      toast(r.final ? t("f2.ap.approvedToast") : t("f2.ap.firstOkToast"), "ok");
      load();
    } catch (err) {
      const code = err instanceof ApiError && typeof err.body.error === "string" ? err.body.error : "";
      toast(code === "wrong_approver" ? t("f2.ap.errWrongApprover") : code === "same_person" ? t("f2.ap.errSamePerson") : t("f2.errSave"), "danger");
    }
  };
  const reject = async (inv: ApprovalInvoice) => {
    const r = await confirm({ title: t("f2.ap.reject"), body: `${inv.supplierName} — ${inv.number}`, requireReason: true, danger: true, confirmLabel: t("f2.ap.reject") });
    if (!r.ok || !r.reason) return;
    try {
      await api.post(`/api/fin/approvals/${inv.id}/reject`, { reason: r.reason });
      toast(t("f2.ap.rejectedToast"), "ok");
      load();
    } catch { toast(t("f2.errSave"), "danger"); }
  };
  const linkTelegram = async () => {
    try {
      setTgCode(await api.post<{ code: string; enabled: boolean }>("/api/fin/telegram/link"));
    } catch { toast(t("f2.errSave"), "danger"); }
  };

  const statusKey = (s: string): TKey => (`f2.as.${s}` as TKey);
  const saveRule = async (rule: ApprovalRule) => {
    try {
      await api.patch(`/api/fin/rules/${rule.id}`, {
        minCents: rule.minCents, maxCents: rule.maxCents, approver: rule.approver, dual: rule.dual, isActive: rule.isActive,
      });
      toast(t("f2.ru.saved"), "ok");
      load();
    } catch { toast(t("f2.errSave"), "danger"); }
  };

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <APills
          options={(["pending", "approved", "auto", "rejected"] as const).map((id) => ({ id, label: t(statusKey(id)) }))}
          value={pill}
          onChange={setPill}
        />
        <ABtn size="sm" kind="ghost" onClick={() => void linkTelegram()}>{t("f2.ap.tgLink")}</ABtn>
      </div>
      {tgCode ? (
        <ACard>
          <div style={{ fontFamily: AT.body, fontSize: 13, color: AT.ink }}>
            {tgCode.enabled ? (
              <>
                {t("f2.ap.tgHint")}
                <div style={{ marginTop: 6, fontFamily: "monospace", fontSize: 16, fontWeight: 700 }}>/start {tgCode.code}</div>
              </>
            ) : t("f2.ap.tgOff")}
          </div>
        </ACard>
      ) : null}
      {invoices.length === 0 ? <AEmpty text={t("f2.ap.empty")} /> : (
        <ACard pad={false}>
          <ATable head={[t("f2.ap.supplier"), t("f2.ap.number"), t("f2.ap.amount"), t("f2.ap.rule"), t("f2.ap.firstBy"), ""]}>
            {invoices.map((inv) => (
              <ATr key={inv.id}>
                <ATd>{inv.supplierName}</ATd>
                <ATd mono>{inv.number}{inv.fileKey ? (
                  <> <a href={inv.fileKey} target="_blank" rel="noreferrer" style={{ color: AT.accent }}>PDF</a></>
                ) : null}</ATd>
                <ATd right mono>{formatEur(inv.amountCents)}</ATd>
                <ATd><span style={{ fontSize: 11.5, color: AT.inkSoft }}>{inv.approvalRuleNote ?? "—"}</span>
                  {inv.rejectedReason ? <div style={{ fontSize: 11.5, color: AT.inkSoft }}>{inv.rejectedReason}</div> : null}</ATd>
                <ATd>{inv.approvedBy ?? "—"}{inv.secondApprovedBy ? ` + ${inv.secondApprovedBy}` : ""}</ATd>
                <ATd right>{inv.approvalStatus === "pending" ? (
                  <span style={{ display: "inline-flex", gap: 6 }}>
                    <ABtn size="sm" onClick={() => void approve(inv)}>{t("f2.ap.approve")}</ABtn>
                    <ABtn size="sm" kind="danger" onClick={() => void reject(inv)}>{t("f2.ap.reject")}</ABtn>
                  </span>
                ) : <ABadge tone={inv.approvalStatus === "rejected" ? "danger" : "ok"}>{t(statusKey(inv.approvalStatus))}</ABadge>}</ATd>
              </ATr>
            ))}
          </ATable>
        </ACard>
      )}

      {can("fin.rules_edit") ? (
        <ACard title={t("f2.ap.rules")} actions={
          <ABtn size="sm" kind="ghost" onClick={async () => {
            const last = rules[rules.length - 1];
            await api.post("/api/fin/rules", {
              minCents: last?.maxCents ?? 0, maxCents: null, approver: "role:super_admin", dual: false, position: rules.length,
            }).then(() => { toast(t("f2.ru.saved"), "ok"); load(); }).catch(() => toast(t("f2.errSave"), "danger"));
          }}>{t("f2.ru.add")}</ABtn>
        }>
          <div style={{ display: "grid", gap: 8 }}>
            {rules.map((r) => (
              <div key={r.id} style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <div style={{ width: 110 }}>
                  <AInput type="number" value={String(r.minCents / 100)} onChange={(v) =>
                    setRules((rs) => rs.map((x) => x.id === r.id ? { ...x, minCents: Math.round(Number(v) * 100) || 0 } : x))} />
                </div>
                <span style={{ color: AT.inkSoft }}>—</span>
                <div style={{ width: 110 }}>
                  <AInput type="number" value={r.maxCents == null ? "" : String(r.maxCents / 100)} placeholder="∞" onChange={(v) =>
                    setRules((rs) => rs.map((x) => x.id === r.id ? { ...x, maxCents: v === "" ? null : Math.round(Number(v) * 100) } : x))} />
                </div>
                <ASelect value={r.approver} onChange={(v) => setRules((rs) => rs.map((x) => x.id === r.id ? { ...x, approver: v } : x))}
                  options={APPROVER_OPTIONS.map((a) => ({ value: a, label: a === "auto" ? t("f2.ru.auto") : a.replace("role:", "") }))} />
                <label style={{ display: "inline-flex", gap: 5, alignItems: "center", fontFamily: AT.body, fontSize: 12.5, color: AT.ink }}>
                  <input type="checkbox" checked={r.dual} onChange={(e) => setRules((rs) => rs.map((x) => x.id === r.id ? { ...x, dual: e.target.checked } : x))} />
                  {t("f2.ru.dual")}
                </label>
                <label style={{ display: "inline-flex", gap: 5, alignItems: "center", fontFamily: AT.body, fontSize: 12.5, color: AT.ink }}>
                  <input type="checkbox" checked={r.isActive} onChange={(e) => setRules((rs) => rs.map((x) => x.id === r.id ? { ...x, isActive: e.target.checked } : x))} />
                  {t("f2.ru.active")}
                </label>
                <ABtn size="sm" kind="soft" onClick={() => void saveRule(r)}>{t("f2.st.save")}</ABtn>
                <ABtn size="sm" kind="danger" onClick={async () => {
                  const c = await confirm({ title: t("c.delete"), danger: true });
                  if (!c.ok) return;
                  await api.delete(`/api/fin/rules/${r.id}`).then(() => { toast(t("f2.ru.deleted"), "ok"); load(); }).catch(() => toast(t("f2.errSave"), "danger"));
                }}>{t("c.delete")}</ABtn>
              </div>
            ))}
          </div>
        </ACard>
      ) : null}
    </div>
  );
}

// ── Atmaksas ────────────────────────────────────────────────────────────────

interface FinRefund {
  id: string;
  orderRef: string;
  customerAlias: string;
  amountCents: number;
  orderTotalCents: number;
  method: string;
  reason: string;
  status: string;
  paidBy: string | null;
  createdAt: string;
}

export function RefundsTab() {
  const { t } = useT();
  const toast = useToast();
  const confirm = useConfirm();
  const [pill, setPill] = useState<"requested" | "paid">("requested");
  const [rows, setRows] = useState<FinRefund[]>([]);

  const load = useCallback(() => {
    const q = pill === "requested" ? "" : "?status=paid";
    api.get<{ refunds: FinRefund[] }>(`/api/fin/refunds${q}`)
      .then((r) => setRows(pill === "requested" ? r.refunds.filter((x) => x.status !== "paid") : r.refunds))
      .catch(() => undefined);
  }, [pill]);
  useEffect(load, [load]);

  const markPaid = async (r: FinRefund) => {
    const c = await confirm({ title: t("f2.rf.markPaid"), body: `${r.orderRef} — ${formatEur(r.amountCents)}`, confirmLabel: t("f2.rf.markPaid") });
    if (!c.ok) return;
    try {
      await api.post(`/api/fin/refunds/${r.id}/mark-paid`);
      toast(t("f2.rf.paidToast"), "ok");
      load();
    } catch { toast(t("f2.errSave"), "danger"); }
  };

  const statusKey = (s: string): TKey => (`f2.rs.${s}` as TKey);
  const methodKey = (m: string): TKey => (`f2.rm.${m}` as TKey);
  return (
    <div style={{ display: "grid", gap: 12 }}>
      <APills
        options={[
          { id: "requested" as const, label: t("f2.rs.requested") },
          { id: "paid" as const, label: t("f2.rs.paid") },
        ]}
        value={pill}
        onChange={setPill}
      />
      {rows.length === 0 ? <AEmpty text={t("f2.rf.empty")} /> : (
        <ACard pad={false}>
          <ATable head={[t("f2.rf.order"), t("f2.rf.client"), t("f2.rf.amount"), t("f2.rf.method"), t("f2.rf.reason"), t("f2.rf.requested"), ""]}>
            {rows.map((r) => (
              <ATr key={r.id}>
                <ATd mono>{r.orderRef}</ATd>
                <ATd>{r.customerAlias}</ATd>
                <ATd right mono>{formatEur(r.amountCents)}</ATd>
                <ATd>{["card", "cash", "bank"].includes(r.method) ? t(methodKey(r.method)) : r.method}</ATd>
                <ATd><span style={{ fontSize: 12 }}>{r.reason}</span></ATd>
                <ATd>{formatDate(r.createdAt)}</ATd>
                <ATd right>{r.status === "requested" || r.status === "awaiting_manual" ? (
                  <ABtn size="sm" onClick={() => void markPaid(r)}>{t("f2.rf.markPaid")}</ABtn>
                ) : r.status === "paid" ? (
                  <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                    <ABadge tone="ok">{t("f2.rs.paid")}</ABadge>
                    <ABtn size="sm" kind="ghost" onClick={async () => {
                      await api.post(`/api/fin/refunds/${r.id}/close`).then(() => { toast(t("f2.rf.closedToast"), "ok"); load(); }).catch(() => toast(t("f2.errSave"), "danger"));
                    }}>{t("f2.rf.close")}</ABtn>
                  </span>
                ) : <ABadge tone="neutral">{t(statusKey(r.status))}</ABadge>}</ATd>
              </ATr>
            ))}
          </ATable>
        </ACard>
      )}
    </div>
  );
}

// ── Grāmatojumi ─────────────────────────────────────────────────────────────

interface LedgerEntry {
  id: string;
  account: string;
  amountCents: number;
  paymentMethod: string | null;
  orderRef: string | null;
  memo: string;
  eventAt: string;
}

interface ExportBatch {
  id: string;
  format: string;
  fromAt: string;
  toAt: string;
  entryCount: number;
  createdBy: string | null;
  createdAt: string;
}

function monthStartStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}

export function LedgerTab() {
  const { t } = useT();
  const { can } = useAuth();
  const toast = useToast();
  const [entries, setEntries] = useState<LedgerEntry[]>([]);
  const [accounts, setAccounts] = useState<Record<string, string>>({});
  const [batches, setBatches] = useState<ExportBatch[]>([]);
  const [account, setAccount] = useState("");
  const [from, setFrom] = useState(monthStartStr());
  const [to, setTo] = useState(new Date().toISOString().slice(0, 10));
  const [manual, setManual] = useState({ kind: "goodwill", amount: "", orderRef: "", memo: "" });

  const load = useCallback(() => {
    const q = new URLSearchParams();
    if (from) q.set("from", from);
    if (to) q.set("to", to);
    if (account) q.set("account", account);
    api.get<{ entries: LedgerEntry[]; accounts: Record<string, string> }>(`/api/fin/ledger?${q}`)
      .then((r) => { setEntries(r.entries); setAccounts(r.accounts); })
      .catch(() => undefined);
    if (can("fin.export")) {
      api.get<{ batches: ExportBatch[] }>("/api/fin/export-batches").then((r) => setBatches(r.batches)).catch(() => undefined);
    }
  }, [from, to, account, can]);
  useEffect(load, [load]);

  const runExport = async (format: "csv" | "xml") => {
    try {
      const r = await api.post<{ batchId: string }>("/api/fin/export", { from, to, format });
      window.open(`/api/fin/export-batches/${r.batchId}/download?token=${encodeURIComponent(api.token ?? "")}`, "_blank");
      load();
    } catch (err) {
      const code = err instanceof ApiError && typeof err.body.error === "string" ? err.body.error : "";
      toast(code === "no_entries" ? t("f2.lg.noEntries") : t("f2.errSave"), code === "no_entries" ? "neutral" : "danger");
    }
  };

  const postManual = async () => {
    const amountCents = Math.round(Number(manual.amount) * 100);
    if (!amountCents || amountCents <= 0 || manual.memo.trim().length < 3) return;
    try {
      await api.post("/api/fin/manual-entry", {
        kind: manual.kind, amountCents, memo: manual.memo.trim(),
        ...(manual.orderRef.trim() ? { orderRef: manual.orderRef.trim() } : {}),
      });
      toast(t("f2.mn.done"), "ok");
      setManual({ kind: "goodwill", amount: "", orderRef: "", memo: "" });
      load();
    } catch { toast(t("f2.errSave"), "danger"); }
  };

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div style={{ display: "flex", gap: 10, alignItems: "flex-end", flexWrap: "wrap" }}>
        <AField label={t("f2.lg.from")}><AInput type="date" value={from} onChange={setFrom} style={{ width: 150 }} /></AField>
        <AField label={t("f2.lg.to")}><AInput type="date" value={to} onChange={setTo} style={{ width: 150 }} /></AField>
        <ASelect label={t("f2.lg.account")} value={account} onChange={setAccount}
          options={[{ value: "", label: t("f2.lg.allAccounts") }, ...Object.entries(accounts).map(([k, v]) => ({ value: k, label: v }))]} />
        {can("fin.export") ? (
          <span style={{ display: "inline-flex", gap: 6 }}>
            <ABtn size="sm" onClick={() => void runExport("csv")}>{t("f2.lg.exportCsv")}</ABtn>
            <ABtn size="sm" kind="ghost" onClick={() => void runExport("xml")}>{t("f2.lg.exportXml")}</ABtn>
          </span>
        ) : null}
      </div>
      {entries.length === 0 ? <AEmpty text={t("f2.lg.empty")} /> : (
        <ACard pad={false}>
          <ATable head={[t("f2.lg.date"), t("f2.lg.account"), t("f2.lg.amount"), t("f2.lg.methodCol"), t("f2.lg.orderCol"), t("f2.lg.memo")]}>
            {entries.map((e) => (
              <ATr key={e.id}>
                <ATd>{formatDate(e.eventAt)}</ATd>
                <ATd>{accounts[e.account] ?? e.account}</ATd>
                <ATd right mono style={{ color: e.amountCents < 0 ? AT.danger : AT.ink }}>{formatEur(e.amountCents)}</ATd>
                <ATd>{e.paymentMethod ?? "—"}</ATd>
                <ATd mono>{e.orderRef ?? "—"}</ATd>
                <ATd><span style={{ fontSize: 12, color: AT.inkSoft }}>{e.memo}</span></ATd>
              </ATr>
            ))}
          </ATable>
        </ACard>
      )}

      {can("fin.refunds_manage") ? (
        <ACard title={t("f2.lg.manual")}>
          <div style={{ display: "flex", gap: 10, alignItems: "flex-end", flexWrap: "wrap" }}>
            <ASelect value={manual.kind} onChange={(v) => setManual((m) => ({ ...m, kind: v }))}
              options={(["goodwill", "carrier_claim", "carrier_claim_settled", "writeoff"] as const).map((k) => ({ value: k, label: t(`f2.mk.${k}` as TKey) }))} />
            <div style={{ width: 110 }}><AInput type="number" value={manual.amount} placeholder="€" onChange={(v) => setManual((m) => ({ ...m, amount: v }))} /></div>
            <div style={{ width: 130 }}><AInput value={manual.orderRef} placeholder="A-1042" onChange={(v) => setManual((m) => ({ ...m, orderRef: v }))} /></div>
            <div style={{ flex: 1, minWidth: 180 }}><AInput value={manual.memo} placeholder={t("f2.mn.memo")} onChange={(v) => setManual((m) => ({ ...m, memo: v }))} /></div>
            <ABtn size="sm" onClick={() => void postManual()}>{t("f2.mn.save")}</ABtn>
          </div>
        </ACard>
      ) : null}

      {can("fin.export") && batches.length > 0 ? (
        <ACard title={t("f2.lg.batches")} pad={false}>
          <ATable head={[t("f2.lg.batchRange"), "Formāts", t("f2.lg.batchCount"), t("f2.lg.batchBy"), t("f2.fl.created"), ""]}>
            {batches.map((b) => (
              <ATr key={b.id}>
                <ATd>{formatDate(b.fromAt)} — {formatDate(b.toAt)}</ATd>
                <ATd mono>{b.format.toUpperCase()}</ATd>
                <ATd right mono>{b.entryCount}</ATd>
                <ATd>{b.createdBy ?? "—"}</ATd>
                <ATd>{formatDate(b.createdAt)}</ATd>
                <ATd right>
                  <ABtn size="sm" kind="ghost" onClick={() =>
                    window.open(`/api/fin/export-batches/${b.id}/download?token=${encodeURIComponent(api.token ?? "")}`, "_blank")
                  }>{t("f2.lg.download")}</ABtn>
                </ATd>
              </ATr>
            ))}
          </ATable>
        </ACard>
      ) : null}
    </div>
  );
}

// ── Fin. iestatījumi ────────────────────────────────────────────────────────

/**
 * Подпись настройки. Список ключей приходит с сервера, поэтому подписи может
 * не оказаться — тогда показываем сам ключ словами. Пустой экран из-за одной
 * забытой строки здесь был, и повторяться ему незачем.
 */
function settingLabel(t: (key: TKey) => string, key: string): string {
  const label = t(`f2.sk.${key}` as TKey);
  return label === `f2.sk.${key}` ? key.replace(/_/g, " ") : label;
}

export function FinSettingsTab() {
  const { t } = useT();
  const { can } = useAuth();
  const toast = useToast();
  const [values, setValues] = useState<Record<string, number>>({});
  const [dirty, setDirty] = useState<Record<string, string>>({});

  useEffect(() => {
    api.get<{ settings: Record<string, number> }>("/api/fin/settings").then((r) => setValues(r.settings)).catch(() => undefined);
  }, []);

  const editable = Object.keys(values).filter((k) => k !== "points_expiry_start_ms");
  const save = async () => {
    const patch: Record<string, number> = {};
    for (const [k, v] of Object.entries(dirty)) {
      const n = Number(v);
      if (Number.isFinite(n) && n >= 0) patch[k] = n;
    }
    if (!Object.keys(patch).length) return;
    try {
      const r = await api.put<{ settings: Record<string, number> }>("/api/fin/settings", patch);
      setValues(r.settings);
      setDirty({});
      toast(t("f2.st.saved"), "ok");
    } catch { toast(t("f2.errSave"), "danger"); }
  };

  const canEdit = can("fin.rules_edit");
  return (
    <ACard title={t("f2.tab.finSettings")} actions={canEdit ? <ABtn size="sm" onClick={() => void save()} disabled={!Object.keys(dirty).length}>{t("f2.st.save")}</ABtn> : undefined}>
      <div style={{ fontFamily: AT.body, fontSize: 12.5, color: AT.inkSoft, marginBottom: 12 }}>{t("f2.st.hint")}</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: 12 }}>
        {editable.map((k) => (
          <AField key={k} label={settingLabel(t, k)}>
            <AInput
              type="number"
              value={dirty[k] ?? String(values[k] ?? 0)}
              onChange={(v) => canEdit && setDirty((d) => ({ ...d, [k]: v }))}
            />
          </AField>
        ))}
      </div>
    </ACard>
  );
}
