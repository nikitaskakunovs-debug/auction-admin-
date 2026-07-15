import { createHash, randomBytes } from "node:crypto";
import { adminUsers, hashPassword, refreshTokens, verifyPassword } from "@auction/db";
import { validatePassword } from "@auction/domain";
import { and, eq, isNull } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { writeAudit } from "../audit.js";
import type { AppContext } from "../context.js";
import { clearRefreshCookie, REFRESH_COOKIE, setRefreshCookie } from "./cookies.js";
import { signAccessToken, signChallengeToken, verifyChallengeToken } from "./jwt.js";
import { LoginLockout } from "./lockout.js";
import type { PermissionService } from "./rbac.js";
import { revokeAllUserRefreshTokens } from "./session.js";
import {
  buildOtpauthUri,
  clearPendingSecret,
  consumeRecoveryCode,
  enableTotp,
  generateTotpSecret,
  readPendingSecret,
  replaceRecoveryCodes,
  stashPendingSecret,
  verifyTotpCode,
} from "./twofa.js";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

const CHALLENGE_TTL_SEC = 600; // 10 min to complete the second factor

const loginSchema = z.object({ email: z.string().email(), password: z.string().min(1) });
const totpLoginSchema = z.object({ challengeToken: z.string().min(10), code: z.string().min(6).max(20) });
const enrollSchema = z.object({ challengeToken: z.string().min(10).optional() });
const enableSchema = z.object({ challengeToken: z.string().min(10).optional(), code: z.string().min(6).max(10) });
const changePwSchema = z.object({ currentPassword: z.string().min(1), newPassword: z.string().min(1) });
const reauthSchema = z.object({ password: z.string().min(1) });

type AdminUserRow = typeof adminUsers.$inferSelect;

export function registerAuthRoutes(app: FastifyInstance, ctx: AppContext, perms: PermissionService): void {
  const lockout = new LoginLockout(ctx.redis, ctx.config.loginMaxAttempts, ctx.config.loginLockoutSec);
  // A valid-format hash used to equalise timing when an account is missing, so
  // response time never reveals whether an email exists.
  const dummyHashPromise = hashPassword(randomBytes(16).toString("hex"));

  async function userPayload(user: AdminUserRow) {
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.roleId,
      totpEnabled: user.totpEnabled,
      permissions: [...(await perms.permissionsFor(user.roleId))],
    };
  }

  /** Mint an access token + rotating refresh cookie for a fully authed user. */
  async function issueSession(reply: FastifyReply, user: AdminUserRow) {
    const accessToken = signAccessToken(
      { sub: user.id, kind: "admin", email: user.email, name: user.name, role: user.roleId },
      ctx.config.jwtSecret,
      ctx.config.accessTokenTtlSec,
      ctx.now().getTime(),
    );
    const refreshToken = randomBytes(48).toString("base64url");
    await ctx.db.insert(refreshTokens).values({
      userId: user.id,
      tokenHash: sha256(refreshToken),
      expiresAt: new Date(ctx.now().getTime() + ctx.config.refreshTokenTtlSec * 1000),
    });
    setRefreshCookie(reply, refreshToken, ctx.config.refreshTokenTtlSec, ctx.config.isProduction);
    return { accessToken, user: await userPayload(user) };
  }

  /** Resolve who an enroll/enable request is for: a challenge OR a live session. */
  async function resolveEnrollUser(
    req: FastifyRequest,
    challengeToken: string | undefined,
    steps: Array<"enroll" | "totp">,
  ): Promise<AdminUserRow | null> {
    let userId: string | null = null;
    if (req.admin) userId = req.admin.sub;
    else if (challengeToken) {
      const claims = verifyChallengeToken(challengeToken, ctx.config.jwtSecret, ctx.now().getTime());
      if (claims && steps.includes(claims.step)) userId = claims.sub;
    }
    if (!userId) return null;
    const [user] = await ctx.db.select().from(adminUsers).where(eq(adminUsers.id, userId));
    return user && user.active ? user : null;
  }

  // ── Step 1: password ────────────────────────────────────────────────────────
  app.post("/api/auth/login", async (req, reply) => {
    const body = loginSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body" });
    const email = body.data.email.toLowerCase();

    // Locked accounts fail generically — no signal about existence or password.
    if (await lockout.isLocked(email)) return reply.code(429).send({ error: "too_many_attempts" });

    const [user] = await ctx.db.select().from(adminUsers).where(eq(adminUsers.email, email));
    const hash = user?.passwordHash ?? (await dummyHashPromise);
    const passwordOk = await verifyPassword(body.data.password, hash);

    if (!user || !user.active || !passwordOk) {
      const count = await lockout.recordFailure(email);
      if (count >= ctx.config.loginMaxAttempts && user) {
        await writeAudit(ctx.db, { id: user.id, label: user.name }, "team", "login_locked_out", user.email);
      }
      return reply.code(401).send({ error: "invalid_credentials" });
    }

    // Password correct: mint a challenge that only unlocks the second factor.
    const step = user.totpEnabled ? "totp" : "enroll";
    const challengeToken = signChallengeToken(user.id, step, ctx.config.jwtSecret, CHALLENGE_TTL_SEC, ctx.now().getTime());
    return { challenge: step, challengeToken };
  });

  // ── Step 2a: complete login with a TOTP or recovery code ──────────────────────
  app.post("/api/auth/login/2fa", async (req, reply) => {
    const body = totpLoginSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body" });
    const claims = verifyChallengeToken(body.data.challengeToken, ctx.config.jwtSecret, ctx.now().getTime());
    if (!claims || claims.step !== "totp") return reply.code(401).send({ error: "invalid_challenge" });
    const [user] = await ctx.db.select().from(adminUsers).where(eq(adminUsers.id, claims.sub));
    if (!user || !user.active || !user.totpEnabled || !user.totpSecret) {
      return reply.code(401).send({ error: "invalid_challenge" });
    }
    if (await lockout.isLocked(user.email)) return reply.code(429).send({ error: "too_many_attempts" });

    const code = body.data.code.trim();
    const now = ctx.now();
    const totpOk = verifyTotpCode(user.totpSecret, code, now.getTime());
    const recoveryOk = totpOk ? false : await consumeRecoveryCode(ctx.db, user.id, code, now);
    if (!totpOk && !recoveryOk) {
      await lockout.recordFailure(user.email);
      return reply.code(401).send({ error: "invalid_code" });
    }
    await lockout.reset(user.email);
    const session = await issueSession(reply, user);
    await writeAudit(ctx.db, { id: user.id, label: user.name }, "team", recoveryOk ? "login_recovery_code" : "login", user.email);
    return session;
  });

  // ── Step 2b (first login): enroll a TOTP authenticator ────────────────────────
  app.post("/api/auth/2fa/setup", async (req, reply) => {
    const body = enrollSchema.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "invalid_body" });
    const user = await resolveEnrollUser(req, body.data.challengeToken, ["enroll", "totp"]);
    if (!user) return reply.code(401).send({ error: "unauthenticated" });
    const secret = generateTotpSecret();
    await stashPendingSecret(ctx.redis, user.id, secret);
    return { secret, otpauthUri: buildOtpauthUri(secret, user.email, ctx.config.totpIssuer) };
  });

  app.post("/api/auth/2fa/enable", async (req, reply) => {
    const body = enableSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body" });
    const fromChallenge = !req.admin;
    const user = await resolveEnrollUser(req, body.data.challengeToken, ["enroll", "totp"]);
    if (!user) return reply.code(401).send({ error: "unauthenticated" });
    const pending = await readPendingSecret(ctx.redis, user.id);
    if (!pending) return reply.code(409).send({ error: "no_pending_enrollment" });
    if (!verifyTotpCode(pending, body.data.code.trim(), ctx.now().getTime())) {
      return reply.code(401).send({ error: "invalid_code" });
    }
    const recoveryCodes = await enableTotp(ctx.db, user.id, pending);
    await clearPendingSecret(ctx.redis, user.id);
    // Re-enroll from an existing session ends other sessions defensively.
    await revokeAllUserRefreshTokens(ctx.db, user.id, ctx.now());
    await writeAudit(ctx.db, { id: user.id, label: user.name }, "team", "totp_enabled", user.email);
    // Completing enrollment during first login also logs the user in.
    const [fresh] = await ctx.db.select().from(adminUsers).where(eq(adminUsers.id, user.id));
    const session = fromChallenge ? await issueSession(reply, fresh!) : null;
    return { recoveryCodes, ...(session ?? {}) };
  });

  // ── Regenerate recovery codes (re-auth with password) ─────────────────────────
  app.post("/api/auth/2fa/recovery-codes", async (req, reply) => {
    if (!req.admin) return reply.code(401).send({ error: "unauthenticated" });
    const body = reauthSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body" });
    const [user] = await ctx.db.select().from(adminUsers).where(eq(adminUsers.id, req.admin.sub));
    if (!user || !user.active) return reply.code(401).send({ error: "unauthenticated" });
    if (!(await verifyPassword(body.data.password, user.passwordHash))) {
      return reply.code(401).send({ error: "invalid_credentials" });
    }
    const recoveryCodes = await replaceRecoveryCodes(ctx.db, user.id);
    await writeAudit(ctx.db, { id: user.id, label: user.name }, "team", "recovery_codes_regenerated", user.email);
    return { recoveryCodes };
  });

  app.get("/api/auth/2fa/status", async (req, reply) => {
    if (!req.admin) return reply.code(401).send({ error: "unauthenticated" });
    const [user] = await ctx.db.select().from(adminUsers).where(eq(adminUsers.id, req.admin.sub));
    if (!user) return reply.code(401).send({ error: "unauthenticated" });
    return { totpEnabled: user.totpEnabled };
  });

  // ── Change password (revokes all other sessions) ──────────────────────────────
  app.post("/api/auth/change-password", async (req, reply) => {
    if (!req.admin) return reply.code(401).send({ error: "unauthenticated" });
    const body = changePwSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body" });
    const [user] = await ctx.db.select().from(adminUsers).where(eq(adminUsers.id, req.admin.sub));
    if (!user || !user.active) return reply.code(401).send({ error: "unauthenticated" });
    if (!(await verifyPassword(body.data.currentPassword, user.passwordHash))) {
      return reply.code(401).send({ error: "invalid_credentials" });
    }
    const check = validatePassword(body.data.newPassword, { email: user.email, name: user.name });
    if (!check.ok) return reply.code(422).send({ error: "weak_password", detail: check.errors });
    await ctx.db.update(adminUsers).set({ passwordHash: await hashPassword(body.data.newPassword) }).where(eq(adminUsers.id, user.id));
    await revokeAllUserRefreshTokens(ctx.db, user.id, ctx.now());
    await writeAudit(ctx.db, { id: user.id, label: user.name }, "team", "password_changed", user.email);
    // Keep the current client signed in with a fresh session.
    return issueSession(reply, user);
  });

  // ── Refresh (httpOnly cookie) with theft detection ────────────────────────────
  app.post("/api/auth/refresh", async (req, reply) => {
    const token = req.cookies?.[REFRESH_COOKIE];
    if (!token) return reply.code(401).send({ error: "invalid_refresh_token" });
    const hash = sha256(token);
    const [row] = await ctx.db.select().from(refreshTokens).where(eq(refreshTokens.tokenHash, hash));
    if (!row) {
      clearRefreshCookie(reply, ctx.config.isProduction);
      return reply.code(401).send({ error: "invalid_refresh_token" });
    }
    // A token presented after it was already rotated/revoked means the cookie
    // leaked and is being replayed — burn the whole family and force re-login.
    if (row.revokedAt || row.expiresAt.getTime() <= ctx.now().getTime()) {
      if (row.revokedAt) {
        await revokeAllUserRefreshTokens(ctx.db, row.userId, ctx.now());
        await writeAudit(ctx.db, { id: row.userId, label: "unknown" }, "team", "refresh_reuse_detected", "");
      }
      clearRefreshCookie(reply, ctx.config.isProduction);
      return reply.code(401).send({ error: "invalid_refresh_token" });
    }
    const [user] = await ctx.db.select().from(adminUsers).where(eq(adminUsers.id, row.userId));
    if (!user || !user.active) {
      clearRefreshCookie(reply, ctx.config.isProduction);
      return reply.code(401).send({ error: "invalid_refresh_token" });
    }
    // Rotate: revoke the presented token, mint a fresh pair.
    await ctx.db.update(refreshTokens).set({ revokedAt: ctx.now() }).where(eq(refreshTokens.id, row.id));
    return issueSession(reply, user);
  });

  app.post("/api/auth/logout", async (req, reply) => {
    const token = req.cookies?.[REFRESH_COOKIE];
    if (token) {
      await ctx.db
        .update(refreshTokens)
        .set({ revokedAt: ctx.now() })
        .where(and(eq(refreshTokens.tokenHash, sha256(token)), isNull(refreshTokens.revokedAt)));
    }
    clearRefreshCookie(reply, ctx.config.isProduction);
    return { ok: true };
  });

  app.get("/api/auth/me", async (req, reply) => {
    if (!req.admin) return reply.code(401).send({ error: "unauthenticated" });
    const [user] = await ctx.db.select().from(adminUsers).where(eq(adminUsers.id, req.admin.sub));
    if (!user || !user.active) return reply.code(401).send({ error: "unauthenticated" });
    return { user: await userPayload(user) };
  });
}
