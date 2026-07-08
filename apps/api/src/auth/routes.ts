import { createHash, randomBytes } from "node:crypto";
import { adminUsers, refreshTokens, verifyPassword } from "@auction/db";
import { and, eq, isNull } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { writeAudit } from "../audit.js";
import type { AppContext } from "../context.js";
import type { PermissionService } from "./rbac.js";
import { signAccessToken } from "./jwt.js";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

const loginSchema = z.object({ email: z.string().email(), password: z.string().min(1) });
const refreshSchema = z.object({ refreshToken: z.string().min(10) });

export function registerAuthRoutes(app: FastifyInstance, ctx: AppContext, perms: PermissionService): void {
  async function issueTokens(user: { id: string; email: string; name: string; roleId: string }) {
    const accessToken = signAccessToken(
      { sub: user.id, email: user.email, name: user.name, role: user.roleId },
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
    return { accessToken, refreshToken };
  }

  async function userPayload(user: { id: string; email: string; name: string; roleId: string }) {
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.roleId,
      permissions: [...(await perms.permissionsFor(user.roleId))],
    };
  }

  app.post("/api/auth/login", async (req, reply) => {
    const body = loginSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body" });
    const [user] = await ctx.db
      .select()
      .from(adminUsers)
      .where(eq(adminUsers.email, body.data.email.toLowerCase()));
    if (!user || !user.active || !(await verifyPassword(body.data.password, user.passwordHash))) {
      return reply.code(401).send({ error: "invalid_credentials" });
    }
    const tokens = await issueTokens(user);
    await writeAudit(ctx.db, { id: user.id, label: user.name }, "team", "login", user.email);
    return { ...tokens, user: await userPayload(user) };
  });

  app.post("/api/auth/refresh", async (req, reply) => {
    const body = refreshSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body" });
    const hash = sha256(body.data.refreshToken);
    const [row] = await ctx.db
      .select()
      .from(refreshTokens)
      .where(and(eq(refreshTokens.tokenHash, hash), isNull(refreshTokens.revokedAt)));
    if (!row || row.expiresAt.getTime() <= ctx.now().getTime()) {
      return reply.code(401).send({ error: "invalid_refresh_token" });
    }
    const [user] = await ctx.db.select().from(adminUsers).where(eq(adminUsers.id, row.userId));
    if (!user || !user.active) return reply.code(401).send({ error: "invalid_refresh_token" });
    // Rotate: revoke the used token, issue a fresh pair.
    await ctx.db.update(refreshTokens).set({ revokedAt: ctx.now() }).where(eq(refreshTokens.id, row.id));
    const tokens = await issueTokens(user);
    return { ...tokens, user: await userPayload(user) };
  });

  app.post("/api/auth/logout", async (req, reply) => {
    const body = refreshSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body" });
    await ctx.db
      .update(refreshTokens)
      .set({ revokedAt: ctx.now() })
      .where(eq(refreshTokens.tokenHash, sha256(body.data.refreshToken)));
    return { ok: true };
  });

  app.get("/api/auth/me", async (req, reply) => {
    if (!req.admin) return reply.code(401).send({ error: "unauthenticated" });
    const [user] = await ctx.db.select().from(adminUsers).where(eq(adminUsers.id, req.admin.sub));
    if (!user || !user.active) return reply.code(401).send({ error: "unauthenticated" });
    return { user: await userPayload(user) };
  });
}
