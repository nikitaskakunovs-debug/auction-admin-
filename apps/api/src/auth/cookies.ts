import type { FastifyReply } from "fastify";

/**
 * The refresh token lives in an httpOnly cookie the browser's JavaScript
 * cannot read, so an XSS bug can't exfiltrate it. It is scoped to the auth
 * path and SameSite=Strict, meaning it is never sent on a cross-site request —
 * which also makes the refresh endpoint immune to CSRF. The access token, by
 * contrast, is returned in the JSON body and held only in the SPA's memory.
 */

export const REFRESH_COOKIE = "admin_rt";
const COOKIE_PATH = "/api/auth";

export function setRefreshCookie(reply: FastifyReply, token: string, maxAgeSec: number, secure: boolean): void {
  reply.setCookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    sameSite: "strict",
    secure,
    path: COOKIE_PATH,
    maxAge: maxAgeSec,
  });
}

export function clearRefreshCookie(reply: FastifyReply, secure: boolean): void {
  reply.clearCookie(REFRESH_COOKIE, { httpOnly: true, sameSite: "strict", secure, path: COOKIE_PATH });
}
