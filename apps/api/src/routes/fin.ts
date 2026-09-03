import { approvalRules, exportBatches, finFlags, ledgerEntries, orders, refunds, supplierInvoices, suppliers } from "@auction/db";
import { and, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { writeAudit } from "../audit.js";
import { verifyAccessToken } from "../auth/jwt.js";
import { requirePermission, type PermissionService } from "../auth/rbac.js";
import type { AppContext } from "../context.js";
import { approveInvoice, rejectInvoice } from "../engine/approvals.js";
import { resolveFlag } from "../engine/finFlags.js";
import { FIN_SETTING_DEFAULTS, FIN_SETTING_KEYS, getFinSettings, setFinSetting, type FinSettingKey } from "../engine/finSettings.js";
import { buildExportCsv, buildExportXml, createExportBatch, FIN_ACCOUNTS, postManual } from "../engine/ledger.js";
import { closeRefund, markRefundPaid } from "../engine/refund.js";
import { adminByChatId, answerCallback, completeLink, createLinkCode } from "../engine/telegramApprovals.js";

const actor = (req: { admin?: { sub: string; name: string; role: string } }) => ({
  id: req.admin?.sub ?? null,
  label: req.admin?.name ?? "Unknown",
});

/**
 * Финансовый слой (fin-architecture): флаги, Refund Pending, журнал проводок
 * с экспортом, approval-очередь счетов с правилами и Telegram-привязкой,
 * настройки порогов. RBAC — по матрице раздела 13: бухгалтер (finance) видит
 * и разруливает, но НЕ апрувит платежи и НЕ правит правила.
 */
export function registerFinRoutes(app: FastifyInstance, ctx: AppContext, perms: PermissionService): void {
  const guard = (p: Parameters<typeof requirePermission>[1]) => ({ preHandler: requirePermission(perms, p) });

  // ── Karodziņi: единая очередь «требует внимания» ──────────────────────────
  app.get("/api/fin/flags", guard("fin.flags_view"), async (req) => {
    const q = req.query as { status?: string; type?: string };
    const conds = [] as ReturnType<typeof eq>[];
    conds.push(eq(finFlags.status, q.status === "resolved" ? "resolved" : "open"));
    if (q.type) conds.push(eq(finFlags.type, q.type));
    const rows = await ctx.db
      .select()
      .from(finFlags)
      .where(and(...conds))
      .orderBy(desc(finFlags.createdAt))
      .limit(300);
    const [openCount] = await ctx.db
      .select({ n: sql<string>`count(*)` })
      .from(finFlags)
      .where(eq(finFlags.status, "open"));
    return { flags: rows, openCount: Number(openCount!.n) };
  });

  app.post("/api/fin/flags/:id/resolve", guard("fin.flags_resolve"), async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z.object({ note: z.string().min(1).max(1000) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body" });
    const ok = await resolveFlag(ctx, id, { note: body.data.note, actor: req.admin!.name });
    if (!ok) return reply.code(404).send({ error: "not_found" });
    await writeAudit(ctx.db, actor(req), "finance", "fin_flag_resolved", id, { note: body.data.note });
    return { ok: true };
  });

  // ── Atmaksas: очередь Refund Pending ──────────────────────────────────────
  app.get("/api/fin/refunds", guard("fin.refunds_manage"), async (req) => {
    const q = req.query as { status?: string };
    const statuses = q.status ? [q.status] : ["requested", "awaiting_manual", "paid"];
    const rows = await ctx.db
      .select({ refund: refunds, orderRef: orders.ref, customerAlias: orders.customerAlias, totalCents: orders.totalCents })
      .from(refunds)
      .innerJoin(orders, eq(refunds.orderId, orders.id))
      .where(inArray(refunds.status, statuses))
      .orderBy(desc(refunds.createdAt))
      .limit(300);
    return { refunds: rows.map((r) => ({ ...r.refund, orderRef: r.orderRef, customerAlias: r.customerAlias, orderTotalCents: r.totalCents })) };
  });

  app.post("/api/fin/refunds/:id/mark-paid", guard("fin.refunds_manage"), async (req, reply) => {
    const { id } = req.params as { id: string };
    const result = await markRefundPaid(ctx, id, actor(req));
    if (!result.ok) return reply.code(result.error === "not_found" ? 404 : 409).send({ error: result.error });
    return { ok: true };
  });

  app.post("/api/fin/refunds/:id/close", guard("fin.refunds_manage"), async (req, reply) => {
    const { id } = req.params as { id: string };
    const ok = await closeRefund(ctx, id, actor(req));
    if (!ok) return reply.code(409).send({ error: "not_paid" });
    return { ok: true };
  });

  // ── Grāmatojumi: журнал + экспорт ─────────────────────────────────────────
  app.get("/api/fin/ledger", guard("fin.ledger_view"), async (req) => {
    const q = req.query as { from?: string; to?: string; account?: string; orderRef?: string; page?: string };
    const conds = [];
    if (q.from) conds.push(gte(ledgerEntries.eventAt, new Date(q.from)));
    if (q.to) conds.push(lte(ledgerEntries.eventAt, new Date(`${q.to}T23:59:59.999Z`)));
    if (q.account) conds.push(eq(ledgerEntries.account, q.account));
    if (q.orderRef) conds.push(eq(ledgerEntries.orderRef, q.orderRef));
    const page = Math.max(1, Number(q.page) || 1);
    const rows = await ctx.db
      .select()
      .from(ledgerEntries)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(ledgerEntries.eventAt), desc(ledgerEntries.createdAt))
      .limit(100)
      .offset((page - 1) * 100);
    return { entries: rows, accounts: FIN_ACCOUNTS, page };
  });

  app.get("/api/fin/export-batches", guard("fin.export"), async () => {
    const rows = await ctx.db.select().from(exportBatches).orderBy(desc(exportBatches.createdAt)).limit(100);
    return { batches: rows };
  });

  const exportBody = z.object({
    from: z.coerce.date(),
    to: z.coerce.date(),
    format: z.enum(["csv", "xml"]),
  });
  app.post("/api/fin/export", guard("fin.export"), async (req, reply) => {
    const body = exportBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body" });
    const result = await createExportBatch(ctx, { fromAt: body.data.from, toAt: body.data.to, format: body.data.format, actor: req.admin!.name });
    if ("error" in result) return reply.code(422).send({ error: "no_entries" });
    await writeAudit(ctx.db, actor(req), "finance", "ledger_exported", result.batchId, { entryCount: result.entryCount, format: body.data.format });
    // Сам файл скачивается GET-ом ниже (window.open + ?token=).
    return { batchId: result.batchId, entryCount: result.entryCount, filename: result.filename };
  });

  /** Скачивание батча — window.open, поэтому токен разрешён и в query
   *  (тот же паттерн, что /api/invoices/:id/html). */
  app.get("/api/fin/export-batches/:id/download", async (req, reply) => {
    let admin = req.admin;
    if (!admin) {
      const token = (req.query as { token?: string }).token;
      const claims = token ? verifyAccessToken(token, ctx.config.jwtSecret, ctx.now().getTime()) : null;
      if (claims?.kind === "admin") admin = claims;
    }
    if (!admin) return reply.code(401).send({ error: "unauthenticated" });
    if (!(await perms.has(admin.role, "fin.export"))) return reply.code(403).send({ error: "forbidden" });
    const { id } = req.params as { id: string };
    const [batch] = await ctx.db.select().from(exportBatches).where(eq(exportBatches.id, id));
    if (!batch) return reply.code(404).send({ error: "not_found" });
    const entries = await ctx.db
      .select()
      .from(ledgerEntries)
      .where(eq(ledgerEntries.exportBatchId, id))
      .orderBy(ledgerEntries.eventAt, ledgerEntries.createdAt);
    const stamp = batch.toAt.toISOString().slice(0, 10);
    const content = batch.format === "csv"
      ? buildExportCsv(entries)
      : buildExportXml(entries, { id: batch.id, fromAt: batch.fromAt, toAt: batch.toAt });
    reply
      .header("content-type", batch.format === "csv" ? "text/csv; charset=utf-8" : "application/xml; charset=utf-8")
      .header("content-disposition", `attachment; filename="izsoli-ledger-${stamp}.${batch.format}"`);
    return reply.send(content);
  });

  /** Ручные проводки: goodwill, претензии к перевозчику, списание. */
  const manualBody = z.object({
    kind: z.enum(["goodwill", "carrier_claim", "carrier_claim_settled", "writeoff"]),
    amountCents: z.number().int().positive(),
    orderRef: z.string().max(32).optional(),
    memo: z.string().min(3).max(500),
    department: z.string().max(64).optional(),
  });
  app.post("/api/fin/manual-entry", guard("fin.refunds_manage"), async (req, reply) => {
    const body = manualBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body" });
    await postManual(ctx.db, {
      kind: body.data.kind,
      amountCents: body.data.amountCents,
      orderRef: body.data.orderRef ?? null,
      memo: body.data.memo,
      department: body.data.department ?? null,
      actor: req.admin!.name,
    }, ctx.now());
    await writeAudit(ctx.db, actor(req), "finance", "manual_ledger_entry", body.data.kind, {
      amountCents: body.data.amountCents,
      memo: body.data.memo,
    });
    return { ok: true };
  });

  // ── Apstiprināšana: очередь счетов + approval ─────────────────────────────
  app.get("/api/fin/approvals", guard("fin.approvals_view"), async (req) => {
    const q = req.query as { status?: string };
    const status = q.status ?? "pending";
    const rows = await ctx.db
      .select({ invoice: supplierInvoices, supplierName: suppliers.name })
      .from(supplierInvoices)
      .innerJoin(suppliers, eq(supplierInvoices.supplierId, suppliers.id))
      .where(eq(supplierInvoices.approvalStatus, status))
      .orderBy(desc(supplierInvoices.createdAt))
      .limit(300);
    return { invoices: rows.map((r) => ({ ...r.invoice, supplierName: r.supplierName })) };
  });

  app.post("/api/fin/approvals/:id/approve", guard("fin.approvals_view"), async (req, reply) => {
    const { id } = req.params as { id: string };
    // Кто ИМЕННО может подписать — решает правило (role:/admin:), сегрегацию
    // проверяет движок; guard выше лишь отсекает посторонних от очереди.
    const result = await approveInvoice(ctx, id, { ...actor(req), roleId: req.admin!.role });
    if (!result.ok) {
      const code = result.error === "not_found" ? 404 : result.error === "not_pending" ? 409 : 403;
      return reply.code(code).send({ error: result.error });
    }
    return { ok: true, final: result.final };
  });

  app.post("/api/fin/approvals/:id/reject", guard("fin.approvals_view"), async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z.object({ reason: z.string().min(3).max(500) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body" });
    const result = await rejectInvoice(ctx, id, { ...actor(req), roleId: req.admin!.role }, body.data.reason);
    if (!result.ok) return reply.code(result.error === "not_found" ? 404 : 409).send({ error: result.error });
    return { ok: true };
  });

  /** PDF счёта в карточку (base64 — маленькие файлы, до ~10 МБ). */
  const fileBody = z.object({ dataUrl: z.string().max(14_000_000), filename: z.string().max(200).optional() });
  app.post("/api/supplier-invoices/:id/file", guard("finance.view"), async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = fileBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body" });
    const m = /^data:(application\/pdf|image\/(?:png|jpe?g|webp));base64,(.+)$/.exec(body.data.dataUrl);
    if (!m) return reply.code(422).send({ error: "unsupported_type", detail: "PDF vai attēls" });
    const [inv] = await ctx.db.select().from(supplierInvoices).where(eq(supplierInvoices.id, id));
    if (!inv) return reply.code(404).send({ error: "not_found" });
    const buf = Buffer.from(m[2]!, "base64");
    const ext = m[1] === "application/pdf" ? "pdf" : m[1]!.split("/")[1]!.replace("jpeg", "jpg");
    const key = `supplier-invoices/${id}.${ext}`;
    const url = await ctx.storage.put(key, buf, m[1]!);
    await ctx.db.update(supplierInvoices).set({ fileKey: url, updatedAt: ctx.now() }).where(eq(supplierInvoices.id, id));
    await writeAudit(ctx.db, actor(req), "finance", "supplier_invoice_file", inv.number, { key });
    return { ok: true, url };
  });

  // ── Правила approval — только fin.rules_edit (супер-админ) ────────────────
  app.get("/api/fin/rules", guard("fin.approvals_view"), async () => {
    const rows = await ctx.db.select().from(approvalRules).orderBy(approvalRules.position, approvalRules.minCents);
    return { rules: rows };
  });

  const ruleBody = z.object({
    minCents: z.number().int().min(0),
    maxCents: z.number().int().positive().nullable(),
    approver: z.string().regex(/^(auto|role:[a-z_]+|admin:[0-9a-f-]{36})$/),
    dual: z.boolean().default(false),
    position: z.number().int().min(0).default(0),
    isActive: z.boolean().default(true),
  });
  app.post("/api/fin/rules", guard("fin.rules_edit"), async (req, reply) => {
    const body = ruleBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body", detail: body.error.flatten() });
    const [row] = await ctx.db
      .insert(approvalRules)
      .values({ ...body.data, updatedAt: ctx.now(), updatedBy: req.admin!.name })
      .returning();
    await writeAudit(ctx.db, actor(req), "finance", "approval_rule_created", row!.id, body.data);
    return { rule: row };
  });

  app.patch("/api/fin/rules/:id", guard("fin.rules_edit"), async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = ruleBody.partial().safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body" });
    const [row] = await ctx.db
      .update(approvalRules)
      .set({ ...body.data, updatedAt: ctx.now(), updatedBy: req.admin!.name })
      .where(eq(approvalRules.id, id))
      .returning();
    if (!row) return reply.code(404).send({ error: "not_found" });
    await writeAudit(ctx.db, actor(req), "finance", "approval_rule_updated", id, body.data);
    return { rule: row };
  });

  app.delete("/api/fin/rules/:id", guard("fin.rules_edit"), async (req, reply) => {
    const { id } = req.params as { id: string };
    const [row] = await ctx.db.delete(approvalRules).where(eq(approvalRules.id, id)).returning({ id: approvalRules.id });
    if (!row) return reply.code(404).send({ error: "not_found" });
    await writeAudit(ctx.db, actor(req), "finance", "approval_rule_deleted", id, {});
    return { ok: true };
  });

  // ── Настройки финслоя ─────────────────────────────────────────────────────
  app.get("/api/fin/settings", guard("fin.flags_view"), async () => {
    return { settings: await getFinSettings(ctx), defaults: FIN_SETTING_DEFAULTS };
  });

  app.put("/api/fin/settings", guard("fin.rules_edit"), async (req, reply) => {
    const body = z.record(z.string(), z.number().min(0)).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body" });
    for (const [key, value] of Object.entries(body.data)) {
      if (!FIN_SETTING_KEYS.includes(key as FinSettingKey)) return reply.code(422).send({ error: "unknown_key", key });
      await setFinSetting(ctx, key as FinSettingKey, value, req.admin!.name);
    }
    await writeAudit(ctx.db, actor(req), "finance", "fin_settings_updated", "fin", body.data);
    return { settings: await getFinSettings(ctx) };
  });

  // ── Telegram-привязка апрувера ────────────────────────────────────────────
  app.post("/api/fin/telegram/link", guard("fin.approvals_view"), async (req) => {
    const code = await createLinkCode(ctx, req.admin!.sub);
    return { code, enabled: Boolean(ctx.config.telegramApprovals) };
  });

  /**
   * Webhook бота апрувов. Аутентификация: секрет из setWebhook
   * (X-Telegram-Bot-Api-Secret-Token) + привязка chat_id к админу — чужой чат
   * не может ни привязаться без кода, ни апрувить.
   */
  app.post("/api/telegram/approvals/webhook", async (req, reply) => {
    const cfg = ctx.config.telegramApprovals;
    if (!cfg) return reply.code(404).send({ error: "disabled" });
    if (cfg.webhookSecret && req.headers["x-telegram-bot-api-secret-token"] !== cfg.webhookSecret) {
      return reply.code(403).send({ error: "forbidden" });
    }
    const update = req.body as {
      message?: { chat?: { id?: number }; text?: string };
      callback_query?: { id: string; data?: string; from?: unknown; message?: { chat?: { id?: number }; message_id?: number } };
    };
    // /start <код> — привязка чата к админу.
    const msg = update.message;
    if (msg?.chat?.id && typeof msg.text === "string" && msg.text.startsWith("/start")) {
      const code = msg.text.split(/\s+/)[1] ?? "";
      const ok = code ? await completeLink(ctx, code, String(msg.chat.id)) : false;
      const { config } = ctx;
      await fetch(`https://api.telegram.org/bot${config.telegramApprovals!.botToken}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: msg.chat.id,
          text: ok ? "✅ Telegram piesaistīts — apstiprināšanas kartītes nāks šeit." : "Kods nederīgs. Admin panelī: Finanses → Piesaistīt Telegram.",
        }),
      }).catch(() => undefined);
      return { ok: true };
    }
    // Кнопки Apstiprināt / Noraidīt.
    const cb = update.callback_query;
    if (cb?.data && cb.message?.chat?.id) {
      const chatId = String(cb.message.chat.id);
      const admin = await adminByChatId(ctx, chatId);
      const m = /^inv:([0-9a-f-]{36}):(ok|no)$/.exec(cb.data);
      if (!admin || !m) {
        await answerCallback(ctx, { callbackId: cb.id, chatId, messageId: null, verdict: "Nav piekļuves" });
        return { ok: true };
      }
      if (m[2] === "ok") {
        const result = await approveInvoice(ctx, m[1]!, admin);
        const verdict = result.ok
          ? result.final ? "✅ Apstiprināts" : "✅ Pirmais paraksts — gaida otro (grāmatvedis)"
          : result.error === "wrong_approver" ? "❌ Šo rēķinu apstiprina cita loma"
            : result.error === "same_person" ? "❌ Otrais paraksts jādod citam cilvēkam"
              : "❌ Rēķins vairs nav rindā";
        await answerCallback(ctx, { callbackId: cb.id, chatId, messageId: cb.message.message_id ?? null, verdict });
      } else {
        const result = await rejectInvoice(ctx, m[1]!, admin, `Noraidīts Telegram (${admin.label})`);
        await answerCallback(ctx, {
          callbackId: cb.id,
          chatId,
          messageId: cb.message.message_id ?? null,
          verdict: result.ok ? "❌ Noraidīts" : "Rēķins vairs nav rindā",
        });
      }
      return { ok: true };
    }
    return { ok: true };
  });
}
