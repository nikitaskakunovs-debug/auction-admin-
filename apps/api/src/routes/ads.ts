import { adCards } from "@auction/db";
import { and, asc, eq, isNull, or, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { writeAudit } from "../audit.js";
import { requirePermission, type PermissionService } from "../auth/rbac.js";
import type { AppContext } from "../context.js";

const actor = (req: { admin?: { sub: string; name: string } }) => ({
  id: req.admin?.sub ?? null,
  label: req.admin?.name ?? "Unknown",
});

/**
 * Рекламные карточки в ленте лотов.
 *
 * Место в ленте продаётся рекламодателю: человек листает каталог и среди лотов
 * встречает карточку. Плотность задаётся для каждой категории отдельно — через
 * поле «через сколько карточек показывать», а не одной настройкой на весь сайт.
 */

const adBody = z.object({
  advertiser: z.string().max(120).default(""),
  title: z.string().min(1).max(120),
  body: z.string().max(400).default(""),
  ctaLabel: z.string().max(40).default(""),
  href: z.string().min(1).max(500),
  imageUrl: z.string().max(500).nullable().optional(),
  theme: z.enum(["green", "blue", "pink", "yellow"]).default("green"),
  /** Пусто — во всех категориях. */
  categoryCode: z.string().max(40).nullable().optional(),
  /** Реже раза на 200 карточек смысла нет, чаще одной на три — это уже спам. */
  everyN: z.number().int().min(3).max(200).default(12),
  active: z.boolean().default(false),
  startsAt: z.string().datetime().nullable().optional(),
  endsAt: z.string().datetime().nullable().optional(),
});

export function registerAdRoutes(app: FastifyInstance, ctx: AppContext, perms: PermissionService): void {
  const guard = (p: Parameters<typeof requirePermission>[1]) => ({ preHandler: requirePermission(perms, p) });

  /** Что показывать витрине: только включённые и только в свой срок. */
  app.get("/api/public/ads", async (req) => {
    const q = req.query as { category?: string };
    const now = ctx.now();
    const live = and(
      eq(adCards.active, true),
      or(isNull(adCards.startsAt), sql`${adCards.startsAt} <= ${now}`),
      or(isNull(adCards.endsAt), sql`${adCards.endsAt} >= ${now}`),
    );
    const rows = await ctx.db
      .select()
      .from(adCards)
      .where(
        q.category
          // Карточка «во всех категориях» показывается и в конкретной.
          ? and(live, or(isNull(adCards.categoryCode), eq(adCards.categoryCode, q.category)))
          : live,
      )
      .orderBy(asc(adCards.everyN));
    return {
      ads: rows.map((a) => ({
        id: a.id, title: a.title, body: a.body, ctaLabel: a.ctaLabel,
        href: a.href, imageUrl: a.imageUrl, theme: a.theme,
        categoryCode: a.categoryCode, everyN: a.everyN,
      })),
    };
  });

  /** Показы. Считаем их на сервере — это то, что продаётся рекламодателю,
   *  и верить в этом вопросе браузеру нельзя. */
  app.post("/api/public/ads/:id/seen", async (req, reply) => {
    const { id } = req.params as { id: string };
    const [row] = await ctx.db
      .update(adCards)
      .set({ impressions: sql`${adCards.impressions} + 1` })
      .where(and(eq(adCards.id, id), eq(adCards.active, true)))
      .returning({ id: adCards.id });
    if (!row) return reply.code(404).send({ error: "not_found" });
    return { ok: true };
  });

  // ── Панель ────────────────────────────────────────────────────────────────

  app.get("/api/ads", guard("content.view"), async () => {
    const rows = await ctx.db.select().from(adCards).orderBy(asc(adCards.createdAt));
    return { ads: rows };
  });

  app.post("/api/ads", guard("content.edit"), async (req, reply) => {
    const body = adBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body", detail: body.error.flatten() });
    const [row] = await ctx.db
      .insert(adCards)
      .values({
        ...body.data,
        imageUrl: body.data.imageUrl ?? null,
        categoryCode: body.data.categoryCode || null,
        startsAt: body.data.startsAt ? new Date(body.data.startsAt) : null,
        endsAt: body.data.endsAt ? new Date(body.data.endsAt) : null,
      })
      .returning();
    await writeAudit(ctx.db, actor(req), "content", "ad_created", row!.title);
    return { ad: row };
  });

  app.patch("/api/ads/:id", guard("content.edit"), async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = adBody.partial().safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body" });
    const patch: Record<string, unknown> = { ...body.data, updatedAt: ctx.now() };
    if ("categoryCode" in body.data) patch.categoryCode = body.data.categoryCode || null;
    if ("startsAt" in body.data) patch.startsAt = body.data.startsAt ? new Date(body.data.startsAt) : null;
    if ("endsAt" in body.data) patch.endsAt = body.data.endsAt ? new Date(body.data.endsAt) : null;
    const [row] = await ctx.db.update(adCards).set(patch).where(eq(adCards.id, id)).returning();
    if (!row) return reply.code(404).send({ error: "not_found" });
    await writeAudit(ctx.db, actor(req), "content", "ad_updated", row.title, { fields: Object.keys(body.data) });
    return { ad: row };
  });

  app.delete("/api/ads/:id", guard("content.edit"), async (req, reply) => {
    const { id } = req.params as { id: string };
    const [row] = await ctx.db.delete(adCards).where(eq(adCards.id, id)).returning({ id: adCards.id, title: adCards.title });
    if (!row) return reply.code(404).send({ error: "not_found" });
    await writeAudit(ctx.db, actor(req), "content", "ad_deleted", row.title);
    return { ok: true };
  });
}
