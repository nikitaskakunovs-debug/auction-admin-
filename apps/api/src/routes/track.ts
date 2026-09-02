import { notifications } from "@auction/db";
import { and, eq, isNull } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.js";

/**
 * Трекинг маркетинговых писем (MD §1.4, stats_json): пиксель открытия и
 * редирект клика. Только маркетинг — сервисные письма пикселя не несут
 * (see dispatchNotifications). Оба маршрута молчаливы: битый id отдаёт тот же
 * пиксель/редирект на главную, чтобы почтовые сканеры ничего не «ломали».
 */

/** 1×1 прозрачный GIF — 43 байта, классика. */
const PIXEL = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function registerTrackRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get("/api/t/o/:id.png", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (UUID_RE.test(id)) {
      // Первое открытие; повторные не двигают отметку — метрика «открыл ли»,
      // а не «сколько раз». Ошибка БД не должна ломать картинку в письме.
      try {
        await ctx.db
          .update(notifications)
          .set({ openedAt: ctx.now() })
          .where(and(eq(notifications.id, id), isNull(notifications.openedAt)));
      } catch { /* пиксель важнее отметки */ }
    }
    return reply
      .header("Content-Type", "image/gif")
      .header("Cache-Control", "no-store, no-cache, must-revalidate")
      .send(PIXEL);
  });

  app.get("/api/t/c/:id", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const u = (req.query as { u?: string }).u ?? "";
    // Открытый редирект — дыра: пускаем только на собственные адреса.
    const ok =
      u.startsWith(`${ctx.config.storefrontBaseUrl}/`) ||
      u === ctx.config.storefrontBaseUrl ||
      u.startsWith(`${ctx.config.publicBaseUrl}/`);
    const target = ok ? u : ctx.config.storefrontBaseUrl;
    if (UUID_RE.test(id)) {
      try {
        await ctx.db
          .update(notifications)
          .set({ clickedAt: ctx.now() })
          .where(and(eq(notifications.id, id), isNull(notifications.clickedAt)));
      } catch { /* редирект важнее отметки */ }
    }
    return reply.redirect(target, 302);
  });
}
