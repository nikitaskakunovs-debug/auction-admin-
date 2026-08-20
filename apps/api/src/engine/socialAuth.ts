import { createHash, createHmac } from "node:crypto";
import type { ApiConfig } from "../config.js";

/**
 * Соцвход (макеты № 50, 52–54): обмен кода на профиль у провайдера.
 *
 * Правила привязки живут в маршрутах; здесь — только разговор с провайдером.
 * В режиме simulate код имеет вид `ok:<email>:<sub>` — тесты гоняют весь
 * маршрут без сети, как у Klix.
 */
export interface SocialProfile {
  provider: "google" | "facebook" | "telegram";
  /** id пользователя у провайдера — по нему находим аккаунт повторно. */
  sub: string;
  /** null — провайдер адреса не дал (Telegram всегда, Facebook иногда). */
  email: string | null;
  /** Подтверждён ли адрес самим провайдером. */
  emailVerified: boolean;
  name: string | null;
}

export class SocialAuthError extends Error {
  constructor(message: string, public readonly status = 401) {
    super(message);
  }
}

function simulated(provider: "google" | "facebook", code: string): SocialProfile {
  const m = /^ok:([^:]*):(.+)$/.exec(code);
  if (!m) throw new SocialAuthError("simulated code rejected");
  return {
    provider,
    sub: m[2]!,
    email: m[1] ? m[1].toLowerCase() : null,
    emailVerified: m[1] !== "",
    name: "Sim User",
  };
}

/** Разбор полезной нагрузки JWT без проверки подписи. Токен получен напрямую
 *  от Google по TLS в обмен на code — подпись здесь ничего не добавляет. */
function jwtPayload(token: string): Record<string, unknown> {
  const part = token.split(".")[1];
  if (!part) throw new SocialAuthError("malformed id_token");
  return JSON.parse(Buffer.from(part, "base64url").toString()) as Record<string, unknown>;
}

export async function googleExchange(config: ApiConfig, code: string, redirectUri: string): Promise<SocialProfile> {
  if (!config.google) throw new SocialAuthError("google off", 501);
  if (config.socialMode === "simulate") return simulated("google", code);
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: config.google.clientId,
      client_secret: config.google.clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });
  if (!res.ok) throw new SocialAuthError(`google token exchange failed: ${res.status}`);
  const body = (await res.json()) as { id_token?: string };
  if (!body.id_token) throw new SocialAuthError("google reply without id_token");
  const p = jwtPayload(body.id_token);
  return {
    provider: "google",
    sub: String(p.sub ?? ""),
    email: typeof p.email === "string" ? p.email.toLowerCase() : null,
    emailVerified: p.email_verified === true,
    name: typeof p.name === "string" ? p.name : null,
  };
}

export async function facebookExchange(config: ApiConfig, code: string, redirectUri: string): Promise<SocialProfile> {
  if (!config.facebook) throw new SocialAuthError("facebook off", 501);
  if (config.socialMode === "simulate") return simulated("facebook", code);
  const tokenUrl = new URL("https://graph.facebook.com/v19.0/oauth/access_token");
  tokenUrl.searchParams.set("client_id", config.facebook.appId);
  tokenUrl.searchParams.set("client_secret", config.facebook.appSecret);
  tokenUrl.searchParams.set("redirect_uri", redirectUri);
  tokenUrl.searchParams.set("code", code);
  const tokenRes = await fetch(tokenUrl);
  if (!tokenRes.ok) throw new SocialAuthError(`facebook token exchange failed: ${tokenRes.status}`);
  const token = (await tokenRes.json()) as { access_token?: string };
  if (!token.access_token) throw new SocialAuthError("facebook reply without access_token");
  const meRes = await fetch(
    `https://graph.facebook.com/v19.0/me?fields=id,name,email&access_token=${encodeURIComponent(token.access_token)}`,
  );
  if (!meRes.ok) throw new SocialAuthError(`facebook profile failed: ${meRes.status}`);
  const me = (await meRes.json()) as { id?: string; name?: string; email?: string };
  return {
    provider: "facebook",
    sub: String(me.id ?? ""),
    email: me.email ? me.email.toLowerCase() : null,
    // Graph отдаёт адрес только когда он у Facebook подтверждён.
    emailVerified: !!me.email,
    name: me.name ?? null,
  };
}

/** Telegram Login Widget: подпись HMAC-SHA256 по данным виджета, ключ —
 *  SHA-256 от токена бота. Свежесть — сутки: старую ссылку не переиграть. */
export function telegramVerify(
  config: ApiConfig,
  params: Record<string, string>,
  nowMs: number,
): SocialProfile {
  if (!config.telegram) throw new SocialAuthError("telegram off", 501);
  const { hash, ...fields } = params;
  if (!hash) throw new SocialAuthError("telegram payload without hash");
  const checkString = Object.keys(fields)
    .sort()
    .map((k) => `${k}=${fields[k]}`)
    .join("\n");
  const secret = createHash("sha256").update(config.telegram.botToken).digest();
  const expected = createHmac("sha256", secret).update(checkString).digest("hex");
  if (expected !== hash) throw new SocialAuthError("telegram signature mismatch");
  const authDate = Number(fields.auth_date ?? 0) * 1000;
  if (!authDate || nowMs - authDate > 24 * 3600 * 1000) throw new SocialAuthError("telegram auth expired");
  const name = [fields.first_name, fields.last_name].filter(Boolean).join(" ");
  return {
    provider: "telegram",
    sub: String(fields.id ?? ""),
    email: null,
    emailVerified: false,
    name: name || fields.username || null,
  };
}
