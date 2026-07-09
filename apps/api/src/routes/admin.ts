import { adminRoles, adminUsers, auditLog, hashPassword, markets, notifications, rolePermissions } from "@auction/db";
import { PERMISSIONS, validateIncrementTable, validatePassword, type Permission } from "@auction/domain";
import { and, desc, eq, ne } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { writeAudit } from "../audit.js";
import type { AppContext } from "../context.js";
import { requirePermission, type PermissionService } from "../auth/rbac.js";
import { revokeAllUserRefreshTokens } from "../auth/session.js";

const actor = (req: { admin?: { sub: string; name: string } }) => ({
  id: req.admin?.sub ?? null,
  label: req.admin?.name ?? "Unknown",
});

export function registerAdminRoutes(app: FastifyInstance, ctx: AppContext, perms: PermissionService): void {
  const guard = (p: Parameters<typeof requirePermission>[1]) => ({ preHandler: requirePermission(perms, p) });

  // ── Markets (per-country config) ──────────────────────────────────────────
  app.get("/api/markets", guard("markets.view"), async () => {
    return { markets: await ctx.db.select().from(markets) };
  });

  const marketPatch = z.object({
    name: z.string().min(1).optional(),
    legalName: z.string().optional(),
    languages: z.array(z.string()).optional(),
    vatRateBp: z.number().int().min(0).max(5000).optional(),
    buyerPremiumBp: z.number().int().min(0).max(5000).optional(),
    antiSnipeSec: z.number().int().min(0).max(3600).optional(),
    incrementTable: z.array(z.object({ fromCents: z.number().int().min(0), incrementCents: z.number().int().positive() })).optional(),
    active: z.boolean().optional(),
  });
  app.patch("/api/markets/:code", guard("markets.edit"), async (req, reply) => {
    const body = marketPatch.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body", detail: body.error.flatten() });
    if (body.data.incrementTable) {
      try {
        validateIncrementTable(body.data.incrementTable);
      } catch (err) {
        return reply.code(422).send({ error: "invalid_increment_table", detail: (err as Error).message });
      }
    }
    const { code } = req.params as { code: string };
    const [row] = await ctx.db.update(markets).set(body.data).where(eq(markets.code, code)).returning();
    if (!row) return reply.code(404).send({ error: "not_found" });
    await writeAudit(ctx.db, actor(req), "settings", "market_updated", code, { fields: Object.keys(body.data) });
    return { market: row };
  });

  // ── Team ──────────────────────────────────────────────────────────────────
  app.get("/api/team", guard("team.view"), async () => {
    const users = await ctx.db
      .select({
        id: adminUsers.id,
        email: adminUsers.email,
        name: adminUsers.name,
        roleId: adminUsers.roleId,
        active: adminUsers.active,
        createdAt: adminUsers.createdAt,
      })
      .from(adminUsers)
      .orderBy(adminUsers.createdAt);
    return { users };
  });

  const userBody = z.object({
    email: z.string().email(),
    name: z.string().min(1),
    password: z.string().min(1),
    roleId: z.string().min(1),
  });
  app.post("/api/team", guard("team.manage"), async (req, reply) => {
    const body = userBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body", detail: body.error.flatten() });
    const check = validatePassword(body.data.password, { email: body.data.email, name: body.data.name });
    if (!check.ok) return reply.code(422).send({ error: "weak_password", detail: check.errors });
    const [role] = await ctx.db.select().from(adminRoles).where(eq(adminRoles.id, body.data.roleId));
    if (!role) return reply.code(422).send({ error: "unknown_role" });
    const [row] = await ctx.db
      .insert(adminUsers)
      .values({
        email: body.data.email.toLowerCase(),
        name: body.data.name,
        roleId: body.data.roleId,
        passwordHash: await hashPassword(body.data.password),
      })
      .onConflictDoNothing()
      .returning();
    if (!row) return reply.code(409).send({ error: "email_exists" });
    await writeAudit(ctx.db, actor(req), "team", "user_created", row.email, { role: body.data.roleId });
    return { user: { id: row.id, email: row.email, name: row.name, roleId: row.roleId, active: row.active } };
  });

  const userPatch = z.object({
    name: z.string().min(1).optional(),
    roleId: z.string().min(1).optional(),
    active: z.boolean().optional(),
    password: z.string().min(1).optional(),
  });
  app.patch("/api/team/:id", guard("team.manage"), async (req, reply) => {
    const body = userPatch.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body", detail: body.error.flatten() });
    const { id } = req.params as { id: string };
    const result = await ctx.db.transaction(async (tx) => {
      const [user] = await tx.select().from(adminUsers).where(eq(adminUsers.id, id)).for("update");
      if (!user) return null;
      // Never lock out the last active Super Admin.
      const demotes = (body.data.roleId && body.data.roleId !== "super_admin") || body.data.active === false;
      if (user.roleId === "super_admin" && demotes) {
        const others = await tx
          .select({ id: adminUsers.id })
          .from(adminUsers)
          .where(and(eq(adminUsers.roleId, "super_admin"), eq(adminUsers.active, true), ne(adminUsers.id, id)));
        if (others.length === 0) return "last_super_admin" as const;
      }
      if (body.data.roleId) {
        const [role] = await tx.select().from(adminRoles).where(eq(adminRoles.id, body.data.roleId));
        if (!role) return "unknown_role" as const;
      }
      const { password, ...rest } = body.data;
      if (password) {
        const check = validatePassword(password, { email: user.email, name: body.data.name ?? user.name });
        if (!check.ok) return { weak: check.errors } as const;
      }
      const patch: Record<string, unknown> = { ...rest };
      if (password) patch.passwordHash = await hashPassword(password);
      const [row] = await tx.update(adminUsers).set(patch).where(eq(adminUsers.id, id)).returning();
      // Deactivation, role change, or a password reset must end the target's
      // live sessions — access tokens expire on their own short TTL.
      const roleChanged = body.data.roleId !== undefined && body.data.roleId !== user.roleId;
      if (body.data.active === false || roleChanged || password) {
        await revokeAllUserRefreshTokens(tx, id, ctx.now());
      }
      await writeAudit(tx, actor(req), "team", "user_updated", row!.email, { fields: Object.keys(body.data) });
      return row!;
    });
    if (result === null) return reply.code(404).send({ error: "not_found" });
    if (result === "last_super_admin") return reply.code(409).send({ error: "cannot_demote_last_super_admin" });
    if (result === "unknown_role") return reply.code(422).send({ error: "unknown_role" });
    if ("weak" in result) return reply.code(422).send({ error: "weak_password", detail: result.weak });
    return { user: { id: result.id, email: result.email, name: result.name, roleId: result.roleId, active: result.active } };
  });

  // ── Roles & permission matrix ────────────────────────────────────────────
  app.get("/api/roles", guard("team.view"), async () => {
    const roles = await ctx.db.select().from(adminRoles);
    const grants = await ctx.db.select().from(rolePermissions);
    const byRole: Record<string, string[]> = {};
    for (const g of grants) (byRole[g.roleId] ??= []).push(g.permission);
    return {
      roles: roles.map((r) => ({ ...r, permissions: byRole[r.id] ?? [] })),
      allPermissions: PERMISSIONS,
    };
  });

  const permsBody = z.object({ permissions: z.array(z.string()) });
  app.put("/api/roles/:roleId/permissions", guard("roles.manage"), async (req, reply) => {
    const { roleId } = req.params as { roleId: string };
    if (roleId === "super_admin") return reply.code(409).send({ error: "super_admin_matrix_locked" });
    const body = permsBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body" });
    const invalid = body.data.permissions.filter((p) => !(PERMISSIONS as readonly string[]).includes(p));
    if (invalid.length) return reply.code(422).send({ error: "unknown_permissions", invalid });
    const [role] = await ctx.db.select().from(adminRoles).where(eq(adminRoles.id, roleId));
    if (!role) return reply.code(404).send({ error: "not_found" });
    await ctx.db.transaction(async (tx) => {
      await tx.delete(rolePermissions).where(eq(rolePermissions.roleId, roleId));
      for (const permission of new Set(body.data.permissions)) {
        await tx.insert(rolePermissions).values({ roleId, permission: permission as Permission });
      }
      await writeAudit(tx, actor(req), "team", "role_permissions_updated", roleId, {
        count: body.data.permissions.length,
      });
    });
    perms.invalidate(roleId);
    return { ok: true };
  });

  // ── Audit log ─────────────────────────────────────────────────────────────
  app.get("/api/audit", guard("audit.view"), async (req) => {
    const q = req.query as { type?: string; limit?: string };
    const limit = Math.min(Number(q.limit ?? 200), 1000);
    const rows = await ctx.db
      .select()
      .from(auditLog)
      .where(q.type ? eq(auditLog.type, q.type) : undefined)
      .orderBy(desc(auditLog.createdAt))
      .limit(limit);
    return { entries: rows };
  });

  // ── Notifications outbox (read-only operational visibility) ────────────────
  app.get("/api/notifications", guard("audit.view"), async (req) => {
    const q = req.query as { status?: string; type?: string; limit?: string };
    const limit = Math.min(Number(q.limit ?? 200), 1000);
    const conds = [];
    if (q.status) conds.push(eq(notifications.status, q.status));
    if (q.type) conds.push(eq(notifications.type, q.type));
    const rows = await ctx.db
      .select({
        id: notifications.id,
        type: notifications.type,
        toEmail: notifications.toEmail,
        lang: notifications.lang,
        subject: notifications.subject,
        status: notifications.status,
        attempts: notifications.attempts,
        lastError: notifications.lastError,
        sentAt: notifications.sentAt,
        createdAt: notifications.createdAt,
      })
      .from(notifications)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(notifications.createdAt))
      .limit(limit);
    return { notifications: rows };
  });
}
