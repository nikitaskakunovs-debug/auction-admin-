import { savedViews } from "@auction/db";
import { and, asc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context.js";

/**
 * Saved filter views — named presets per admin per list screen, synced to the
 * account (unlike Shhh's per-browser localStorage). The filter payload is an
 * opaque JSON blob owned by the screen that saved it.
 */

const SCREEN = /^[a-z]{2,24}$/;

export function registerViewRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get("/api/views", async (req, reply) => {
    if (!req.admin) return reply.code(401).send({ error: "unauthenticated" });
    const screen = (req.query as { screen?: string }).screen ?? "";
    if (!SCREEN.test(screen)) return reply.code(400).send({ error: "invalid_screen" });
    const rows = await ctx.db
      .select()
      .from(savedViews)
      .where(and(eq(savedViews.userId, req.admin.sub), eq(savedViews.screen, screen)))
      .orderBy(asc(savedViews.position), asc(savedViews.createdAt));
    return { views: rows };
  });

  const createBody = z.object({
    screen: z.string().regex(SCREEN),
    name: z.string().min(1).max(60),
    filters: z.record(z.unknown()),
  });
  app.post("/api/views", async (req, reply) => {
    if (!req.admin) return reply.code(401).send({ error: "unauthenticated" });
    const body = createBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body" });
    const mine = await ctx.db
      .select({ id: savedViews.id })
      .from(savedViews)
      .where(and(eq(savedViews.userId, req.admin.sub), eq(savedViews.screen, body.data.screen)));
    if (mine.length >= 20) return reply.code(409).send({ error: "too_many_views" });
    const [row] = await ctx.db
      .insert(savedViews)
      .values({ userId: req.admin.sub, screen: body.data.screen, name: body.data.name.trim(), filters: body.data.filters, position: mine.length })
      .returning();
    return { view: row };
  });

  const patchBody = z.object({
    name: z.string().min(1).max(60).optional(),
    filters: z.record(z.unknown()).optional(),
    position: z.number().int().min(0).optional(),
  });
  app.patch("/api/views/:id", async (req, reply) => {
    if (!req.admin) return reply.code(401).send({ error: "unauthenticated" });
    const body = patchBody.safeParse(req.body);
    if (!body.success || Object.keys(body.data).length === 0) return reply.code(400).send({ error: "invalid_body" });
    const [row] = await ctx.db
      .update(savedViews)
      .set(body.data)
      .where(and(eq(savedViews.id, (req.params as { id: string }).id), eq(savedViews.userId, req.admin.sub)))
      .returning();
    if (!row) return reply.code(404).send({ error: "not_found" });
    return { view: row };
  });

  app.delete("/api/views/:id", async (req, reply) => {
    if (!req.admin) return reply.code(401).send({ error: "unauthenticated" });
    const [row] = await ctx.db
      .delete(savedViews)
      .where(and(eq(savedViews.id, (req.params as { id: string }).id), eq(savedViews.userId, req.admin.sub)))
      .returning();
    if (!row) return reply.code(404).send({ error: "not_found" });
    return { ok: true };
  });
}
