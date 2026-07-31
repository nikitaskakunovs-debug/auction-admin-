import { adminUsers, appSettings, auditLog, conditionPresets, items } from "@auction/db";
import { conditionRequiresNotes, isKnownCondition } from "@auction/domain";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { slackGradeRejected } from "../engine/slackNotify.js";
import { writeAudit, type Actor } from "../audit.js";
import { publishAdminEvent, type AppContext } from "../context.js";
import { requirePermission, type PermissionService } from "../auth/rbac.js";

const actor = (req: { admin?: { sub: string; name: string } }): Actor => ({
  id: req.admin?.sub ?? null,
  label: req.admin?.name ?? "Unknown",
});

/** app_settings key: when truthy, EVERY grade goes through review. */
export const GRADING_REVIEW_ALL_KEY = "grading.reviewAll";

type PresetText = { id: string; textLv: string; textRu: string; textEn: string };

/**
 * Phase W2 grading review + condition presets:
 * - /api/condition-presets — the standardized chip texts workers pick from
 *   when grading (editable in Settings by super-admin / listing-manager);
 * - /api/grading/* — the review queue (approve / edit / reject), the worker's
 *   notice banner feed, and the reviewAll settings toggle.
 * Grading itself happens on PATCH /api/items/:id (the grading station's
 * existing condition-update path) — see routes/items.ts.
 */
export function registerGradingRoutes(app: FastifyInstance, ctx: AppContext, perms: PermissionService): void {
  const guard = (p: Parameters<typeof requirePermission>[1]) => ({ preHandler: requirePermission(perms, p) });

  // ── Condition presets ──────────────────────────────────────────────────────

  app.get("/api/condition-presets", guard("items.view"), async (req, reply) => {
    const all = (req.query as { all?: string }).all === "1";
    // ?all=1 (the settings editor, inactive rows included) is reviewer-only.
    if (all && !(await perms.has(req.admin!.role, "grading.review")))
      return reply.code(403).send({ error: "forbidden", permission: "grading.review" });
    const rows = await ctx.db
      .select()
      .from(conditionPresets)
      .where(all ? undefined : eq(conditionPresets.active, true))
      .orderBy(asc(conditionPresets.conditionCode), asc(conditionPresets.position));
    return { presets: rows };
  });

  const presetBody = z.object({
    conditionCode: z.string().refine(isKnownCondition, "unknown condition"),
    textLv: z.string().trim().min(1).max(120),
    textRu: z.string().trim().min(1).max(120),
    textEn: z.string().trim().min(1).max(120),
    position: z.number().int().min(0).max(999).default(0),
    active: z.boolean().default(true),
  });

  app.post("/api/condition-presets", guard("grading.review"), async (req, reply) => {
    const body = presetBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body", detail: body.error.flatten() });
    const [row] = await ctx.db.insert(conditionPresets).values(body.data).returning();
    await writeAudit(ctx.db, actor(req), "settings", "condition_preset_created", body.data.conditionCode, {
      id: row!.id,
      textEn: row!.textEn,
    });
    return { preset: row };
  });

  app.patch("/api/condition-presets/:id", guard("grading.review"), async (req, reply) => {
    const body = presetBody.partial().safeParse(req.body);
    if (!body.success || Object.keys(body.data).length === 0)
      return reply.code(400).send({ error: "invalid_body", detail: body.success ? undefined : body.error.flatten() });
    const { id } = req.params as { id: string };
    const [row] = await ctx.db.update(conditionPresets).set(body.data).where(eq(conditionPresets.id, id)).returning();
    if (!row) return reply.code(404).send({ error: "not_found" });
    await writeAudit(ctx.db, actor(req), "settings", "condition_preset_updated", row.conditionCode, {
      id,
      fields: Object.keys(body.data),
    });
    return { preset: row };
  });

  /** Soft delete — items keep referencing the id, so rows are only retired. */
  app.delete("/api/condition-presets/:id", guard("grading.review"), async (req, reply) => {
    const { id } = req.params as { id: string };
    const [row] = await ctx.db
      .update(conditionPresets)
      .set({ active: false })
      .where(eq(conditionPresets.id, id))
      .returning();
    if (!row) return reply.code(404).send({ error: "not_found" });
    await writeAudit(ctx.db, actor(req), "settings", "condition_preset_deactivated", row.conditionCode, {
      id,
      textEn: row.textEn,
    });
    return { ok: true, preset: row };
  });

  // ── Review queue ───────────────────────────────────────────────────────────

  app.get("/api/grading/review", guard("grading.review"), async () => {
    const grader = alias(adminUsers, "grader");
    const rows = await ctx.db
      .select({ item: items, graderName: grader.name })
      .from(items)
      .leftJoin(grader, eq(items.gradedById, grader.id))
      .where(eq(items.gradeStatus, "pending_review"))
      .orderBy(asc(items.gradedAt))
      .limit(200);
    // Resolve the picked preset ids to their chip texts in one query.
    const allIds = [...new Set(rows.flatMap((r) => r.item.conditionPresetIds))];
    const presetRows = allIds.length
      ? await ctx.db
          .select({
            id: conditionPresets.id,
            textLv: conditionPresets.textLv,
            textRu: conditionPresets.textRu,
            textEn: conditionPresets.textEn,
          })
          .from(conditionPresets)
          .where(inArray(conditionPresets.id, allIds))
      : [];
    const byId = new Map(presetRows.map((p) => [p.id, p]));
    return {
      items: rows.map((r) => ({
        id: r.item.id,
        sku: r.item.sku,
        title: r.item.title,
        condition: r.item.condition,
        conditionNotes: r.item.conditionNotes,
        conditionPresetIds: r.item.conditionPresetIds,
        presets: r.item.conditionPresetIds.map((id) => byId.get(id)).filter((p): p is PresetText => p !== undefined),
        graderName: r.graderName,
        gradedAt: r.item.gradedAt?.toISOString() ?? null,
        photos: r.item.photos,
      })),
    };
  });

  app.post("/api/grading/:itemId/approve", guard("grading.review"), async (req, reply) => {
    const { itemId } = req.params as { itemId: string };
    const result = await ctx.db.transaction(async (tx) => {
      const [item] = await tx.select().from(items).where(eq(items.id, itemId)).for("update");
      if (!item) return null;
      if (item.gradeStatus !== "pending_review") return "not_pending" as const;
      const [row] = await tx
        .update(items)
        .set({ gradeStatus: "approved", reviewedById: req.admin!.sub, reviewedAt: ctx.now(), updatedAt: ctx.now() })
        .where(eq(items.id, itemId))
        .returning();
      await writeAudit(tx, actor(req), "item", "grade_approved", item.sku, { condition: item.condition });
      return row!;
    });
    if (result === null) return reply.code(404).send({ error: "not_found" });
    if (result === "not_pending") return reply.code(409).send({ error: "not_pending_review" });
    return { item: result };
  });

  const editBody = z.object({
    condition: z.string().refine(isKnownCondition, "unknown condition").optional(),
    conditionNotes: z.string().max(2000).optional(),
    conditionPresetIds: z.array(z.string().uuid()).max(20).optional(),
  });

  app.post("/api/grading/:itemId/edit", guard("grading.review"), async (req, reply) => {
    const body = editBody.safeParse(req.body);
    if (!body.success || Object.keys(body.data).length === 0)
      return reply.code(400).send({ error: "invalid_body", detail: body.success ? undefined : body.error.flatten() });
    const { itemId } = req.params as { itemId: string };
    const result = await ctx.db.transaction(async (tx) => {
      const [item] = await tx.select().from(items).where(eq(items.id, itemId)).for("update");
      if (!item) return null;
      if (item.gradeStatus !== "pending_review") return "not_pending" as const;
      const next = {
        condition: body.data.condition ?? item.condition,
        conditionNotes: body.data.conditionNotes ?? item.conditionNotes,
        conditionPresetIds: body.data.conditionPresetIds ?? item.conditionPresetIds,
      };
      if (conditionRequiresNotes(next.condition) && next.conditionNotes.trim().length < 3 && next.conditionPresetIds.length === 0)
        return "notes_required" as const;
      if (next.conditionPresetIds.length > 0) {
        const unique = [...new Set(next.conditionPresetIds)];
        const found = await tx
          .select({ id: conditionPresets.id })
          .from(conditionPresets)
          .where(inArray(conditionPresets.id, unique));
        if (found.length !== unique.length) return "unknown_preset" as const;
      }
      const [row] = await tx
        .update(items)
        .set({
          ...next,
          gradeStatus: "approved",
          reviewedById: req.admin!.sub,
          reviewedAt: ctx.now(),
          gradeNoticePending: true,
          updatedAt: ctx.now(),
        })
        .where(eq(items.id, itemId))
        .returning();
      // The audit row is the record the worker's notice banner (and the item
      // timeline) shows "was: X → now: Y" from — always both sides.
      await writeAudit(tx, actor(req), "item", "grade_edited", item.sku, {
        old: { condition: item.condition, conditionNotes: item.conditionNotes, conditionPresetIds: item.conditionPresetIds },
        new: next,
      });
      return row!;
    });
    if (result === null) return reply.code(404).send({ error: "not_found" });
    if (result === "not_pending") return reply.code(409).send({ error: "not_pending_review" });
    if (result === "notes_required") return reply.code(400).send({ error: "condition_notes_required" });
    if (result === "unknown_preset") return reply.code(422).send({ error: "unknown_preset" });
    await publishAdminEvent(ctx, {
      type: "grade_edited",
      at: ctx.now().toISOString(),
      data: { itemId: result.id, sku: result.sku, condition: result.condition },
    });
    return { item: result };
  });

  const rejectBody = z.object({ reason: z.string().trim().min(1).max(300) });

  app.post("/api/grading/:itemId/reject", guard("grading.review"), async (req, reply) => {
    const body = rejectBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body", detail: body.error.flatten() });
    const { itemId } = req.params as { itemId: string };
    const result = await ctx.db.transaction(async (tx) => {
      const [item] = await tx.select().from(items).where(eq(items.id, itemId)).for("update");
      if (!item) return null;
      if (item.gradeStatus !== "pending_review") return "not_pending" as const;
      const [row] = await tx
        .update(items)
        .set({
          gradeStatus: "rejected",
          gradeRejectReason: body.data.reason,
          reviewedById: req.admin!.sub,
          reviewedAt: ctx.now(),
          gradeNoticePending: true,
          updatedAt: ctx.now(),
        })
        .where(eq(items.id, itemId))
        .returning();
      await writeAudit(tx, actor(req), "item", "grade_rejected", item.sku, {
        condition: item.condition,
        reason: body.data.reason,
      });
      return row!;
    });
    if (result === null) return reply.code(404).send({ error: "not_found" });
    if (result === "not_pending") return reply.code(409).send({ error: "not_pending_review" });
    await publishAdminEvent(ctx, {
      type: "grade_rejected",
      at: ctx.now().toISOString(),
      data: { itemId: result.id, sku: result.sku, reason: result.gradeRejectReason },
    });
    slackGradeRejected(ctx, {
      sku: result.sku,
      title: result.title,
      reason: result.gradeRejectReason ?? "",
      reviewer: actor(req).label,
    });
    return { item: result };
  });

  // ── Worker notices (edited/rejected grades the grader hasn't seen) ─────────

  app.get("/api/grading/notices", guard("items.view"), async (req) => {
    const reviewer = alias(adminUsers, "reviewer");
    const rows = await ctx.db
      .select({ item: items, reviewerName: reviewer.name })
      .from(items)
      .leftJoin(reviewer, eq(items.reviewedById, reviewer.id))
      .where(and(eq(items.gradedById, req.admin!.sub), eq(items.gradeNoticePending, true)))
      .orderBy(desc(items.reviewedAt))
      .limit(100);
    const notices = [];
    for (const r of rows) {
      const kind = r.item.gradeStatus === "rejected" ? ("rejected" as const) : ("edited" as const);
      let oldCondition: string | null = null;
      let newCondition: string | null = null;
      if (kind === "edited") {
        // The latest grade_edited audit row carries the before→after values.
        const [audit] = await ctx.db
          .select()
          .from(auditLog)
          .where(and(eq(auditLog.action, "grade_edited"), eq(auditLog.target, r.item.sku)))
          .orderBy(desc(auditLog.createdAt))
          .limit(1);
        const detail = audit?.detail as { old?: { condition?: string }; new?: { condition?: string } } | null;
        oldCondition = detail?.old?.condition ?? null;
        newCondition = detail?.new?.condition ?? null;
      }
      notices.push({
        itemId: r.item.id,
        sku: r.item.sku,
        title: r.item.title,
        kind,
        rejectReason: r.item.gradeRejectReason,
        oldCondition,
        newCondition,
        condition: r.item.condition,
        reviewerName: r.reviewerName,
        reviewedAt: r.item.reviewedAt?.toISOString() ?? null,
      });
    }
    return { notices };
  });

  app.post("/api/grading/:itemId/notice-ack", guard("items.view"), async (req, reply) => {
    const { itemId } = req.params as { itemId: string };
    const result = await ctx.db.transaction(async (tx) => {
      const [item] = await tx.select().from(items).where(eq(items.id, itemId)).for("update");
      if (!item) return null;
      // Only the grader themselves dismisses their banner.
      if (item.gradedById !== req.admin!.sub) return "not_grader" as const;
      if (!item.gradeNoticePending) return "ok" as const; // idempotent
      await tx.update(items).set({ gradeNoticePending: false, updatedAt: ctx.now() }).where(eq(items.id, itemId));
      await writeAudit(tx, actor(req), "item", "grade_notice_ack", item.sku, { gradeStatus: item.gradeStatus });
      return "ok" as const;
    });
    if (result === null) return reply.code(404).send({ error: "not_found" });
    if (result === "not_grader") return reply.code(403).send({ error: "not_grader" });
    return { ok: true };
  });

  // ── Settings toggle: review everything ─────────────────────────────────────

  app.get("/api/settings/grading", guard("grading.review"), async () => {
    const [row] = await ctx.db.select().from(appSettings).where(eq(appSettings.key, GRADING_REVIEW_ALL_KEY));
    return { reviewAll: row?.value === true };
  });

  const settingsBody = z.object({ reviewAll: z.boolean() });
  app.put("/api/settings/grading", guard("settings.edit"), async (req, reply) => {
    const body = settingsBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body", detail: body.error.flatten() });
    await ctx.db
      .insert(appSettings)
      .values({ key: GRADING_REVIEW_ALL_KEY, value: body.data.reviewAll, updatedAt: ctx.now() })
      .onConflictDoUpdate({ target: appSettings.key, set: { value: body.data.reviewAll, updatedAt: ctx.now() } });
    await writeAudit(ctx.db, actor(req), "settings", "grading_review_all", String(body.data.reviewAll));
    return { reviewAll: body.data.reviewAll };
  });
}
