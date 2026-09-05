import { adminUsers, approverTelegram } from "@auction/db";
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import type { AppContext } from "../context.js";

/**
 * Telegram-бот апрувов (fin-architecture 10.3): pending-счёт шлёт карточку с
 * кнопками Apstiprināt/Noraidīt привязанным апруверам; нажатие проходит через
 * webhook и тот же движок approveInvoice/rejectInvoice, что и админка.
 *
 * Токен бота — ТОЛЬКО в deploy/.env (TELEGRAM_APPROVALS_BOT_TOKEN); привязка
 * чата — одноразовым кодом: админ жмёт «Piesaistīt Telegram» в админке,
 * получает код, шлёт боту /start <код>. Чужой chat_id без кода не привяжется.
 */

const API = "https://api.telegram.org";

async function tgCall(ctx: AppContext, method: string, payload: Record<string, unknown>): Promise<unknown> {
  const cfg = ctx.config.telegramApprovals;
  if (!cfg) return null;
  const res = await fetch(`${API}/bot${cfg.botToken}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`telegram ${method} ${res.status}`);
  return await res.json();
}

/** Одноразовый код привязки для админа; повторный вызов выдаёт новый код. */
export async function createLinkCode(ctx: AppContext, adminUserId: string): Promise<string> {
  const code = randomBytes(6).toString("hex");
  await ctx.db
    .insert(approverTelegram)
    .values({ adminUserId, chatId: `pending:${adminUserId}`, linkCode: code })
    .onConflictDoUpdate({ target: approverTelegram.adminUserId, set: { linkCode: code } });
  return code;
}

/** /start <код> из Telegram: находим код, привязываем чат. */
export async function completeLink(ctx: AppContext, code: string, chatId: string): Promise<boolean> {
  const [row] = await ctx.db
    .update(approverTelegram)
    .set({ chatId, linkCode: null, linkedAt: ctx.now() })
    .where(eq(approverTelegram.linkCode, code))
    .returning({ adminUserId: approverTelegram.adminUserId });
  return Boolean(row);
}

/** Чей это чат? null — не привязан (игнорируем сообщение). */
export async function adminByChatId(
  ctx: AppContext,
  chatId: string,
): Promise<{ id: string; label: string; roleId: string } | null> {
  const [row] = await ctx.db
    .select({ id: adminUsers.id, name: adminUsers.name, roleId: adminUsers.roleId })
    .from(approverTelegram)
    .innerJoin(adminUsers, eq(approverTelegram.adminUserId, adminUsers.id))
    .where(and(eq(approverTelegram.chatId, chatId), isNotNull(approverTelegram.linkedAt), eq(adminUsers.active, true)));
  return row ? { id: row.id, label: row.name, roleId: row.roleId } : null;
}

/** Карточка pending-счёта всем привязанным апруверам его правила. */
export async function notifyInvoiceCard(ctx: AppContext, invoiceId: string): Promise<void> {
  if (!ctx.config.telegramApprovals) return;
  const { invoiceCardData, matchApprovalRule, approverAdminIds } = await import("./approvals.js");
  const data = await invoiceCardData(ctx.db, invoiceId);
  if (!data || data.invoice.approvalStatus !== "pending") return;
  const rule = await matchApprovalRule(ctx.db, data.invoice.amountCents);
  const ids = await approverAdminIds(ctx.db, rule.approver);
  if (!ids.length) return;
  const links = await ctx.db
    .select({ chatId: approverTelegram.chatId })
    .from(approverTelegram)
    .where(and(inArray(approverTelegram.adminUserId, ids), isNotNull(approverTelegram.linkedAt)));
  if (!links.length) return;
  const inv = data.invoice;
  const text = [
    `📄 Rēķins apstiprināšanai`,
    `Piegādātājs: ${data.supplierName}`,
    `Nr: ${inv.number}`,
    `Summa: ${(inv.amountCents / 100).toFixed(2)} €`,
    data.consignmentRef ? `Piegāde: ${data.consignmentRef}` : null,
    inv.department ? `Nodaļa: ${inv.department}` : null,
    rule.dual ? "⚠️ Nepieciešams dubultais apstiprinājums" : null,
  ]
    .filter(Boolean)
    .join("\n");
  for (const l of links) {
    await tgCall(ctx, "sendMessage", {
      chat_id: l.chatId,
      text,
      reply_markup: {
        inline_keyboard: [[
          { text: "✅ Apstiprināt", callback_data: `inv:${inv.id}:ok` },
          { text: "❌ Noraidīt", callback_data: `inv:${inv.id}:no` },
        ]],
      },
    }).catch((err) => console.error("telegram card failed", err));
  }
}

/** Ответ на нажатие кнопки (тост в чате) + правка текста карточки. */
export async function answerCallback(
  ctx: AppContext,
  args: { callbackId: string; chatId: string; messageId: number | null; verdict: string },
): Promise<void> {
  await tgCall(ctx, "answerCallbackQuery", { callback_query_id: args.callbackId, text: args.verdict }).catch(() => undefined);
  if (args.messageId != null) {
    await tgCall(ctx, "editMessageReplyMarkup", {
      chat_id: args.chatId,
      message_id: args.messageId,
      reply_markup: { inline_keyboard: [] },
    }).catch(() => undefined);
    await tgCall(ctx, "sendMessage", { chat_id: args.chatId, text: args.verdict }).catch(() => undefined);
  }
}
