import { itemCommentReads, itemComments, items, notifications, pickupTickets } from "@auction/db";
import { dayKey } from "@auction/domain";
import { and, eq, gt, isNull, or, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.js";
import type { PermissionService } from "../auth/rbac.js";

/** Comments older than this never count as unread (matches /api/comments/unread). */
const UNREAD_WINDOW_DAYS = 30;

/**
 * A3 sidebar pills — one call returns every "work waiting" count the signed-in
 * admin is allowed to see. The client refreshes it on the live events that can
 * change these numbers (check-ins, grading, comments) plus a slow interval.
 */
export function registerBadgeRoutes(app: FastifyInstance, ctx: AppContext, perms: PermissionService): void {
  app.get("/api/badges", async (req, reply) => {
    if (!req.admin) return reply.code(401).send({ error: "unauthenticated" });
    const have = await perms.permissionsFor(req.admin.role);
    const badges: Record<string, number> = {};

    if (have.has("pickup.view")) {
      const [row] = await ctx.db
        .select({ n: sql<string>`count(*)` })
        .from(pickupTickets)
        .where(and(eq(pickupTickets.dayKey, dayKey(ctx.now())), eq(pickupTickets.status, "waiting")));
      badges.pickup = Number(row!.n);
    }

    if (have.has("grading.review")) {
      const [row] = await ctx.db
        .select({ n: sql<string>`count(*)` })
        .from(items)
        .where(eq(items.gradeStatus, "pending_review"));
      badges.receiving = Number(row!.n);
    }

    if (have.has("items.view")) {
      const cutoff = new Date(ctx.now().getTime() - UNREAD_WINDOW_DAYS * 86_400_000);
      const [row] = await ctx.db
        .select({ n: sql<string>`count(distinct ${itemComments.itemId})` })
        .from(itemComments)
        .leftJoin(
          itemCommentReads,
          and(eq(itemCommentReads.itemId, itemComments.itemId), eq(itemCommentReads.userId, req.admin.sub)),
        )
        .where(
          and(
            gt(itemComments.createdAt, cutoff),
            or(isNull(itemCommentReads.lastReadAt), gt(itemComments.createdAt, itemCommentReads.lastReadAt)),
          ),
        );
      badges.inventory = Number(row!.n);
    }

    if (have.has("audit.view")) {
      const [row] = await ctx.db
        .select({ n: sql<string>`count(*)` })
        .from(notifications)
        .where(eq(notifications.status, "failed"));
      badges.notifications = Number(row!.n);
    }

    return { badges };
  });
}
