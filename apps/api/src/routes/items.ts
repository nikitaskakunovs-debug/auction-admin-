import { randomUUID } from "node:crypto";
import { items } from "@auction/db";
import { assertItemTransition, conditionRequiresNotes, isKnownCategory, ITEM_STATUSES, type ItemStatus } from "@auction/domain";
import { desc, eq, ilike, or, and } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import sharp from "sharp";
import { z } from "zod";
import { writeAudit } from "../audit.js";
import type { AppContext } from "../context.js";
import { requirePermission, type PermissionService } from "../auth/rbac.js";
import { thumbKey } from "../storage.js";

const actor = (req: { admin?: { sub: string; name: string } }) => ({
  id: req.admin?.sub ?? null,
  label: req.admin?.name ?? "Unknown",
});

const itemBody = z.object({
  sku: z.string().min(1),
  title: z.string().min(1),
  description: z.string().default(""),
  condition: z.string().default("good"),
  conditionNotes: z.string().default(""),
  category: z.string().refine(isKnownCategory, "unknown category").default("other"),
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
    if (conditionRequiresNotes(body.data.condition) && body.data.conditionNotes.trim().length < 3)
      return reply.code(400).send({ error: "condition_notes_required", detail: "This condition grade is a SEE NOTES grade — describe the issue." });
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
    if (
      body.data.condition !== undefined &&
      conditionRequiresNotes(body.data.condition) &&
      (body.data.conditionNotes ?? "").trim().length < 3
    )
      return reply.code(400).send({ error: "condition_notes_required", detail: "This condition grade is a SEE NOTES grade — describe the issue." });
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

  // ── Photos ─────────────────────────────────────────────────────────────────
  // Uploads are re-encoded server-side (sharp): EXIF-rotated, resized to a
  // 1600px web size + 400px thumbnail, both webp. Only the web URL is stored
  // on the item; the thumb URL is derived by the -web → -thumb convention.

  const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
  const MAX_PHOTOS_PER_ITEM = 24;

  async function processPhoto(buf: Buffer): Promise<{ web: Buffer; thumb: Buffer }> {
    const base = sharp(buf).rotate();
    const web = await base
      .clone()
      .resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true })
      .webp({ quality: 82 })
      .toBuffer();
    const thumb = await base
      .clone()
      .resize({ width: 400, height: 400, fit: "inside", withoutEnlargement: true })
      .webp({ quality: 78 })
      .toBuffer();
    return { web, thumb };
  }

  app.post("/api/items/:id/photos", guard("items.edit"), async (req, reply) => {
    if (!req.isMultipart()) return reply.code(400).send({ error: "multipart_required" });
    const { id } = req.params as { id: string };
    const [item] = await ctx.db.select({ id: items.id }).from(items).where(eq(items.id, id));
    if (!item) return reply.code(404).send({ error: "not_found" });

    const added: string[] = [];
    for await (const part of req.files()) {
      if (!ALLOWED_IMAGE_TYPES.has(part.mimetype)) {
        return reply.code(400).send({ error: "unsupported_image_type", detail: part.mimetype });
      }
      const buf = await part.toBuffer();
      if (part.file.truncated) return reply.code(400).send({ error: "image_too_large" });
      let processed: { web: Buffer; thumb: Buffer };
      try {
        processed = await processPhoto(buf);
      } catch {
        return reply.code(400).send({ error: "invalid_image" });
      }
      const key = `items/${id}/${randomUUID()}-web.webp`;
      const webUrl = await ctx.storage.put(key, processed.web, "image/webp");
      await ctx.storage.put(thumbKey(key), processed.thumb, "image/webp");
      added.push(webUrl);
    }
    if (added.length === 0) return reply.code(400).send({ error: "no_files" });

    const row = await ctx.db.transaction(async (tx) => {
      const [cur] = await tx.select().from(items).where(eq(items.id, id)).for("update");
      if (!cur) return null;
      if (cur.photos.length + added.length > MAX_PHOTOS_PER_ITEM) return "too_many" as const;
      const [updated] = await tx
        .update(items)
        .set({ photos: [...cur.photos, ...added], updatedAt: ctx.now() })
        .where(eq(items.id, id))
        .returning();
      await writeAudit(tx, actor(req), "item", "photos_added", cur.sku, { count: added.length });
      return updated;
    });
    if (row === null) return reply.code(404).send({ error: "not_found" });
    if (row === "too_many") {
      // Roll the just-written objects back so storage never leaks orphans.
      for (const url of added) {
        const key = ctx.storage.keyFor(url);
        if (key) {
          await ctx.storage.remove(key);
          await ctx.storage.remove(thumbKey(key));
        }
      }
      return reply.code(409).send({ error: "too_many_photos", detail: `max ${MAX_PHOTOS_PER_ITEM}` });
    }
    return { item: row };
  });

  const photoRef = z.object({ url: z.string().min(8) });

  app.delete("/api/items/:id/photos", guard("items.edit"), async (req, reply) => {
    const body = photoRef.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body" });
    const { id } = req.params as { id: string };
    const url = body.data.url;
    const row = await ctx.db.transaction(async (tx) => {
      const [cur] = await tx.select().from(items).where(eq(items.id, id)).for("update");
      if (!cur) return null;
      if (!cur.photos.includes(url)) return "missing" as const;
      const [updated] = await tx
        .update(items)
        .set({ photos: cur.photos.filter((p) => p !== url), updatedAt: ctx.now() })
        .where(eq(items.id, id))
        .returning();
      await writeAudit(tx, actor(req), "item", "photo_removed", cur.sku, { url });
      return updated;
    });
    if (row === null) return reply.code(404).send({ error: "not_found" });
    if (row === "missing") return reply.code(404).send({ error: "photo_not_found" });
    // Storage cleanup after the commit; foreign URLs (seeded/external) are left alone.
    const key = ctx.storage.keyFor(url);
    if (key) {
      await ctx.storage.remove(key);
      await ctx.storage.remove(thumbKey(key));
    }
    return { item: row };
  });

  /** Make a photo the cover (first position — cards show photos[0]). */
  app.post("/api/items/:id/photos/cover", guard("items.edit"), async (req, reply) => {
    const body = photoRef.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body" });
    const { id } = req.params as { id: string };
    const url = body.data.url;
    const row = await ctx.db.transaction(async (tx) => {
      const [cur] = await tx.select().from(items).where(eq(items.id, id)).for("update");
      if (!cur) return null;
      if (!cur.photos.includes(url)) return "missing" as const;
      const [updated] = await tx
        .update(items)
        .set({ photos: [url, ...cur.photos.filter((p) => p !== url)], updatedAt: ctx.now() })
        .where(eq(items.id, id))
        .returning();
      await writeAudit(tx, actor(req), "item", "photo_cover_set", cur.sku, { url });
      return updated;
    });
    if (row === null) return reply.code(404).send({ error: "not_found" });
    if (row === "missing") return reply.code(404).send({ error: "photo_not_found" });
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
