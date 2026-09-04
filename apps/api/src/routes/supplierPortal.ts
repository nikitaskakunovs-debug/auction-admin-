import { createHash, randomBytes } from "node:crypto";
import {
  consignments, counters, hashPassword, items, orders, suppliers, supplierInvoices, supplierPayments, verifyPassword,
} from "@auction/db";
import { formatConsignmentRef } from "@auction/domain";
import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { writeAudit, SYSTEM_ACTOR } from "../audit.js";
import { signAccessToken } from "../auth/jwt.js";
import type { AppContext } from "../context.js";
import { raiseFlag } from "../engine/finFlags.js";
import { renderNotification } from "../engine/notifications.js";
import { sendSupplierWelcome } from "../engine/supplierMail.js";
import { routeInvoiceApproval } from "../engine/approvals.js";

/**
 * Кабинет поставщика (/piegadatajs) — пять экранов и ничего лишнего:
 * сводка, поставки, реализация, счета с платежами, профиль.
 *
 * Три правила, на которых он держится:
 *  1) вход только по приглашению из админки — самостоятельной регистрации
 *     нет вовсе, поэтому чужой человек не заведёт себе «поставщика»;
 *  2) каждый запрос читает ТОЛЬКО данные своего поставщика — id берётся из
 *     токена, никогда из тела запроса;
 *  3) смена банковского счёта не вступает в силу сама: новый IBAN ждёт
 *     подтверждения менеджера, а на прежний адрес уходит предупреждение.
 */

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");
const DAY_MS = 86_400_000;

export function registerSupplierPortalRoutes(app: FastifyInstance, ctx: AppContext): void {
  /** id поставщика из токена — единственный источник, кому что показывать. */
  const requireSupplier = (req: FastifyRequest, reply: FastifyReply): string | null => {
    if (!req.supplier) {
      void reply.code(401).send({ error: "unauthenticated" });
      return null;
    }
    return req.supplier.sub;
  };

  const issueToken = async (sup: { id: string; email: string; name: string }): Promise<string> => {
    await ctx.db.update(suppliers).set({ portalLastLoginAt: ctx.now() }).where(eq(suppliers.id, sup.id));
    return signAccessToken(
      { sub: sup.id, kind: "supplier", email: sup.email, name: sup.name, role: "supplier" },
      ctx.config.jwtSecret,
      // Кабинет открывают раз в неделю-две, а не живут в нём: срок токена
      // длиннее покупательского, но это по-прежнему сессия, а не пропуск.
      ctx.config.accessTokenTtlSec * 4,
      ctx.now().getTime(),
    );
  };

  // ── Вход по приглашению ──────────────────────────────────────────────────

  /** Проверка ссылки из письма S1 до показа формы пароля. */
  app.get("/api/piegadatajs/invite/:token", async (req, reply) => {
    const { token } = req.params as { token: string };
    const [sup] = await ctx.db
      .select({ id: suppliers.id, name: suppliers.name, expires: suppliers.inviteExpiresAt })
      .from(suppliers)
      .where(and(eq(suppliers.inviteTokenHash, sha256(token)), eq(suppliers.active, true)));
    if (!sup || !sup.expires || sup.expires.getTime() < ctx.now().getTime()) {
      return reply.code(404).send({ error: "invite_invalid" });
    }
    return { supplierName: sup.name };
  });

  /** Установка пароля по приглашению → сразу вход и приветственное письмо. */
  app.post("/api/piegadatajs/invite/:token", async (req, reply) => {
    const { token } = req.params as { token: string };
    const body = z.object({ password: z.string().min(8).max(200) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "weak_password" });
    const [sup] = await ctx.db
      .select()
      .from(suppliers)
      .where(and(eq(suppliers.inviteTokenHash, sha256(token)), eq(suppliers.active, true)));
    if (!sup || !sup.inviteExpiresAt || sup.inviteExpiresAt.getTime() < ctx.now().getTime()) {
      return reply.code(404).send({ error: "invite_invalid" });
    }
    const firstTime = sup.passwordHash === null;
    await ctx.db
      .update(suppliers)
      .set({
        passwordHash: await hashPassword(body.data.password),
        inviteTokenHash: null,
        inviteExpiresAt: null,
        updatedAt: ctx.now(),
      })
      .where(eq(suppliers.id, sup.id));
    await writeAudit(ctx.db, SYSTEM_ACTOR, "finance", "supplier_portal_activated", sup.name, {});
    // Письмо S2 — только при первой активации, а не при каждом сбросе.
    if (firstTime) await sendSupplierWelcome(ctx, sup.id).catch(() => undefined);
    return { accessToken: await issueToken(sup), supplierName: sup.name };
  });

  app.post("/api/piegadatajs/login", async (req, reply) => {
    const body = z.object({ email: z.string().email(), password: z.string().min(1) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body" });
    const [sup] = await ctx.db
      .select()
      .from(suppliers)
      .where(and(eq(suppliers.email, body.data.email.toLowerCase()), eq(suppliers.active, true)));
    // Одинаковый ответ в обоих случаях: по нему нельзя перебрать, кто наш
    // поставщик, а кто нет.
    if (!sup?.passwordHash || !(await verifyPassword(body.data.password, sup.passwordHash))) {
      return reply.code(401).send({ error: "invalid_credentials" });
    }
    return { accessToken: await issueToken(sup), supplierName: sup.name };
  });

  /** Забыли пароль: новая ссылка-приглашение на адрес из карточки. */
  app.post("/api/piegadatajs/forgot", async (req, reply) => {
    const body = z.object({ email: z.string().email() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body" });
    void (async () => {
      const [sup] = await ctx.db
        .select()
        .from(suppliers)
        .where(and(eq(suppliers.email, body.data.email.toLowerCase()), eq(suppliers.active, true)));
      if (!sup) return;
      const token = randomBytes(32).toString("base64url");
      await ctx.db
        .update(suppliers)
        .set({ inviteTokenHash: sha256(token), inviteExpiresAt: new Date(ctx.now().getTime() + 2 * DAY_MS) })
        .where(eq(suppliers.id, sup.id));
      const url = `${ctx.config.supplierPortalUrl}/piegadatajs/parole?token=${token}`;
      const msg = await renderNotification(ctx, "sup_invite", (sup.lang as "lv" | "ru" | "en") ?? "lv", {
        alias: sup.contactName.trim() || sup.name,
        lotTitle: "",
        supplierName: sup.name,
        inviteUrl: url,
        inviteDays: 2,
      });
      await ctx.email.send({ to: sup.email, subject: msg.subject, text: msg.text, html: msg.html });
    })().catch((err) => req.log.error({ err }, "supplier portal reset failed"));
    // Ответ всегда одинаковый — существование поставщика не подтверждаем.
    return { ok: true };
  });

  // ── Экран 1: Sākums ──────────────────────────────────────────────────────

  app.get("/api/piegadatajs/summary", async (req, reply) => {
    const supplierId = requireSupplier(req, reply);
    if (!supplierId) return;
    const [sup] = await ctx.db.select().from(suppliers).where(eq(suppliers.id, supplierId));
    if (!sup) return reply.code(401).send({ error: "unauthenticated" });

    const [deliveries] = await ctx.db
      .select({
        announced: sql<string>`count(*) filter (where ${consignments.status} = 'announced')`,
        open: sql<string>`count(*) filter (where ${consignments.status} = 'open')`,
        awaitingReply: sql<string>`count(*) filter (where ${consignments.discrepancyStatus} = 'open')`,
      })
      .from(consignments)
      .where(eq(consignments.supplierId, supplierId));

    const [stock] = await ctx.db
      .select({
        inStock: sql<string>`count(*) filter (where ${items.status} in ('draft','listed','live','unsold'))`,
        sold: sql<string>`count(*) filter (where ${items.status} not in ('draft','listed','live','unsold'))`,
      })
      .from(items)
      .innerJoin(consignments, eq(items.consignmentId, consignments.id))
      .where(eq(consignments.supplierId, supplierId));

    // Что мы должны: неоплаченные счета минус уже отправленные платежи.
    const [owed] = await ctx.db
      .select({
        outstanding: sql<string>`coalesce(sum(${supplierInvoices.amountCents} - coalesce((
          select sum(sp.amount_cents) from supplier_payments sp where sp.invoice_id = supplier_invoices.id), 0)), 0)`,
        nextDue: sql<string | null>`min(${supplierInvoices.dueDate}) filter (where ${supplierInvoices.status} in ('unpaid','partly_paid'))`,
      })
      .from(supplierInvoices)
      .where(and(eq(supplierInvoices.supplierId, supplierId), inArray(supplierInvoices.status, ["unpaid", "partly_paid"])));

    return {
      supplier: {
        name: sup.name,
        model: sup.model,
        commissionPercent: sup.model === "commission" ? Math.round(sup.commissionBp / 100) : 0,
        paymentTermsDays: sup.paymentTermsDays,
        lang: sup.lang,
      },
      deliveries: {
        announced: Number(deliveries?.announced ?? 0),
        open: Number(deliveries?.open ?? 0),
        awaitingReply: Number(deliveries?.awaitingReply ?? 0),
      },
      stock: { inStock: Number(stock?.inStock ?? 0), sold: Number(stock?.sold ?? 0) },
      money: {
        outstandingCents: Number(owed?.outstanding ?? 0),
        nextDueDate: owed?.nextDue ?? null,
      },
    };
  });

  // ── Экран 2: Piegādes ────────────────────────────────────────────────────

  app.get("/api/piegadatajs/deliveries", async (req, reply) => {
    const supplierId = requireSupplier(req, reply);
    if (!supplierId) return;
    const rows = await ctx.db
      .select({
        id: consignments.id,
        ref: consignments.ref,
        status: consignments.status,
        expectedCount: consignments.expectedCount,
        plannedAt: consignments.plannedAt,
        createdAt: consignments.createdAt,
        closedAt: consignments.closedAt,
        discrepancyStatus: consignments.discrepancyStatus,
        discrepancyNote: consignments.discrepancyNote,
        discrepancyDueAt: consignments.discrepancyDueAt,
        discrepancyReply: consignments.discrepancyReply,
        received: sql<string>`(select count(*) from items i where i.consignment_id = consignments.id)`,
      })
      .from(consignments)
      .where(eq(consignments.supplierId, supplierId))
      .orderBy(desc(consignments.createdAt))
      .limit(200);
    return {
      deliveries: rows.map((r) => ({ ...r, receivedCount: Number(r.received), received: undefined })),
    };
  });

  /** Заявка на поставку: «везу столько-то, такого-то числа». */
  app.post("/api/piegadatajs/deliveries", async (req, reply) => {
    const supplierId = requireSupplier(req, reply);
    if (!supplierId) return;
    const body = z
      .object({ expectedCount: z.number().int().min(1).max(100_000), plannedAt: z.coerce.date(), notes: z.string().max(1000).optional() })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body", detail: body.error.flatten() });
    const [sup] = await ctx.db.select().from(suppliers).where(eq(suppliers.id, supplierId));
    if (!sup) return reply.code(401).send({ error: "unauthenticated" });

    // Номер поставки берём тем же счётчиком, что и склад, — чтобы заявка и
    // приёмка жили под одним ref и в кабинете, и в админке.
    const row = await ctx.db.transaction(async (tx) => {
      await tx.insert(counters).values({ key: "consignment_ref", value: 0 }).onConflictDoNothing();
      const [c] = await tx
        .update(counters)
        .set({ value: sql`${counters.value} + 1` })
        .where(eq(counters.key, "consignment_ref"))
        .returning({ value: counters.value });
      const ref = formatConsignmentRef(c!.value);
      const [created] = await tx
      .insert(consignments)
      .values({
        ref,
        supplier: sup.name,
        supplierId,
        marketCode: "LV",
        status: "announced",
        expectedCount: body.data.expectedCount,
        plannedAt: body.data.plannedAt,
        notes: body.data.notes ?? "",
      })
        .returning();
      await writeAudit(tx, SYSTEM_ACTOR, "item", "consignment_announced", ref, {
        supplier: sup.name,
        expectedCount: body.data.expectedCount,
      });
      return created;
    });
    return { delivery: row };
  });

  /** Ответ на расхождение: согласен или оспариваю (письмо S4 зовёт сюда). */
  app.post("/api/piegadatajs/deliveries/:id/reply", async (req, reply) => {
    const supplierId = requireSupplier(req, reply);
    if (!supplierId) return;
    const { id } = req.params as { id: string };
    const body = z
      .object({ decision: z.enum(["accept", "dispute"]), note: z.string().max(2000).optional() })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body" });
    if (body.data.decision === "dispute" && !body.data.note?.trim()) {
      return reply.code(422).send({ error: "note_required" });
    }
    const [row] = await ctx.db
      .update(consignments)
      .set({
        discrepancyStatus: body.data.decision === "accept" ? "accepted" : "disputed",
        discrepancyReply: body.data.note ?? "",
        discrepancyRepliedAt: ctx.now(),
      })
      .where(and(eq(consignments.id, id), eq(consignments.supplierId, supplierId), eq(consignments.discrepancyStatus, "open")))
      .returning();
    if (!row) return reply.code(404).send({ error: "not_found" });
    // Спор — это работа для нас: поднимаем флаг в общую очередь внимания.
    if (body.data.decision === "dispute") {
      await raiseFlag(ctx.db, {
        type: "partner_mismatch",
        title: `Piegādātājs apstrīd pieņemšanas aktu ${row.ref}`,
        details: { reply: body.data.note ?? "", consignmentRef: row.ref },
        refType: "consignment",
        refId: row.id,
        dedupeKey: `sup_dispute:${row.id}`,
      });
    }
    await writeAudit(ctx.db, SYSTEM_ACTOR, "item", `consignment_discrepancy_${body.data.decision}`, row.ref, {});
    return { delivery: row };
  });

  // ── Экран 3: Realizācija ─────────────────────────────────────────────────

  app.get("/api/piegadatajs/sales", async (req, reply) => {
    const supplierId = requireSupplier(req, reply);
    if (!supplierId) return;
    const q = req.query as { from?: string; to?: string };
    const from = q.from ? new Date(q.from) : new Date(ctx.now().getTime() - 90 * DAY_MS);
    const to = q.to ? new Date(`${q.to}T23:59:59.999Z`) : ctx.now();
    const [sup] = await ctx.db.select().from(suppliers).where(eq(suppliers.id, supplierId));
    if (!sup) return reply.code(401).send({ error: "unauthenticated" });

    // Владелец подтвердил: поставщик видит цены, по которым его товар ушёл.
    const sold = await ctx.db
      .select({
        title: items.title,
        sku: items.sku,
        priceCents: orders.totalCents,
        paidAt: orders.paidAt,
        consignmentRef: consignments.ref,
      })
      .from(orders)
      .innerJoin(items, eq(orders.itemId, items.id))
      .innerJoin(consignments, eq(items.consignmentId, consignments.id))
      .where(
        and(
          eq(consignments.supplierId, supplierId),
          eq(orders.status, "paid"),
          isNotNull(orders.paidAt),
          sql`${orders.paidAt} >= ${from}`,
          sql`${orders.paidAt} <= ${to}`,
        ),
      )
      .orderBy(desc(orders.paidAt))
      .limit(500);

    const [counts] = await ctx.db
      .select({
        total: sql<string>`count(*)`,
        unsold: sql<string>`count(*) filter (where ${items.status} in ('draft','listed','live','unsold'))`,
      })
      .from(items)
      .innerJoin(consignments, eq(items.consignmentId, consignments.id))
      .where(eq(consignments.supplierId, supplierId));

    const grossCents = sold.reduce((s, r) => s + r.priceCents, 0);
    const commissionCents = sup.model === "commission" ? Math.round((grossCents * sup.commissionBp) / 10_000) : 0;
    const total = Number(counts?.total ?? 0);
    const unsold = Number(counts?.unsold ?? 0);
    return {
      period: { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) },
      lots: sold,
      totals: {
        soldCount: sold.length,
        grossCents,
        commissionCents,
        payoutCents: sup.model === "commission" ? grossCents - commissionCents : 0,
        inStock: unsold,
        sellThroughPercent: total > 0 ? Math.round(((total - unsold) / total) * 100) : 0,
      },
    };
  });

  // ── Экран 4: Rēķini un maksājumi ─────────────────────────────────────────

  app.get("/api/piegadatajs/invoices", async (req, reply) => {
    const supplierId = requireSupplier(req, reply);
    if (!supplierId) return;
    const invoices = await ctx.db
      .select({
        id: supplierInvoices.id,
        number: supplierInvoices.number,
        invoiceDate: supplierInvoices.invoiceDate,
        dueDate: supplierInvoices.dueDate,
        amountCents: supplierInvoices.amountCents,
        status: supplierInvoices.status,
        approvalStatus: supplierInvoices.approvalStatus,
        rejectedReason: supplierInvoices.rejectedReason,
        consignmentRef: consignments.ref,
        paidCents: sql<string>`coalesce((select sum(sp.amount_cents) from supplier_payments sp
          where sp.invoice_id = supplier_invoices.id), 0)`,
      })
      .from(supplierInvoices)
      .leftJoin(consignments, eq(supplierInvoices.consignmentId, consignments.id))
      .where(eq(supplierInvoices.supplierId, supplierId))
      .orderBy(desc(supplierInvoices.invoiceDate))
      .limit(200);
    const payments = await ctx.db
      .select({
        id: supplierPayments.id,
        amountCents: supplierPayments.amountCents,
        paidAt: supplierPayments.paidAt,
        method: supplierPayments.method,
        invoiceNumber: supplierInvoices.number,
      })
      .from(supplierPayments)
      .innerJoin(supplierInvoices, eq(supplierPayments.invoiceId, supplierInvoices.id))
      .where(eq(supplierInvoices.supplierId, supplierId))
      .orderBy(desc(supplierPayments.paidAt))
      .limit(200);
    return {
      invoices: invoices.map((r) => ({ ...r, paidCents: Number(r.paidCents) })),
      payments,
    };
  });

  /** Загрузка счёта: он сразу попадает в нашу очередь согласования. */
  app.post("/api/piegadatajs/invoices", async (req, reply) => {
    const supplierId = requireSupplier(req, reply);
    if (!supplierId) return;
    const body = z
      .object({
        number: z.string().min(1).max(64),
        invoiceDate: z.coerce.date(),
        amountCents: z.number().int().min(1).max(1_000_000_000),
        consignmentId: z.string().uuid().optional(),
        /** PDF или фото счёта (data:URL, до ~10 МБ). */
        fileDataUrl: z.string().max(14_000_000).optional(),
      })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body", detail: body.error.flatten() });
    const [sup] = await ctx.db.select().from(suppliers).where(eq(suppliers.id, supplierId));
    if (!sup) return reply.code(401).send({ error: "unauthenticated" });

    // Поставка обязана быть своей — иначе счёт «привяжется» к чужой партии.
    if (body.data.consignmentId) {
      const [own] = await ctx.db
        .select({ id: consignments.id })
        .from(consignments)
        .where(and(eq(consignments.id, body.data.consignmentId), eq(consignments.supplierId, supplierId)));
      if (!own) return reply.code(404).send({ error: "consignment_not_found" });
    }
    const [dup] = await ctx.db
      .select({ id: supplierInvoices.id })
      .from(supplierInvoices)
      .where(and(eq(supplierInvoices.supplierId, supplierId), eq(supplierInvoices.number, body.data.number.trim())));
    if (dup) return reply.code(409).send({ error: "invoice_exists" });

    let fileKey: string | null = null;
    if (body.data.fileDataUrl) {
      const m = /^data:(application\/pdf|image\/(?:png|jpe?g|webp));base64,(.+)$/.exec(body.data.fileDataUrl);
      if (!m) return reply.code(422).send({ error: "unsupported_file" });
      const ext = m[1] === "application/pdf" ? "pdf" : m[1]!.split("/")[1]!.replace("jpeg", "jpg");
      fileKey = await ctx.storage.put(
        `supplier-invoices/${supplierId}-${Date.now()}.${ext}`,
        Buffer.from(m[2]!, "base64"),
        m[1]!,
      );
    }

    const [created] = await ctx.db
      .insert(supplierInvoices)
      .values({
        supplierId,
        consignmentId: body.data.consignmentId ?? null,
        number: body.data.number.trim(),
        invoiceDate: body.data.invoiceDate,
        dueDate: new Date(body.data.invoiceDate.getTime() + sup.paymentTermsDays * DAY_MS),
        amountCents: body.data.amountCents,
        status: "unpaid",
        department: sup.defaultDepartment,
        category: sup.defaultCategory,
        legalEntity: sup.defaultLegalEntity ?? "LV",
        approvalStatus: "pending",
        fileKey,
      })
      .returning();
    await writeAudit(ctx.db, SYSTEM_ACTOR, "finance", "supplier_invoice_uploaded", created!.number, {
      supplier: sup.name,
    });
    // Дальше счёт идёт обычным путём согласования — как заведённый вручную.
    await routeInvoiceApproval(ctx, created!.id, { id: null, label: `${sup.name} (kabinets)` });
    return { invoice: { id: created!.id, number: created!.number, amountCents: created!.amountCents } };
  });

  // ── Экран 5: Profils ─────────────────────────────────────────────────────

  app.get("/api/piegadatajs/profile", async (req, reply) => {
    const supplierId = requireSupplier(req, reply);
    if (!supplierId) return;
    const [sup] = await ctx.db.select().from(suppliers).where(eq(suppliers.id, supplierId));
    if (!sup) return reply.code(401).send({ error: "unauthenticated" });
    return {
      profile: {
        name: sup.name,
        regNo: sup.regNo,
        vatNo: sup.vatNo,
        email: sup.email,
        phone: sup.phone,
        address: sup.address,
        contactName: sup.contactName,
        lang: sup.lang,
        bankAccount: sup.bankAccount,
        pendingBankAccount: sup.pendingBankAccount,
        model: sup.model,
        commissionPercent: sup.model === "commission" ? Math.round(sup.commissionBp / 100) : 0,
        paymentTermsDays: sup.paymentTermsDays,
      },
    };
  });

  app.patch("/api/piegadatajs/profile", async (req, reply) => {
    const supplierId = requireSupplier(req, reply);
    if (!supplierId) return;
    const body = z
      .object({
        contactName: z.string().max(120).optional(),
        phone: z.string().max(32).optional(),
        address: z.string().max(200).optional(),
        lang: z.enum(["lv", "ru", "en"]).optional(),
        /** IBAN меняется через подтверждение — сразу он не применяется. */
        bankAccount: z.string().max(34).optional(),
      })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body" });
    const [sup] = await ctx.db.select().from(suppliers).where(eq(suppliers.id, supplierId));
    if (!sup) return reply.code(401).send({ error: "unauthenticated" });

    const patch: Record<string, unknown> = { updatedAt: ctx.now() };
    for (const k of ["contactName", "phone", "address", "lang"] as const) {
      if (body.data[k] !== undefined) patch[k] = body.data[k];
    }

    // ── Смена банковского счёта ──
    // Самая частая атака на закупки — письмо «мы сменили банк». Поэтому:
    // новый IBAN только ЗАЯВЛЕН, платить по нему нельзя до подтверждения
    // менеджером, предупреждение уходит на прежний адрес, и в очередь
    // внимания падает флаг.
    let bankPending = false;
    const nextIban = body.data.bankAccount?.replace(/\s+/g, "").toUpperCase();
    if (nextIban && nextIban !== sup.bankAccount) {
      patch.pendingBankAccount = nextIban;
      patch.pendingBankRequestedAt = ctx.now();
      bankPending = true;
    }
    await ctx.db.update(suppliers).set(patch).where(eq(suppliers.id, supplierId));

    if (bankPending) {
      await raiseFlag(ctx.db, {
        type: "partner_mismatch",
        title: `Piegādātājs ${sup.name} lūdz mainīt bankas kontu`,
        details: { from: sup.bankAccount, to: nextIban, requestedAt: ctx.now().toISOString() },
        refType: "supplier",
        refId: supplierId,
        dedupeKey: `bank_change:${supplierId}:${nextIban}`,
      });
      await writeAudit(ctx.db, SYSTEM_ACTOR, "finance", "supplier_bank_change_requested", sup.name, {});
      // Предупреждение на ПРЕЖНИЙ адрес: если реквизиты меняет чужой,
      // настоящий поставщик узнает об этом сразу.
      if (sup.email) {
        const msg = await renderNotification(ctx, "security_alert", (sup.lang as "lv" | "ru" | "en") ?? "lv", {
          alias: sup.contactName.trim() || sup.name,
          lotTitle: "",
          securityEvent: "bank_change",
          deviceLabel: sup.name,
          eventAt: ctx.now(),
        });
        await ctx.email.send({ to: sup.email, subject: msg.subject, text: msg.text, html: msg.html }).catch(() => undefined);
      }
    }
    return { ok: true, bankPending };
  });

  app.post("/api/piegadatajs/password", async (req, reply) => {
    const supplierId = requireSupplier(req, reply);
    if (!supplierId) return;
    const body = z
      .object({ currentPassword: z.string().min(1), newPassword: z.string().min(8).max(200) })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body" });
    const [sup] = await ctx.db.select().from(suppliers).where(eq(suppliers.id, supplierId));
    if (!sup?.passwordHash || !(await verifyPassword(body.data.currentPassword, sup.passwordHash))) {
      return reply.code(401).send({ error: "invalid_credentials" });
    }
    await ctx.db
      .update(suppliers)
      .set({ passwordHash: await hashPassword(body.data.newPassword), updatedAt: ctx.now() })
      .where(eq(suppliers.id, supplierId));
    return { ok: true };
  });
}
