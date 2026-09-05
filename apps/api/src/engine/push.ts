import webpush from "web-push";
import { marketingSettings, notificationPrefs, pushSubscriptions } from "@auction/db";
import { and, eq, sql } from "drizzle-orm";
import type { AppContext } from "../context.js";

/**
 * Web Push (MD §6.8, канал «Push» из настроек кабинета): свой канал через
 * браузерные подписки и VAPID — без сторонних сервисов и без ключей в .env.
 * Пара ключей генерируется один раз при первом обращении и живёт в
 * marketing_settings (vapid_keys) — в чат, код и Git не попадает.
 *
 * Шлём ТОЛЬКО сервисные события (перебили ставку, победа, оплата, выдача) и
 * только тем, кто явно включил канал в настройках и подписал браузер.
 */

interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

let cached: VapidKeys | null = null;

export async function ensureVapidKeys(ctx: AppContext): Promise<VapidKeys> {
  if (cached) return cached;
  const [row] = await ctx.db.select().from(marketingSettings).where(eq(marketingSettings.key, "vapid_keys"));
  const val = row?.value as VapidKeys | undefined;
  if (val && typeof val.publicKey === "string" && typeof val.privateKey === "string") {
    cached = val;
    return val;
  }
  const keys = webpush.generateVAPIDKeys();
  await ctx.db
    .insert(marketingSettings)
    .values({ key: "vapid_keys", value: keys, updatedAt: ctx.now(), updatedBy: "system" })
    .onConflictDoNothing();
  // Гонка двух инстансов: побеждает записавший — перечитываем.
  const [after] = await ctx.db.select().from(marketingSettings).where(eq(marketingSettings.key, "vapid_keys"));
  cached = (after?.value as VapidKeys) ?? keys;
  return cached;
}

/** События, которые уходят в push (совпадают с матрицей настроек кабинета). */
export const PUSH_EVENTS = new Set([
  "outbid", "won", "purchased", "payment_reminder", "order_paid",
  "pickup_ready", "pickup_reminder", "shipped", "watchlist_ending",
  // Снижение цены на отслеживаемый товар — та же просьба, что и «скоро
  // закроется», поэтому и группа настроек у них общая.
  "price_drop",
]);

const subject = (ctx: AppContext) => `mailto:info@${new URL(ctx.config.storefrontBaseUrl).hostname}`;

/**
 * Отправить push клиенту. Молчаливо: нет подписок или канал выключен — ничего.
 * Протухшие подписки (404/410) удаляются; прочие ошибки копят failCount,
 * после 5 подряд подписка выбрасывается.
 */
/** Тип письма → группа в матрице настроек кабинета. Заказные/выдачные
 *  события группы не имеют: подписка браузера сама по себе — явное согласие
 *  на важные пуши, отдельная галочка есть только у отключаемых групп. */
const PREF_GROUP: Record<string, string> = {
  outbid: "outbid",
  watchlist_ending: "watchlist",
  price_drop: "watchlist",
};

export async function sendPushToCustomer(
  ctx: AppContext,
  customerId: string,
  payload: { title: string; body: string; url?: string; event?: string },
): Promise<number> {
  const group = payload.event ? PREF_GROUP[payload.event] : undefined;
  if (group) {
    const [pref] = await ctx.db
      .select({ push: notificationPrefs.push })
      .from(notificationPrefs)
      .where(and(eq(notificationPrefs.customerId, customerId), eq(notificationPrefs.event, group)));
    // Группа отключаемая и галочка не стоит — молчим.
    if (!pref?.push) return 0;
  }
  const subs = await ctx.db.select().from(pushSubscriptions).where(eq(pushSubscriptions.customerId, customerId));
  if (subs.length === 0) return 0;
  const keys = await ensureVapidKeys(ctx);
  const body = JSON.stringify({
    title: payload.title,
    body: payload.body,
    url: payload.url ?? `${ctx.config.storefrontBaseUrl}/account`,
  });
  let sent = 0;
  for (const s of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        body,
        { vapidDetails: { subject: subject(ctx), publicKey: keys.publicKey, privateKey: keys.privateKey }, TTL: 3600 },
      );
      sent += 1;
      await ctx.db
        .update(pushSubscriptions)
        .set({ failCount: 0, lastUsedAt: ctx.now() })
        .where(eq(pushSubscriptions.id, s.id));
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode ?? 0;
      if (status === 404 || status === 410 || s.failCount >= 4) {
        await ctx.db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, s.id));
      } else {
        await ctx.db
          .update(pushSubscriptions)
          .set({ failCount: sql`${pushSubscriptions.failCount} + 1` })
          .where(eq(pushSubscriptions.id, s.id));
      }
    }
  }
  return sent;
}
