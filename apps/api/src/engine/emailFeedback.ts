import { customers, notifications } from "@auction/db";
import { eq, sql } from "drizzle-orm";
import type { AppContext } from "../context.js";

/**
 * Обратная связь почтовых провайдеров: отказы доставки и жалобы на спам.
 *
 * Раньше отметка «адрес мёртв» проверялась перед каждой рассылкой, но
 * заполнить её было некому — обработчика не существовало. Один человек с
 * опечаткой в адресе получал письма вечно, доля недоставленных росла, и в
 * какой-то момент Gmail начал бы класть в спам всё подряд, включая счета.
 *
 * Два разных сигнала, и путать их нельзя:
 *
 *  — жёсткий отказ (ящика не существует): больше не пишем никогда, ни
 *    рассылку, ни служебное. Продолжать бить в мёртвый ящик — терять
 *    репутацию домена, а вместе с ней доставку писем всем остальным;
 *  — мягкий отказ (ящик переполнен, сервер занят): временная беда, адрес
 *    живой. Не трогаем вовсе — заблокировать его значило бы потерять
 *    клиента из-за того, что у него на неделю кончилось место;
 *  — жалоба на спам: человек нажал «Это спам». Отписываем от рассылок, но
 *    служебные письма о его же заказе оставляем — счёт и код выдачи ему
 *    всё равно нужны, а второй жалобы они не вызовут.
 */

export type FeedbackKind = "hard_bounce" | "soft_bounce" | "complaint";

export interface EmailFeedback {
  kind: FeedbackKind;
  /** Адреса, к которым относится сигнал. */
  recipients: string[];
}

/** Событие Resend: `{ type: "email.bounced", data: { to: [...] } }`. */
function parseResend(body: Record<string, unknown>): EmailFeedback | null {
  const type = typeof body.type === "string" ? body.type : null;
  if (!type?.startsWith("email.")) return null;
  const data = (body.data ?? {}) as Record<string, unknown>;
  const to = Array.isArray(data.to) ? data.to.filter((x): x is string => typeof x === "string") : [];
  if (to.length === 0) return null;

  if (type === "email.complained") return { kind: "complaint", recipients: to };
  if (type !== "email.bounced") return null;
  // Resend кладёт подтип в bounce.type: Permanent | Transient | Undetermined.
  const bounce = (data.bounce ?? {}) as Record<string, unknown>;
  const sub = typeof bounce.type === "string" ? bounce.type.toLowerCase() : "";
  return { kind: sub === "transient" ? "soft_bounce" : "hard_bounce", recipients: to };
}

/** Событие SES, завёрнутое в SNS: разбираем внутренний JSON. */
function parseSes(body: Record<string, unknown>): EmailFeedback | null {
  const raw = typeof body.Message === "string" ? body.Message : null;
  if (!raw) return null;
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  const kind = typeof msg.notificationType === "string" ? msg.notificationType : "";
  if (kind === "Complaint") {
    const complaint = (msg.complaint ?? {}) as Record<string, unknown>;
    const list = Array.isArray(complaint.complainedRecipients) ? complaint.complainedRecipients : [];
    const to = list
      .map((r) => (r as { emailAddress?: unknown }).emailAddress)
      .filter((x): x is string => typeof x === "string");
    return to.length > 0 ? { kind: "complaint", recipients: to } : null;
  }
  if (kind !== "Bounce") return null;
  const bounce = (msg.bounce ?? {}) as Record<string, unknown>;
  const list = Array.isArray(bounce.bouncedRecipients) ? bounce.bouncedRecipients : [];
  const to = list
    .map((r) => (r as { emailAddress?: unknown }).emailAddress)
    .filter((x): x is string => typeof x === "string");
  if (to.length === 0) return null;
  const permanent = bounce.bounceType === "Permanent";
  return { kind: permanent ? "hard_bounce" : "soft_bounce", recipients: to };
}

/** Разобрать событие любого из двух провайдеров. Чужой формат — null. */
export function parseEmailFeedback(body: unknown): EmailFeedback | null {
  if (typeof body !== "object" || body === null) return null;
  const obj = body as Record<string, unknown>;
  return parseResend(obj) ?? parseSes(obj);
}

/**
 * Применить сигнал к карточкам клиентов. Возвращает, скольких затронуло —
 * ноль означает, что адрес нам незнаком (например, письмо поставщику), и это
 * не ошибка.
 */
export async function applyEmailFeedback(ctx: AppContext, fb: EmailFeedback): Promise<number> {
  // Мягкий отказ ничего не меняет: ящик переполнен сегодня, завтра свободен.
  if (fb.kind === "soft_bounce") return 0;
  const now = ctx.now();
  let touched = 0;

  for (const address of fb.recipients) {
    const email = address.trim().toLowerCase();
    if (!email) continue;
    const patch =
      fb.kind === "hard_bounce"
        ? { emailBouncedAt: now }
        : // Жалоба на спам — это отписка, а не смерть адреса: служебные письма
          // о собственном заказе человеку по-прежнему нужны.
          { unsubscribedAt: now, marketingOptIn: false };
    const rows = await ctx.db
      .update(customers)
      .set(patch)
      .where(sql`lower(${customers.email}) = ${email}`)
      .returning({ id: customers.id });
    touched += rows.length;

    // Незачем держать в очереди письма, которые заведомо не дойдут.
    if (fb.kind === "hard_bounce" && rows.length > 0) {
      await ctx.db
        .update(notifications)
        .set({ status: "failed", lastError: "hard bounce" })
        .where(
          sql`${notifications.customerId} = ${rows[0]!.id} and ${notifications.status} = 'pending'`,
        );
    }
  }
  return touched;
}

/** Снять отметку «адрес отбился» — человек исправил почту в кабинете. */
export async function clearBounce(ctx: AppContext, customerId: string): Promise<void> {
  await ctx.db.update(customers).set({ emailBouncedAt: null }).where(eq(customers.id, customerId));
}
