import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Отписка от рассылки одной ссылкой из письма.
 *
 * Ссылка обязана работать без входа в аккаунт — так требует и закон, и
 * почтовики: Gmail показывает свою кнопку «Отписаться» только когда письмо
 * несёт заголовок List-Unsubscribe, а нажатие по ней не открывает браузер и
 * логина не предполагает.
 *
 * Токен не хранится: это подпись идентификатора клиента нашим секретом.
 * Подделать нельзя, срок жизни не ограничен (ссылка из письма годичной
 * давности обязана работать), а прочитать из него можно только id — то есть
 * утечка адреса из ссылки невозможна.
 */
export function unsubscribeToken(customerId: string, secret: string): string {
  const sig = createHmac("sha256", secret).update(`unsub:${customerId}`).digest("base64url").slice(0, 27);
  return `${customerId}.${sig}`;
}

/** id из токена, если подпись сходится; иначе null. */
export function verifyUnsubscribeToken(token: string, secret: string): string | null {
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const id = token.slice(0, dot);
  const expected = unsubscribeToken(id, secret);
  const a = Buffer.from(token);
  const b = Buffer.from(expected);
  // Сравнение постоянного времени: без него подпись подбирается побайтово.
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return id;
}

/** Ссылка для человека: страница витрины с кнопкой и объяснением. */
export function unsubscribeUrl(customerId: string, secret: string, siteUrl: string): string {
  return `${siteUrl}/atteikties?t=${encodeURIComponent(unsubscribeToken(customerId, secret))}`;
}

/** Ссылка для почтовика: тот же токен, но адрес принимает POST без страницы.
 *  Gmail жмёт её сам (One-Click) и браузера не открывает, поэтому вести её на
 *  Next.js-страницу нельзя — она POST не обслуживает. */
export function unsubscribeApiUrl(customerId: string, secret: string, apiUrl: string): string {
  return `${apiUrl}/api/public/unsubscribe?t=${encodeURIComponent(unsubscribeToken(customerId, secret))}`;
}
