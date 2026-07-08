import { rolePermissions, type Db } from "@auction/db";
import type { Permission } from "@auction/domain";
import { eq } from "drizzle-orm";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { AccessClaims } from "./jwt.js";

/**
 * Action-level RBAC. The JWT carries only the role id; grants live in
 * role_permissions so a Super Admin can edit the matrix at runtime. A small
 * TTL cache keeps the hot path off the database.
 */

const CACHE_TTL_MS = 15_000;

interface CacheEntry {
  perms: Set<string>;
  at: number;
}

export class PermissionService {
  private cache = new Map<string, CacheEntry>();

  constructor(private db: Db) {}

  invalidate(roleId?: string): void {
    if (roleId) this.cache.delete(roleId);
    else this.cache.clear();
  }

  async permissionsFor(roleId: string): Promise<Set<string>> {
    const hit = this.cache.get(roleId);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.perms;
    const rows = await this.db
      .select({ permission: rolePermissions.permission })
      .from(rolePermissions)
      .where(eq(rolePermissions.roleId, roleId));
    const perms = new Set(rows.map((r) => r.permission));
    this.cache.set(roleId, { perms, at: Date.now() });
    return perms;
  }

  async has(roleId: string, permission: Permission): Promise<boolean> {
    return (await this.permissionsFor(roleId)).has(permission);
  }
}

declare module "fastify" {
  interface FastifyRequest {
    admin?: AccessClaims;
  }
}

export function requirePermission(perms: PermissionService, permission: Permission) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const admin = req.admin;
    if (!admin) {
      await reply.code(401).send({ error: "unauthenticated" });
      return;
    }
    if (!(await perms.has(admin.role, permission))) {
      await reply.code(403).send({ error: "forbidden", permission });
      return;
    }
  };
}
