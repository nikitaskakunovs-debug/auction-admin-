import { cmsPages, type CmsBlock, type CmsLocalized } from "@auction/db";
import { asc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { writeAudit } from "../audit.js";
import { requirePermission, type PermissionService } from "../auth/rbac.js";
import type { AppContext } from "../context.js";

const actor = (req: { admin?: { sub: string; name: string } }) => ({
  id: req.admin?.sub ?? null,
  label: req.admin?.name ?? "Unknown",
});

const localized = z.object({ lv: z.string(), ru: z.string(), en: z.string() });

const blockSchema: z.ZodType<CmsBlock> = z.discriminatedUnion("type", [
  z.object({ type: z.literal("heading"), text: localized }),
  z.object({ type: z.literal("text"), text: localized }),
  z.object({ type: z.literal("image"), url: z.string().url(), alt: localized }),
  z.object({ type: z.literal("faq"), question: localized, answer: localized }),
  z.object({ type: z.literal("divider") }),
]);

const pageBody = z.object({
  slug: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9-]+$/, "lowercase letters, digits and dashes"),
  title: localized,
  blocks: z.array(blockSchema).max(200).default([]),
  seo: z.object({ title: localized, description: localized }).nullable().optional(),
  status: z.enum(["draft", "published"]).default("draft"),
  inFooter: z.boolean().default(true),
  position: z.number().int().min(0).default(0),
});

export function registerCmsRoutes(app: FastifyInstance, ctx: AppContext, perms: PermissionService): void {
  const guard = (p: Parameters<typeof requirePermission>[1]) => ({ preHandler: requirePermission(perms, p) });

  // ── Admin ─────────────────────────────────────────────────────────────────

  app.get("/api/cms/pages", guard("content.view"), async () => {
    const rows = await ctx.db.select().from(cmsPages).orderBy(asc(cmsPages.position), asc(cmsPages.slug));
    return { pages: rows };
  });

  app.get("/api/cms/pages/:id", guard("content.view"), async (req, reply) => {
    const [row] = await ctx.db.select().from(cmsPages).where(eq(cmsPages.id, (req.params as { id: string }).id));
    if (!row) return reply.code(404).send({ error: "not_found" });
    return { page: row };
  });

  app.post("/api/cms/pages", guard("content.edit"), async (req, reply) => {
    const body = pageBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body", detail: body.error.flatten() });
    const [row] = await ctx.db
      .insert(cmsPages)
      .values({ ...body.data, seo: body.data.seo ?? null, updatedBy: req.admin!.sub })
      .onConflictDoNothing()
      .returning();
    if (!row) return reply.code(409).send({ error: "slug_exists" });
    await writeAudit(ctx.db, actor(req), "content", "page_created", row.slug);
    return { page: row };
  });

  app.patch("/api/cms/pages/:id", guard("content.edit"), async (req, reply) => {
    const body = pageBody.partial().safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body", detail: body.error.flatten() });
    const { id } = req.params as { id: string };
    const [row] = await ctx.db
      .update(cmsPages)
      .set({ ...body.data, seo: body.data.seo === undefined ? undefined : body.data.seo, updatedBy: req.admin!.sub, updatedAt: ctx.now() })
      .where(eq(cmsPages.id, id))
      .returning();
    if (!row) return reply.code(404).send({ error: "not_found" });
    await writeAudit(ctx.db, actor(req), "content", "page_updated", row.slug, { fields: Object.keys(body.data) });
    return { page: row };
  });

  app.delete("/api/cms/pages/:id", guard("content.edit"), async (req, reply) => {
    const { id } = req.params as { id: string };
    const [row] = await ctx.db.delete(cmsPages).where(eq(cmsPages.id, id)).returning();
    if (!row) return reply.code(404).send({ error: "not_found" });
    await writeAudit(ctx.db, actor(req), "content", "page_deleted", row.slug);
    return { ok: true };
  });

  // ── Public ────────────────────────────────────────────────────────────────

  app.get("/api/public/pages", async () => {
    const rows = await ctx.db
      .select({ slug: cmsPages.slug, title: cmsPages.title, position: cmsPages.position })
      .from(cmsPages)
      .where(eq(cmsPages.status, "published"))
      .orderBy(asc(cmsPages.position));
    return { pages: rows.filter((r) => r !== null) };
  });

  app.get("/api/public/pages/:slug", async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const [row] = await ctx.db.select().from(cmsPages).where(eq(cmsPages.slug, slug));
    if (!row || row.status !== "published") return reply.code(404).send({ error: "not_found" });
    return {
      page: {
        slug: row.slug,
        title: row.title as CmsLocalized,
        blocks: row.blocks,
        seo: row.seo,
        updatedAt: row.updatedAt,
      },
    };
  });
}
