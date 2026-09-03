import { cmsPages, emailTemplateOverrides, uiStringOverrides, type CmsBlock, type CmsLocalized } from "@auction/db";
import { and, asc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { writeAudit } from "../audit.js";
import { requirePermission, type PermissionService } from "../auth/rbac.js";
import type { AppContext } from "../context.js";
import {
  LANGS,
  NOTIFICATION_TYPES,
  invalidateTemplateOverrideCache,
  renderNotification,
  sampleInput,
  type Lang,
  type NotificationType,
} from "../engine/notifications.js";
import { SETTING_DEFAULTS, SETTING_KEYS, getSettings, setSetting, type SettingKey } from "../engine/settings.js";

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

  /* ── Шаблоны писем (MD §9): каждый текст правится из админки ─────────────
   * Правка хранится поверх кодового шаблона; пустое поле = «как в коде».
   * Функциональные блоки (кнопка оплаты, код выдачи) остаются из кода. */

  app.get("/api/cms/email-templates", guard("content.view"), async () => {
    const rows = await ctx.db.select().from(emailTemplateOverrides);
    return {
      types: NOTIFICATION_TYPES,
      langs: LANGS,
      placeholders: [
        "alias", "lotTitle", "orderRef", "amount", "total", "fee", "refund", "deadline",
        "pickupCode", "carrier", "trackingUrl", "ticketNumber", "reason", "actionUrl", "payUrl",
        "searchName", "promoCode", "promoPercent", "promoDeadline", "pointsEarned", "pointsBalance",
        "referralUrl", "referralSignup", "referralOrder", "referralPercent", "categoryLabel",
        "siteUrl", "ordersUrl", "lots",
      ],
      overrides: rows,
    };
  });

  /** Кодовый вариант письма (без правок) — образец для редактора. */
  app.get("/api/cms/email-templates/:type/:lang/default", guard("content.view"), async (req, reply) => {
    const p = z
      .object({ type: z.enum(NOTIFICATION_TYPES as [NotificationType, ...NotificationType[]]), lang: z.enum(["lv", "ru", "en"]) })
      .safeParse(req.params);
    if (!p.success) return reply.code(400).send({ error: "invalid_params" });
    const rendered = await renderNotification(
      ctx, p.data.type, p.data.lang as Lang,
      sampleInput(p.data.type, { online: ctx.klix !== null || ctx.inbank !== null }),
      undefined, { skipOverride: true },
    );
    return rendered;
  });

  app.put("/api/cms/email-templates/:type/:lang", guard("content.edit"), async (req, reply) => {
    const p = z
      .object({ type: z.enum(NOTIFICATION_TYPES as [NotificationType, ...NotificationType[]]), lang: z.enum(["lv", "ru", "en"]) })
      .safeParse(req.params);
    if (!p.success) return reply.code(400).send({ error: "invalid_params" });
    const body = z
      .object({
        subject: z.string().max(300).nullable().optional(),
        body: z.string().max(20_000).nullable().optional(),
        html: z.string().max(200_000).nullable().optional(),
        /** CTA-кнопка: текст и ссылка (плейсхолдеры {payUrl} и т.п.). */
        ctaLabel: z.string().max(120).nullable().optional(),
        ctaUrl: z.string().max(600).nullable().optional(),
        enabled: z.boolean().optional(),
      })
      .safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "invalid_body" });
    const set = {
      ...(body.data.subject !== undefined ? { subject: body.data.subject } : {}),
      ...(body.data.body !== undefined ? { body: body.data.body } : {}),
      ...(body.data.html !== undefined ? { html: body.data.html } : {}),
      ...(body.data.ctaLabel !== undefined ? { ctaLabel: body.data.ctaLabel } : {}),
      ...(body.data.ctaUrl !== undefined ? { ctaUrl: body.data.ctaUrl } : {}),
      ...(body.data.enabled !== undefined ? { enabled: body.data.enabled } : {}),
      updatedAt: ctx.now(),
      updatedBy: req.admin!.sub,
    };
    const [row] = await ctx.db
      .insert(emailTemplateOverrides)
      .values({ type: p.data.type, lang: p.data.lang, ...set })
      .onConflictDoUpdate({ target: [emailTemplateOverrides.type, emailTemplateOverrides.lang], set })
      .returning();
    invalidateTemplateOverrideCache();
    await writeAudit(ctx.db, actor(req), "content", "email_template_updated", `${p.data.type}/${p.data.lang}`);
    return { override: row };
  });

  app.delete("/api/cms/email-templates/:type/:lang", guard("content.edit"), async (req, reply) => {
    const { type, lang } = req.params as { type: string; lang: string };
    await ctx.db
      .delete(emailTemplateOverrides)
      .where(and(eq(emailTemplateOverrides.type, type), eq(emailTemplateOverrides.lang, lang)));
    invalidateTemplateOverrideCache();
    await writeAudit(ctx.db, actor(req), "content", "email_template_reset", `${type}/${lang}`);
    return { ok: true };
  });

  /* ── Строки интерфейса витрины: ЛЮБОЙ видимый текст правится из админки ──
   * Ключи — те же, что в apps/web/src/lib/strings.ts; витрина накладывает
   * правки поверх кода без деплоя. */

  app.get("/api/cms/ui-strings", guard("content.view"), async () => {
    const rows = await ctx.db.select().from(uiStringOverrides).orderBy(asc(uiStringOverrides.key));
    return { overrides: rows };
  });

  app.put("/api/cms/ui-strings", guard("content.edit"), async (req, reply) => {
    const body = z
      .object({
        key: z.string().min(1).max(120),
        lang: z.enum(["lv", "ru", "en", "et", "lt"]),
        text: z.string().max(4000),
      })
      .safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "invalid_body" });
    const set = { text: body.data.text, updatedAt: ctx.now(), updatedBy: req.admin!.sub };
    await ctx.db
      .insert(uiStringOverrides)
      .values({ key: body.data.key, lang: body.data.lang, ...set })
      .onConflictDoUpdate({ target: [uiStringOverrides.key, uiStringOverrides.lang], set });
    await writeAudit(ctx.db, actor(req), "content", "ui_string_updated", `${body.data.key}/${body.data.lang}`);
    return { ok: true };
  });

  app.delete("/api/cms/ui-strings", guard("content.edit"), async (req, reply) => {
    const body = z
      .object({ key: z.string().min(1).max(120), lang: z.enum(["lv", "ru", "en", "et", "lt"]) })
      .safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "invalid_body" });
    await ctx.db
      .delete(uiStringOverrides)
      .where(and(eq(uiStringOverrides.key, body.data.key), eq(uiStringOverrides.lang, body.data.lang)));
    await writeAudit(ctx.db, actor(req), "content", "ui_string_reset", `${body.data.key}/${body.data.lang}`);
    return { ok: true };
  });

  /* ── Настройки маркетинга: проценты, сроки, баллы (MD §9) ──────────────── */

  app.get("/api/cms/marketing-settings", guard("settings.view"), async () => {
    return { settings: await getSettings(ctx), defaults: SETTING_DEFAULTS };
  });

  app.put("/api/cms/marketing-settings", guard("settings.edit"), async (req, reply) => {
    const body = z.record(z.string(), z.number().min(0).max(1_000_000)).safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "invalid_body" });
    const unknown = Object.keys(body.data).filter((k) => !SETTING_KEYS.includes(k as SettingKey));
    if (unknown.length) return reply.code(400).send({ error: "unknown_keys", keys: unknown });
    // Отдельные предохранители здравого смысла: проценты — не больше 100,
    // потолок баллов — не больше 100% (полное закрытие заказа запрещено
    // решением владельца, поэтому и ровно 100% не пускаем).
    for (const [k, v] of Object.entries(body.data)) {
      if (/percent/.test(k) && v > 100) return reply.code(400).send({ error: "percent_over_100", key: k });
      if (k === "points_redeem_max_bp" && v >= 10_000) return reply.code(400).send({ error: "cap_must_leave_payment", key: k });
    }
    for (const [k, v] of Object.entries(body.data)) {
      await setSetting(ctx, k as SettingKey, v, req.admin!.sub);
    }
    await writeAudit(ctx.db, actor(req), "settings", "marketing_settings_updated", "", { keys: Object.keys(body.data) });
    return { settings: await getSettings(ctx) };
  });

  // ── Public ────────────────────────────────────────────────────────────────

  /** Правки строк витрины: {key: {lang: text}}. Кэш минуту в Redis. */
  app.get("/api/public/ui-strings", async () => {
    try {
      const cached = await ctx.redis.get("cms:ui-strings");
      if (cached) return JSON.parse(cached) as Record<string, unknown>;
    } catch { /* кэш — удобство */ }
    const rows = await ctx.db
      .select({ key: uiStringOverrides.key, lang: uiStringOverrides.lang, text: uiStringOverrides.text })
      .from(uiStringOverrides);
    const overrides: Record<string, Record<string, string>> = {};
    for (const r of rows) (overrides[r.key] ??= {})[r.lang] = r.text;
    const payload = { overrides };
    try { await ctx.redis.set("cms:ui-strings", JSON.stringify(payload), "EX", 60); } catch { /* ignore */ }
    return payload;
  });

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
