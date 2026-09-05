"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  supplierApi, SupplierApiError,
  type SupplierDelivery, type SupplierInvoices, type SupplierProfile, type SupplierSales, type SupplierSummary,
} from "@/lib/supplierApi";
import { supT, SUP_LANGS, type SupLang } from "@/lib/supplierStrings";

/**
 * Кабинет поставщика: пять экранов на одной странице.
 *
 * Экранов ровно столько, сколько дел у поставщика: посмотреть сводку,
 * следить за поставками (и ответить на расхождение), увидеть реализацию,
 * подать счёт и держать в порядке реквизиты. Всё остальное — работа
 * менеджера в админке, и в кабинет оно не просачивается.
 */

const eur = (cents: number, lang: SupLang): string => {
  const s = (cents / 100).toFixed(2);
  const [whole = "0", frac = "00"] = s.split(".");
  const spaced = whole.replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  return lang === "en" ? `€${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${frac}` : `${spaced},${frac} €`;
};
const day = (iso: string | null | undefined): string => (iso ? iso.slice(0, 10).split("-").reverse().join(".") : "—");

type Tab = "home" | "deliveries" | "sales" | "invoices" | "profile";

export function SupplierPortal() {
  const router = useRouter();
  const [lang, setLang] = useState<SupLang>("lv");
  const [tab, setTab] = useState<Tab>("home");
  const [summary, setSummary] = useState<SupplierSummary | null>(null);
  const [failed, setFailed] = useState(false);
  const t = supT(lang);

  const loadSummary = useCallback(() => {
    supplierApi
      .get<SupplierSummary>("/api/piegadatajs/summary")
      .then((r) => {
        setSummary(r);
        // Кабинет говорит на том же языке, что и письма этому поставщику.
        if (SUP_LANGS.includes(r.supplier.lang as SupLang)) setLang(r.supplier.lang as SupLang);
      })
      .catch((err) => {
        if (err instanceof SupplierApiError && err.status === 401) router.replace("/piegadatajs");
        else setFailed(true);
      });
  }, [router]);

  useEffect(() => {
    if (!supplierApi.hasSession) {
      router.replace("/piegadatajs");
      return;
    }
    loadSummary();
  }, [loadSummary, router]);

  if (failed) return <section className="wrap" style={{ paddingTop: 40 }}><p className="note">{t("p.error")}</p></section>;
  if (!summary) return <section className="wrap" style={{ paddingTop: 40 }}><p className="note">{t("p.loading")}</p></section>;

  const tabs: Array<{ id: Tab; label: string }> = [
    { id: "home", label: t("p.tab.home") },
    { id: "deliveries", label: t("p.tab.deliveries") },
    { id: "sales", label: t("p.tab.sales") },
    { id: "invoices", label: t("p.tab.invoices") },
    { id: "profile", label: t("p.tab.profile") },
  ];

  return (
    <section className="wrap sup-portal" style={{ paddingTop: 28, paddingBottom: 72 }}>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
        <div>
          <h1 style={{ margin: 0 }}>{t("p.title")}</h1>
          <p className="note" style={{ margin: "4px 0 0" }}>{summary.supplier.name}</p>
        </div>
        <button
          className="btn btn-ghost"
          onClick={() => {
            supplierApi.setToken(null);
            router.replace("/piegadatajs");
          }}
        >
          {t("p.logout")}
        </button>
      </header>

      <nav className="sup-tabs" style={{ display: "flex", gap: 6, flexWrap: "wrap", margin: "18px 0 20px" }}>
        {tabs.map((x) => (
          <button
            key={x.id}
            onClick={() => setTab(x.id)}
            className={tab === x.id ? "btn" : "btn btn-ghost"}
            style={{ padding: "8px 14px" }}
          >
            {x.label}
          </button>
        ))}
      </nav>

      {tab === "home" && <HomeTab summary={summary} lang={lang} />}
      {tab === "deliveries" && <DeliveriesTab lang={lang} onChange={loadSummary} />}
      {tab === "sales" && <SalesTab lang={lang} />}
      {tab === "invoices" && <InvoicesTab lang={lang} onChange={loadSummary} />}
      {tab === "profile" && <ProfileTab lang={lang} onLangChange={setLang} />}
    </section>
  );
}

// ── Экран 1: Sākums ─────────────────────────────────────────────────────────

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="card-b" style={{ padding: 16 }}>
      <div className="note" style={{ fontSize: 12, marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: 26, fontWeight: 800, lineHeight: 1.1 }}>{value}</div>
      {hint ? <div className="note" style={{ fontSize: 12, marginTop: 4 }}>{hint}</div> : null}
    </div>
  );
}

function HomeTab({ summary, lang }: { summary: SupplierSummary; lang: SupLang }) {
  const t = supT(lang);
  return (
    <div style={{ display: "grid", gap: 14 }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 }}>
        <Stat label={t("p.h.owed")} value={eur(summary.money.outstandingCents, lang)} hint={summary.money.nextDueDate ? `${t("p.h.nextDue")}: ${day(summary.money.nextDueDate)}` : undefined} />
        <Stat label={t("p.h.announced")} value={String(summary.deliveries.announced)} />
        <Stat label={t("p.h.open")} value={String(summary.deliveries.open)} />
        <Stat label={t("p.h.awaiting")} value={String(summary.deliveries.awaitingReply)} />
        <Stat label={t("p.h.inStock")} value={String(summary.stock.inStock)} />
        <Stat label={t("p.h.sold")} value={String(summary.stock.sold)} />
      </div>
      <div className="card-b" style={{ padding: 16 }}>
        <p style={{ margin: 0 }}>
          <strong>{t("p.h.model")}:</strong>{" "}
          {summary.supplier.model === "commission"
            ? `${t("p.h.commission")} · ${summary.supplier.commissionPercent}%`
            : t("p.h.buyout")}
        </p>
        <p style={{ margin: "6px 0 0" }}>
          <strong>{t("p.h.terms")}:</strong> {summary.supplier.paymentTermsDays} {t("p.h.days")}
        </p>
      </div>
    </div>
  );
}

// ── Экран 2: Piegādes ───────────────────────────────────────────────────────

function DeliveriesTab({ lang, onChange }: { lang: SupLang; onChange: () => void }) {
  const t = supT(lang);
  const [rows, setRows] = useState<SupplierDelivery[] | null>(null);
  const [form, setForm] = useState({ count: "", when: "", notes: "" });
  const [msg, setMsg] = useState<string | null>(null);
  const [dispute, setDispute] = useState<{ id: string; note: string } | null>(null);

  const load = useCallback(() => {
    supplierApi
      .get<{ deliveries: SupplierDelivery[] }>("/api/piegadatajs/deliveries")
      .then((r) => setRows(r.deliveries))
      .catch(() => setRows([]));
  }, []);
  useEffect(load, [load]);

  const announce = async () => {
    const count = Number(form.count);
    if (!count || !form.when) return;
    try {
      await supplierApi.post("/api/piegadatajs/deliveries", {
        expectedCount: count,
        plannedAt: new Date(form.when).toISOString(),
        ...(form.notes.trim() ? { notes: form.notes.trim() } : {}),
      });
      setForm({ count: "", when: "", notes: "" });
      setMsg(t("p.saved"));
      load();
      onChange();
    } catch {
      setMsg(t("p.error"));
    }
  };

  const reply = async (id: string, decision: "accept" | "dispute", note?: string) => {
    if (decision === "dispute" && !note?.trim()) {
      setMsg(t("p.d.noteRequired"));
      return;
    }
    try {
      await supplierApi.post(`/api/piegadatajs/deliveries/${id}/reply`, { decision, ...(note ? { note } : {}) });
      setDispute(null);
      setMsg(t("p.d.replied"));
      load();
      onChange();
    } catch {
      setMsg(t("p.error"));
    }
  };

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div className="card-b" style={{ padding: 16 }}>
        <h2 style={{ marginTop: 0, fontSize: 17 }}>{t("p.d.new")}</h2>
        <div className="fields" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 10 }}>
          <label>
            {t("p.d.count")}
            <input type="number" min={1} value={form.count} onChange={(e) => setForm({ ...form, count: e.target.value })} />
          </label>
          <label>
            {t("p.d.when")}
            <input type="date" value={form.when} onChange={(e) => setForm({ ...form, when: e.target.value })} />
          </label>
          <label>
            {t("p.d.notes")}
            <input value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
          </label>
        </div>
        <button className="btn" style={{ marginTop: 12 }} onClick={() => void announce()}>{t("p.d.send")}</button>
        {msg ? <p className="note" style={{ marginBottom: 0 }}>{msg}</p> : null}
      </div>

      {rows === null ? (
        <p className="note">{t("p.loading")}</p>
      ) : rows.length === 0 ? (
        <p className="note">{t("p.d.empty")}</p>
      ) : (
        rows.map((d) => (
          <div key={d.id} className="card-b" style={{ padding: 16 }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
              <strong>{t("p.d.ref")} {d.ref}</strong>
              <span className="note">{t(`p.d.st.${d.status}`)}</span>
            </div>
            <p className="note" style={{ margin: "6px 0 0" }}>
              {t("p.d.declared")}: {d.expectedCount || "—"} · {t("p.d.received")}: {d.receivedCount}
              {d.plannedAt ? ` · ${day(d.plannedAt)}` : ""}
            </p>

            {d.discrepancyStatus === "open" ? (
              <div style={{ marginTop: 12, padding: 12, border: "1px solid var(--rule, #e6e6e0)", borderRadius: 10 }}>
                <strong>{t("p.d.discrepancy")}</strong>
                <p style={{ margin: "6px 0" }}>{d.discrepancyNote}</p>
                <p className="note" style={{ margin: "0 0 10px" }}>{t("p.d.replyBy")}: {day(d.discrepancyDueAt)}</p>
                {dispute?.id === d.id ? (
                  <div className="fields">
                    <label>
                      {t("p.d.disputeNote")}
                      <input value={dispute.note} onChange={(e) => setDispute({ id: d.id, note: e.target.value })} />
                    </label>
                    <button className="btn" style={{ marginTop: 8 }} onClick={() => void reply(d.id, "dispute", dispute.note)}>
                      {t("p.d.dispute")}
                    </button>
                  </div>
                ) : (
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <button className="btn" onClick={() => void reply(d.id, "accept")}>{t("p.d.accept")}</button>
                    <button className="btn btn-ghost" onClick={() => setDispute({ id: d.id, note: "" })}>{t("p.d.dispute")}</button>
                  </div>
                )}
              </div>
            ) : d.discrepancyStatus !== "none" ? (
              <p className="note" style={{ margin: "8px 0 0" }}>{t("p.d.discrepancy")}: {t("p.d.replied")}</p>
            ) : null}
          </div>
        ))
      )}
    </div>
  );
}

// ── Экран 3: Realizācija ────────────────────────────────────────────────────

function SalesTab({ lang }: { lang: SupLang }) {
  const t = supT(lang);
  const [data, setData] = useState<SupplierSales | null>(null);
  useEffect(() => {
    supplierApi.get<SupplierSales>("/api/piegadatajs/sales").then(setData).catch(() => setData(null));
  }, []);
  if (!data) return <p className="note">{t("p.loading")}</p>;
  const commission = data.totals.commissionCents > 0;
  return (
    <div style={{ display: "grid", gap: 14 }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 }}>
        <Stat label={t("p.s.sold")} value={String(data.totals.soldCount)} />
        <Stat label={t("p.s.gross")} value={eur(data.totals.grossCents, lang)} />
        {commission ? <Stat label={t("p.s.commission")} value={eur(data.totals.commissionCents, lang)} /> : null}
        {commission ? <Stat label={t("p.s.payout")} value={eur(data.totals.payoutCents, lang)} /> : null}
        <Stat label={t("p.s.sellThrough")} value={`${data.totals.sellThroughPercent}%`} />
        <Stat label={t("p.h.inStock")} value={String(data.totals.inStock)} />
      </div>
      {data.lots.length === 0 ? (
        <p className="note">{t("p.s.empty")}</p>
      ) : (
        <div className="card-b" style={{ padding: 0, overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 420 }}>
            <thead>
              <tr>
                <th style={{ textAlign: "left", padding: "10px 14px" }}>{t("p.s.item")}</th>
                <th style={{ textAlign: "right", padding: "10px 14px" }}>{t("p.s.price")}</th>
                <th style={{ textAlign: "right", padding: "10px 14px" }}>{t("p.s.date")}</th>
              </tr>
            </thead>
            <tbody>
              {data.lots.map((l, i) => (
                <tr key={`${l.sku}-${i}`} style={{ borderTop: "1px solid var(--rule, #e6e6e0)" }}>
                  <td style={{ padding: "10px 14px" }}>{l.title}</td>
                  <td style={{ padding: "10px 14px", textAlign: "right" }}>{eur(l.priceCents, lang)}</td>
                  <td style={{ padding: "10px 14px", textAlign: "right" }}>{day(l.paidAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Экран 4: Rēķini un maksājumi ────────────────────────────────────────────

function InvoicesTab({ lang, onChange }: { lang: SupLang; onChange: () => void }) {
  const t = supT(lang);
  const [data, setData] = useState<SupplierInvoices | null>(null);
  const [form, setForm] = useState({ number: "", date: "", amount: "" });
  const [file, setFile] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(() => {
    supplierApi.get<SupplierInvoices>("/api/piegadatajs/invoices").then(setData).catch(() => setData(null));
  }, []);
  useEffect(load, [load]);

  const pickFile = (f: File | undefined) => {
    if (!f) return setFile(null);
    const reader = new FileReader();
    reader.onload = () => setFile(typeof reader.result === "string" ? reader.result : null);
    reader.readAsDataURL(f);
  };

  const submit = async () => {
    const amount = Math.round(Number(form.amount) * 100);
    if (!form.number.trim() || !form.date || !amount) return;
    try {
      await supplierApi.post("/api/piegadatajs/invoices", {
        number: form.number.trim(),
        invoiceDate: form.date,
        amountCents: amount,
        ...(file ? { fileDataUrl: file } : {}),
      });
      setForm({ number: "", date: "", amount: "" });
      setFile(null);
      setMsg(t("p.saved"));
      load();
      onChange();
    } catch (err) {
      setMsg(err instanceof SupplierApiError && err.status === 409 ? t("p.i.dup") : t("p.error"));
    }
  };

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div className="card-b" style={{ padding: 16 }}>
        <h2 style={{ marginTop: 0, fontSize: 17 }}>{t("p.i.upload")}</h2>
        <div className="fields" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 10 }}>
          <label>
            {t("p.i.number")}
            <input value={form.number} onChange={(e) => setForm({ ...form, number: e.target.value })} />
          </label>
          <label>
            {t("p.i.date")}
            <input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} />
          </label>
          <label>
            {t("p.i.amount")}
            <input type="number" step="0.01" min="0" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} />
          </label>
          <label>
            {t("p.i.file")}
            {/* Ширину задаём явно: у file-инпута она своя и ломала сетку. */}
            <input
              type="file"
              accept="application/pdf,image/*"
              style={{ maxWidth: "100%" }}
              onChange={(e) => pickFile(e.target.files?.[0])}
            />
          </label>
        </div>
        <button className="btn" style={{ marginTop: 12 }} onClick={() => void submit()}>{t("p.i.send")}</button>
        {msg ? <p className="note" style={{ marginBottom: 0 }}>{msg}</p> : null}
      </div>

      {!data ? (
        <p className="note">{t("p.loading")}</p>
      ) : data.invoices.length === 0 ? (
        <p className="note">{t("p.i.empty")}</p>
      ) : (
        <div className="card-b" style={{ padding: 0, overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 520 }}>
            <thead>
              <tr>
                <th style={{ textAlign: "left", padding: "10px 14px" }}>{t("p.i.number")}</th>
                <th style={{ textAlign: "right", padding: "10px 14px" }}>{t("p.i.amount")}</th>
                <th style={{ textAlign: "right", padding: "10px 14px" }}>{t("p.i.due")}</th>
                <th style={{ textAlign: "left", padding: "10px 14px" }}>{t("p.i.status")}</th>
              </tr>
            </thead>
            <tbody>
              {data.invoices.map((inv) => (
                <tr key={inv.id} style={{ borderTop: "1px solid var(--rule, #e6e6e0)" }}>
                  <td style={{ padding: "10px 14px" }}>
                    {inv.number}
                    {inv.rejectedReason ? <div className="note" style={{ fontSize: 12 }}>{inv.rejectedReason}</div> : null}
                  </td>
                  <td style={{ padding: "10px 14px", textAlign: "right" }}>{eur(inv.amountCents, lang)}</td>
                  <td style={{ padding: "10px 14px", textAlign: "right" }}>{day(inv.dueDate)}</td>
                  <td style={{ padding: "10px 14px" }}>
                    {t(`p.i.ap.${inv.approvalStatus}`)} · {t(`p.i.st.${inv.status}`)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {data && data.payments.length > 0 ? (
        <div className="card-b" style={{ padding: 16 }}>
          <h2 style={{ marginTop: 0, fontSize: 17 }}>{t("p.i.payments")}</h2>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {data.payments.map((p) => (
              <li key={p.id}>
                {day(p.paidAt)} — {eur(p.amountCents, lang)} · {p.invoiceNumber}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

// ── Экран 5: Profils ────────────────────────────────────────────────────────

function ProfileTab({ lang, onLangChange }: { lang: SupLang; onLangChange: (l: SupLang) => void }) {
  const t = supT(lang);
  const [data, setData] = useState<SupplierProfile["profile"] | null>(null);
  const [form, setForm] = useState({ contactName: "", phone: "", address: "", bankAccount: "", lang: "lv" as SupLang });
  const [msg, setMsg] = useState<string | null>(null);
  const [pw, setPw] = useState({ current: "", next: "" });

  const load = useCallback(() => {
    supplierApi
      .get<SupplierProfile>("/api/piegadatajs/profile")
      .then((r) => {
        setData(r.profile);
        setForm({
          contactName: r.profile.contactName,
          phone: r.profile.phone,
          address: r.profile.address,
          bankAccount: r.profile.bankAccount,
          lang: (SUP_LANGS.includes(r.profile.lang as SupLang) ? r.profile.lang : "lv") as SupLang,
        });
      })
      .catch(() => setData(null));
  }, []);
  useEffect(load, [load]);

  const save = async () => {
    try {
      const res = await supplierApi.patch<{ bankPending: boolean }>("/api/piegadatajs/profile", {
        contactName: form.contactName,
        phone: form.phone,
        address: form.address,
        lang: form.lang,
        ...(data && form.bankAccount !== data.bankAccount ? { bankAccount: form.bankAccount } : {}),
      });
      onLangChange(form.lang);
      setMsg(res.bankPending ? t("p.pr.bankPending") : t("p.saved"));
      load();
    } catch {
      setMsg(t("p.error"));
    }
  };

  const changePassword = async () => {
    if (pw.current.length < 1 || pw.next.length < 8) return;
    try {
      await supplierApi.post("/api/piegadatajs/password", { currentPassword: pw.current, newPassword: pw.next });
      setPw({ current: "", next: "" });
      setMsg(t("p.saved"));
    } catch {
      setMsg(t("p.badLogin"));
    }
  };

  if (!data) return <p className="note">{t("p.loading")}</p>;
  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div className="card-b" style={{ padding: 16 }}>
        <p style={{ margin: 0 }}><strong>{t("p.pr.company")}:</strong> {data.name}</p>
        <p className="note" style={{ margin: "4px 0 0" }}>{data.regNo} {data.vatNo ? `· ${data.vatNo}` : ""}</p>
        <p className="note" style={{ margin: "4px 0 0" }}>{data.email}</p>
      </div>

      <div className="card-b fields" style={{ padding: 16, display: "grid", gap: 10 }}>
        <label>
          {t("p.pr.contact")}
          <input value={form.contactName} onChange={(e) => setForm({ ...form, contactName: e.target.value })} />
        </label>
        <label>
          {t("p.pr.phone")}
          <input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
        </label>
        <label>
          {t("p.pr.address")}
          <input value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} />
        </label>
        <label>
          {t("p.pr.lang")}
          <select value={form.lang} onChange={(e) => setForm({ ...form, lang: e.target.value as SupLang })}>
            {SUP_LANGS.map((l) => <option key={l} value={l}>{l.toUpperCase()}</option>)}
          </select>
        </label>
        <label>
          {t("p.pr.bank")}
          <input value={form.bankAccount} onChange={(e) => setForm({ ...form, bankAccount: e.target.value })} />
        </label>
        <p className="note" style={{ margin: 0 }}>{t("p.pr.bankNote")}</p>
        {data.pendingBankAccount ? (
          <p className="note" style={{ margin: 0 }}><strong>{data.pendingBankAccount}</strong> — {t("p.pr.bankPending")}</p>
        ) : null}
        <button className="btn" onClick={() => void save()}>{t("p.pr.save")}</button>
        {msg ? <p className="note" style={{ margin: 0 }}>{msg}</p> : null}
      </div>

      <div className="card-b fields" style={{ padding: 16, display: "grid", gap: 10 }}>
        <h2 style={{ margin: 0, fontSize: 17 }}>{t("p.pr.changePassword")}</h2>
        <label>
          {t("p.pr.currentPassword")}
          <input type="password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} />
        </label>
        <label>
          {t("p.newPassword")}
          <input type="password" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} />
        </label>
        <button className="btn btn-ghost" onClick={() => void changePassword()}>{t("p.pr.changePassword")}</button>
      </div>
    </div>
  );
}
