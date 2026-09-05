import type { FastifyInstance } from "fastify";
import { writeAudit, SYSTEM_ACTOR } from "../audit.js";
import type { AppContext } from "../context.js";
import { applyEmailFeedback, parseEmailFeedback } from "../engine/emailFeedback.js";

/**
 * Вебхук почтового провайдера: отказы доставки и жалобы на спам.
 *
 * Аутентификация — секрет в адресе. Ни Resend, ни SNS не умеют слать наш
 * заголовок, а подпись у каждого своя; секрет в пути работает с обоими и
 * прячет обработчик от чужих глаз целиком: без него маршрута как бы нет.
 *
 * Плата за это — секрет лежит в URL, а URL попадает в лог каждого запроса.
 * Поэтому у маршрута своё логирование выключено: логи контейнера читают
 * шире, чем `.env`, и увозят на сторону. Вместо строки с секретом пишем
 * свою — что пришло и скольких задело.
 */
export function registerEmailHookRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post(
    "/api/public/email/hook/:secret",
    { config: { rateLimit: { max: 300, timeWindow: "1 minute" } }, logLevel: "silent" },
    async (req, reply) => {
      const secret = ctx.config.emailWebhookSecret;
      // Не настроен — маршрута для мира не существует.
      if (!secret) return reply.code(404).send({ error: "not_found" });
      if ((req.params as { secret?: string }).secret !== secret) {
        // Отдельной строкой: чужой стук в эту дверь стоит видеть, но без
        // того, чем именно стучали.
        app.log.warn("email hook: wrong secret");
        return reply.code(404).send({ error: "not_found" });
      }

      const body = req.body as Record<string, unknown> | null;

      // SNS перед первой доставкой просит подтвердить подписку, дёрнув
      // присланный адрес. Делаем это сами: секрет в пути уже доказал, что
      // запрос от того, кто настраивал, а ручное открытие ссылки из логов —
      // лишний шаг, на котором настройка обычно и застревает.
      if (body?.Type === "SubscriptionConfirmation" && typeof body.SubscribeURL === "string") {
        await fetch(body.SubscribeURL).catch(() => undefined);
        await writeAudit(ctx.db, SYSTEM_ACTOR, "settings", "email_hook_subscribed", "SNS", {});
        return reply.code(204).send();
      }

      const feedback = parseEmailFeedback(body);
      // Чужой или незнакомый формат: молча принимаем, чтобы провайдер не
      // копил повторы. Разбираться с этим по логам, а не отказом.
      if (!feedback) {
        app.log.info("email hook: unrecognised payload");
        return reply.code(204).send();
      }

      const touched = await applyEmailFeedback(ctx, feedback);
      app.log.info({ kind: feedback.kind, touched }, "email hook");
      if (touched > 0) {
        // В журнал — без адресов: он читается правом audit.view, а почта
        // клиента к нему отношения не имеет.
        await writeAudit(ctx.db, SYSTEM_ACTOR, "customer", `email_${feedback.kind}`, "", {
          customers: touched,
        });
      }
      return reply.code(204).send();
    },
  );
}
