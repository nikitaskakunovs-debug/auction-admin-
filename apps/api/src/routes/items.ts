import { items } from "@auction/db";
import { assertItemTransition, ITEM_STATUSES, type ItemStatus } from "@auction/domain";
import { desc, eq, ilike, or, and } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { writeAudit } from "../audit.js";
import type { AppContext } from "../context.js";
import { requirePermission, type PermissionService } from "../auth/rbac.js";

const actor = (req: { admin?: { sub: string; name: string } }) => ({
  id: req.admin?.sub ?? null,
  label: req.admin?.name ?? "Unknown",
});

const itemBody = z.object({
  sku: z.string().min(1),
  title: z.string().min(1),
  description: z.string().default(""),
  condition: z.string().default("good"),
  location: z.string().default(""),
  weightGrams: z.number().int().positive().nullable().optional(),
  dims: z.object({ l: z.number(), w: z.number(), h: z.number() }).nullable().optional(),
  photos: z.array(z.string()).default([]),
  marketCode: z.string().length(2),
});

export function registerItemRoutes(app: FastifyInstance, ctx: AppContext, perms: PermissionService): void {
  const guard = (p: Parameters<typeof requirePermission>[1]) => ({ preHandler: requirePermission(perms, p) });

  app.get("/api/items", guard("items.view"), async (req) => {
    const q = req.query as { status?: string; q?: string };
    const conditions = [];
    if (q.status) conditions.push(eq(items.status, q.status));
    if (q.q) conditions.push(or(ilike(items.title, `%${q.q}%`), ilike(items.sku, `%${q.q}%`)));
    const rows = await ctx.db
      .select()
      .from(items)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(items.createdAt))
      .limit(500);
    return { items: rows };
  });

  app.get("/api/items/:id", guard("items.view"), async (req, reply) => {
    const [row] = await ctx.db.select().from(items).where(eq(items.id, (req.params as { id: string }).id));
    if (!row) return reply.code(404).send({ error: "not_found" });
    return { item: row };
  });

  app.post("/api/items", guard("items.create"), async (req, reply) => {
    const body = itemBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body", detail: body.error.flatten() });
    const [row] = await ctx.db
      .insert(items)
      .values({ ...body.data, weightGrams: body.data.weightGrams ?? null, dims: body.data.dims ?? null })
      .returning();
    await writeAudit(ctx.db, actor(req), "item", "created", row!.sku);
    return { item: row };
  });

  app.patch("/api/items/:id", guard("items.edit"), async (req, reply) => {
    const body = itemBody.partial().safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body", detail: body.error.flatten() });
    const { id } = req.params as { id: string };
    const [row] = await ctx.db
      .update(items)
      .set({ ...body.data, weightGrams: body.data.weightGrams ?? undefined, dims: body.data.dims ?? undefined, updatedAt: ctx.now() })
      .where(eq(items.id, id))
      .returning();
    if (!row) return reply.code(404).send({ error: "not_found" });
    await writeAudit(ctx.db, actor(req), "item", "updated", row.sku, { fields: Object.keys(body.data) });
    return { item: row };
  });

  const transitionBody = z.object({ to: z.enum(ITEM_STATUSES) });
  app.post("/api/items/:id/transition", guard("items.transition"), async (req, reply) => {
    const body = transitionBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body" });
    const { id } = req.params as { id: string };
    try {
      const row = await ctx.db.transaction(async (tx) => {
        const [item] = await tx.select().from(items).where(eq(items.id, id)).for("update");
        if (!item) return null;
        assertItemTransition(item.status as ItemStatus, body.data.to);
        const [updated] = await tx
          .update(items)
          .set({ status: body.data.to, updatedAt: ctx.now() })
          .where(eq(items.id, id))
          .returning();
        await writeAudit(tx, actor(req), "item", "transition", item.sku, { from: item.status, to: body.data.to });
        return updated;
      });
      if (!row) return reply.code(404).send({ error: "not_found" });
      return { item: row };
    } catch (err) {
      return reply.code(409).send({ error: "illegal_transition", detail: (err as Error).message });
    }
  });

  app.delete("/api/items/:id", guard("items.delete"), async (req, reply) => {
    const { id } = req.params as { id: string };
    const deleted = await ctx.db.transaction(async (tx) => {
      const [item] = await tx.select().from(items).where(eq(items.id, id)).for("update");
      if (!item) return null;
      if (item.status !== "draft") return "not_draft" as const;
      await tx.delete(items).where(eq(items.id, id));
      await writeAudit(tx, actor(req), "item", "deleted", item.sku);
      return item;
    });
    if (deleted === null) return reply.code(404).send({ error: "not_found" });
    if (deleted === "not_draft") return reply.code(409).send({ error: "only_draft_items_deletable" });
    return { ok: true };
  });
}
