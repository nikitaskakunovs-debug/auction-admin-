import { itemCommentReads, itemComments, items } from "@auction/db";
import { and, asc, desc, eq, gt, isNull, or, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { publishAdminEvent, type AppContext } from "../context.js";
import { requirePermission, type PermissionService } from "../auth/rbac.js";

const MAX_COMMENT_CHARS = 2000;
const UNREAD_WINDOW_DAYS = 30;
const UNREAD_MAX_ROWS = 50;

/**
 * Phase W2 item comments — the per-item conversation between warehouse and
 * admin ("who said what" on one lot), plus per-user read cursors that drive
 * the unread badges. Gated like viewing items: any admin/warehouse role with
 * items.view can read and write.
 */
export function registerItemCommentRoutes(app: FastifyInstance, ctx: AppContext, perms: PermissionService): void {
  const guard = (p: Parameters<typeof requirePermission>[1]) => ({ preHandler: requirePermission(perms, p) });

  app.get("/api/items/:id/comments", guard("items.view"), async (req, reply) => {
    const { id } = req.params as { id: string };
    const [item] = await ctx.db.select({ id: items.id }).from(items).where(eq(items.id, id));
    if (!item) return reply.code(404).send({ error: "not_found" });
    const rows = await ctx.db
      .select()
      .from(itemComments)
      .where(eq(itemComments.itemId, id))
      .orderBy(asc(itemComments.createdAt))
      .limit(500);
    const [read] = await ctx.db
      .select()
      .from(itemCommentReads)
      .where(and(eq(itemCommentReads.userId, req.admin!.sub), eq(itemCommentReads.itemId, id)));
    return {
      comments: rows.map((c) => ({
        id: c.id,
        userId: c.userId,
        authorLabel: c.authorLabel,
        body: c.body,
        createdAt: c.createdAt.toISOString(),
      })),
      lastReadAt: read?.lastReadAt.toISOString() ?? null,
    };
  });

  const commentBody = z.object({ body: z.string() });

  app.post("/api/items/:id/comments", guard("items.view"), async (req, reply) => {
    const parsed = commentBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body", detail: parsed.error.flatten() });
    const text = parsed.data.body.trim();
    if (text.length === 0 || text.length > MAX_COMMENT_CHARS)
      return reply.code(400).send({ error: "invalid_body", detail: `1–${MAX_COMMENT_CHARS} characters` });
    const { id } = req.params as { id: string };
    const now = ctx.now();
    const result = await ctx.db.transaction(async (tx) => {
      const [item] = await tx.select({ id: items.id, sku: items.sku }).from(items).where(eq(items.id, id));
      if (!item) return null;
      const [comment] = await tx
        .insert(itemComments)
        .values({ itemId: id, userId: req.admin!.sub, authorLabel: req.admin!.name, body: text, createdAt: now })
        .returning();
      // The poster has obviously read the thread up to their own message —
      // keeps their own comments out of their unread badge.
      await tx
        .insert(itemCommentReads)
        .values({ userId: req.admin!.sub, itemId: id, lastReadAt: now })
        .onConflictDoUpdate({ target: [itemCommentReads.userId, itemCommentReads.itemId], set: { lastReadAt: now } });
      return { comment: comment!, sku: item.sku };
    });
    if (result === null) return reply.code(404).send({ error: "not_found" });
    await publishAdminEvent(ctx, {
      type: "item_comment",
      at: now.toISOString(),
      data: { itemId: id, sku: result.sku },
    });
    return {
      comment: {
        id: result.comment.id,
        userId: result.comment.userId,
        authorLabel: result.comment.authorLabel,
        body: result.comment.body,
        createdAt: result.comment.createdAt.toISOString(),
      },
    };
  });

  app.post("/api/items/:id/comments/read", guard("items.view"), async (req, reply) => {
    const { id } = req.params as { id: string };
    const [item] = await ctx.db.select({ id: items.id }).from(items).where(eq(items.id, id));
    if (!item) return reply.code(404).send({ error: "not_found" });
    const now = ctx.now();
    await ctx.db
      .insert(itemCommentReads)
      .values({ userId: req.admin!.sub, itemId: id, lastReadAt: now })
      .onConflictDoUpdate({ target: [itemCommentReads.userId, itemCommentReads.itemId], set: { lastReadAt: now } });
    return { ok: true, lastReadAt: now.toISOString() };
  });

  /** Badge counts: items with comments (last 30 days) newer than my cursor. */
  app.get("/api/comments/unread", guard("items.view"), async (req) => {
    const cutoff = new Date(ctx.now().getTime() - UNREAD_WINDOW_DAYS * 86_400_000);
    const rows = await ctx.db
      .select({
        itemId: itemComments.itemId,
        sku: items.sku,
        count: sql<string>`count(*)`,
        latest: sql<string>`max(${itemComments.createdAt})`,
      })
      .from(itemComments)
      .innerJoin(items, eq(itemComments.itemId, items.id))
      .leftJoin(
        itemCommentReads,
        and(eq(itemCommentReads.itemId, itemComments.itemId), eq(itemCommentReads.userId, req.admin!.sub)),
      )
      .where(
        and(
          gt(itemComments.createdAt, cutoff),
          or(isNull(itemCommentReads.lastReadAt), gt(itemComments.createdAt, itemCommentReads.lastReadAt)),
        ),
      )
      .groupBy(itemComments.itemId, items.sku)
      .orderBy(desc(sql`max(${itemComments.createdAt})`))
      .limit(UNREAD_MAX_ROWS);
    return { unread: rows.map((r) => ({ itemId: r.itemId, sku: r.sku, count: Number(r.count) })) };
  });
}
