import { adminUsers, approvalRules, consignments, finFlags, supplierInvoices, suppliers, type Db } from "@auction/db";
import { and, asc, eq } from "drizzle-orm";
import { writeAudit } from "../audit.js";
import type { AppContext } from "../context.js";
import { raiseFlag, resolveFlag } from "./finFlags.js";
import { allocateConsignmentCost, postSupplierInvoiceApproved } from "./ledger.js";
import { notifyInvoiceCard } from "./telegramApprovals.js";

/**
 * Approval-слой закупок (fin-architecture 10.3). Пороги и маршруты НЕ зашиты
 * в код — таблица approval_rules полностью редактируется из админки:
 * диапазон суммы → approver ("auto" | "role:<roleId>" | "admin:<uuid>") +
 * флаг двойного апрува (второй — бухгалтер, до оплаты).
 *
 * Правила могут меняться, история — нет: маршрут, по которому реально пошёл
 * счёт, фиксируется в approvalRuleNote счёта.
 */

type Tx = Pick<Db, "select" | "insert" | "update">;

export interface MatchedRule {
  approver: string;
  dual: boolean;
  note: string;
}

/** Первое активное правило, чей диапазон накрывает сумму. ПУСТАЯ таблица
 *  правил = approval-слой не настроен: счета проводятся как раньше (auto) —
 *  прод получает стартовые правила миграцией 0047. Сумма ВНЕ настроенных
 *  правил — консервативный fallback: super_admin, свыше €5000 двойной. */
export async function matchApprovalRule(tx: Tx, amountCents: number): Promise<MatchedRule> {
  const rules = await tx
    .select()
    .from(approvalRules)
    .where(eq(approvalRules.isActive, true))
    .orderBy(asc(approvalRules.position), asc(approvalRules.minCents));
  if (!rules.length) return { approver: "auto", dual: false, note: "nav noteikumu — auto" };
  for (const r of rules) {
    if (amountCents >= r.minCents && (r.maxCents == null || amountCents < r.maxCents)) {
      const range = `${(r.minCents / 100).toFixed(0)}–${r.maxCents == null ? "∞" : (r.maxCents / 100).toFixed(0)} €`;
      return { approver: r.approver, dual: r.dual, note: `${r.approver}${r.dual ? " +dual" : ""} (${range})` };
    }
  }
  const dual = amountCents >= 500_000;
  return { approver: "role:super_admin", dual, note: `fallback: role:super_admin${dual ? " +dual" : ""}` };
}

/** Актор проходит по спецификации правила? super_admin апрувит всегда. */
export function actorMatchesApprover(actor: { id: string | null; roleId: string }, spec: string): boolean {
  if (actor.roleId === "super_admin") return true;
  if (spec === "auto") return true;
  if (spec.startsWith("role:")) return actor.roleId === spec.slice(5);
  if (spec.startsWith("admin:")) return actor.id === spec.slice(6);
  return false;
}

/**
 * Маршрутизация нового счёта: auto-порог проводится сразу (с ledger-строкой
 * и следом в аудите), остальное встаёт pending и получает карточку в Telegram
 * назначенным апруверам. Возвращает итоговый approvalStatus.
 */
export async function routeInvoiceApproval(
  ctx: AppContext,
  invoiceId: string,
  actor: { id: string | null; label: string },
): Promise<"auto" | "pending"> {
  const status = await ctx.db.transaction(async (tx) => {
    const [invoice] = await tx.select().from(supplierInvoices).where(eq(supplierInvoices.id, invoiceId)).for("update");
    if (!invoice) return "pending" as const;
    const rule = await matchApprovalRule(tx, invoice.amountCents);
    if (rule.approver === "auto" && !rule.dual) {
      await tx
        .update(supplierInvoices)
        .set({ approvalStatus: "auto", approvalRuleNote: rule.note, approvedBy: "auto", approvedAt: ctx.now(), updatedAt: ctx.now() })
        .where(eq(supplierInvoices.id, invoiceId));
      await postSupplierInvoiceApproved(tx, { ...invoice, approvalStatus: "auto" }, ctx.now());
      if (invoice.consignmentId) await allocateConsignmentCost(tx, invoice.consignmentId, ctx.now());
      // Суммы в аудит НЕ пишем: ленту читает audit.view без finance.view
      // (инвариант из suppliers-тестов — платёжки не светятся в хронике).
      await writeAudit(tx, actor, "finance", "supplier_invoice_auto_approved", invoice.number, { rule: rule.note });
      return "auto" as const;
    }
    await tx
      .update(supplierInvoices)
      .set({ approvalStatus: "pending", approvalRuleNote: rule.note, updatedAt: ctx.now() })
      .where(eq(supplierInvoices.id, invoiceId));
    await writeAudit(tx, actor, "finance", "supplier_invoice_routed", invoice.number, { rule: rule.note });
    return "pending" as const;
  });
  if (status === "pending") {
    // Карточка апруверам в Telegram — вне транзакции, сеть не держит базу.
    void notifyInvoiceCard(ctx, invoiceId).catch(() => undefined);
  }
  return status;
}

export type ApproveOutcome =
  | { ok: true; final: boolean }
  | { ok: false; error: "not_found" | "not_pending" | "wrong_approver" | "same_person" };

/**
 * Апрув счёта. Первый уровень — по правилу; при dual счёт остаётся pending
 * до ВТОРОЙ подписи другим человеком (бухгалтер/супер-админ) — сегрегация
 * обязанностей из раздела 10.3. Ledger-строка появляется только при
 * финальном approved.
 */
export async function approveInvoice(
  ctx: AppContext,
  invoiceId: string,
  actor: { id: string | null; label: string; roleId: string },
): Promise<ApproveOutcome> {
  const outcome = await ctx.db.transaction(async (tx) => {
    const [invoice] = await tx.select().from(supplierInvoices).where(eq(supplierInvoices.id, invoiceId)).for("update");
    if (!invoice) return { ok: false as const, error: "not_found" as const };
    if (invoice.approvalStatus !== "pending") return { ok: false as const, error: "not_pending" as const };
    const rule = await matchApprovalRule(tx, invoice.amountCents);

    if (!invoice.approvedBy) {
      // ── Первый уровень ──
      if (!actorMatchesApprover(actor, rule.approver)) return { ok: false as const, error: "wrong_approver" as const };
      if (rule.dual) {
        await tx
          .update(supplierInvoices)
          .set({ approvedBy: actor.label, approvedAt: ctx.now(), updatedAt: ctx.now() })
          .where(eq(supplierInvoices.id, invoiceId));
        await raiseFlag(tx, {
          type: "dual_approval_wait",
          title: `Rēķins ${invoice.number} gaida otro parakstu (${(invoice.amountCents / 100).toFixed(2)} €)`,
          amountCents: invoice.amountCents,
          refType: "supplier_invoice",
          refId: invoice.id,
          dedupeKey: `dual:${invoice.id}`,
        });
        await writeAudit(tx, actor, "finance", "supplier_invoice_first_approved", invoice.number, { rule: rule.note });
        return { ok: true as const, final: false };
      }
      await tx
        .update(supplierInvoices)
        .set({ approvalStatus: "approved", approvedBy: actor.label, approvedAt: ctx.now(), updatedAt: ctx.now() })
        .where(eq(supplierInvoices.id, invoiceId));
      await postSupplierInvoiceApproved(tx, invoice, ctx.now());
      if (invoice.consignmentId) await allocateConsignmentCost(tx, invoice.consignmentId, ctx.now());
      await writeAudit(tx, actor, "finance", "supplier_invoice_approved", invoice.number, { rule: rule.note });
      return { ok: true as const, final: true };
    }

    // ── Второй уровень (dual): другой человек — бухгалтер или супер-админ ──
    if (invoice.approvedBy === actor.label) return { ok: false as const, error: "same_person" as const };
    if (actor.roleId !== "finance" && actor.roleId !== "super_admin") {
      return { ok: false as const, error: "wrong_approver" as const };
    }
    await tx
      .update(supplierInvoices)
      .set({ approvalStatus: "approved", secondApprovedBy: actor.label, secondApprovedAt: ctx.now(), updatedAt: ctx.now() })
      .where(eq(supplierInvoices.id, invoiceId));
    await postSupplierInvoiceApproved(tx, invoice, ctx.now());
    if (invoice.consignmentId) await allocateConsignmentCost(tx, invoice.consignmentId, ctx.now());
    await writeAudit(tx, actor, "finance", "supplier_invoice_second_approved", invoice.number, {
      firstBy: invoice.approvedBy,
    });
    return { ok: true as const, final: true };
  });
  if (outcome.ok && outcome.final) {
    // Флаг двойного апрува закрывается при финальной подписи.
    const [flag] = await ctx.db.select({ id: finFlags.id }).from(finFlags).where(eq(finFlags.dedupeKey, `dual:${invoiceId}`));
    if (flag) await resolveFlag(ctx, flag.id, { note: "apstiprināts", actor: actor.label });
  }
  return outcome;
}

/** Отказ по счёту: причина обязательна, статус — rejected, ledger не трогаем. */
export async function rejectInvoice(
  ctx: AppContext,
  invoiceId: string,
  actor: { id: string | null; label: string; roleId: string },
  reason: string,
): Promise<{ ok: true } | { ok: false; error: "not_found" | "not_pending" }> {
  return await ctx.db.transaction(async (tx) => {
    const [invoice] = await tx.select().from(supplierInvoices).where(eq(supplierInvoices.id, invoiceId)).for("update");
    if (!invoice) return { ok: false as const, error: "not_found" as const };
    if (invoice.approvalStatus !== "pending") return { ok: false as const, error: "not_pending" as const };
    await tx
      .update(supplierInvoices)
      .set({ approvalStatus: "rejected", rejectedReason: reason, updatedAt: ctx.now() })
      .where(eq(supplierInvoices.id, invoiceId));
    await writeAudit(tx, actor, "finance", "supplier_invoice_rejected", invoice.number, { reason });
    return { ok: true as const };
  });
}

/**
 * Vendor auto-mapping (10.2): у поставщика есть умолчания отдел/категория/
 * юрлицо — новый счёт наследует их, если поле не задано руками. «Сохранить
 * как правило» — обратная запись умолчаний в карточку поставщика.
 */
export async function applySupplierDefaults(
  tx: Tx,
  supplierId: string,
  given: { department?: string | null; category?: string | null; legalEntity?: string | null },
): Promise<{ department: string | null; category: string | null; legalEntity: string }> {
  const [s] = await tx
    .select({
      defaultDepartment: suppliers.defaultDepartment,
      defaultCategory: suppliers.defaultCategory,
      defaultLegalEntity: suppliers.defaultLegalEntity,
    })
    .from(suppliers)
    .where(eq(suppliers.id, supplierId));
  return {
    department: given.department ?? s?.defaultDepartment ?? null,
    category: given.category ?? s?.defaultCategory ?? null,
    legalEntity: given.legalEntity ?? s?.defaultLegalEntity ?? "LV",
  };
}

/** Кому шлём карточку по правилу: конкретному админу или всем активным в роли. */
export async function approverAdminIds(db: Tx, spec: string): Promise<string[]> {
  if (spec.startsWith("admin:")) return [spec.slice(6)];
  if (spec.startsWith("role:")) {
    const rows = await db
      .select({ id: adminUsers.id })
      .from(adminUsers)
      .where(and(eq(adminUsers.roleId, spec.slice(5)), eq(adminUsers.active, true)));
    return rows.map((r) => r.id);
  }
  return [];
}

/** Для карточки: имя поставщика и связка с поставкой. */
export async function invoiceCardData(
  db: Tx,
  invoiceId: string,
): Promise<{ invoice: typeof supplierInvoices.$inferSelect; supplierName: string; consignmentRef: string | null } | null> {
  const [row] = await db
    .select({ invoice: supplierInvoices, supplierName: suppliers.name })
    .from(supplierInvoices)
    .innerJoin(suppliers, eq(supplierInvoices.supplierId, suppliers.id))
    .where(eq(supplierInvoices.id, invoiceId));
  if (!row) return null;
  let consignmentRef: string | null = null;
  if (row.invoice.consignmentId) {
    const [c] = await db.select({ ref: consignments.ref }).from(consignments).where(eq(consignments.id, row.invoice.consignmentId));
    consignmentRef = c?.ref ?? null;
  }
  return { invoice: row.invoice, supplierName: row.supplierName, consignmentRef };
}
