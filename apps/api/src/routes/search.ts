import { auctions, customers, items, listings, orders } from "@auction/db";
import { desc, eq, or, sql, type SQL } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.js";
import type { PermissionService } from "../auth/rbac.js";

/**
 * Global ⌘K search — one query across lots, auctions, orders, and bidders.
 * Each group is included only when the caller's role may view it, so the
 * palette can render whatever comes back without its own permission logic.
 * Matching is accent-insensitive (Latvian diacritics folded on both sides)
 * via SQL translate() — no extension required.
 */

const FOLD_FROM = "āčēģīķļņšūžĀČĒĢĪĶĻŅŠŪŽ";
const FOLD_TO = "acegiklnsuzacegiklnsuz";

/** Accent-fold + lowercase a column for LIKE matching. */
const folded = (col: SQL | { getSQL(): SQL }): SQL =>
  sql`translate(lower(${col}), ${FOLD_FROM}, ${FOLD_TO})`;

const foldQuery = (q: string): string => {
  let out = q.toLowerCase();
  for (let i = 0; i < FOLD_FROM.length; i++) out = out.replaceAll(FOLD_FROM[i]!, FOLD_TO[i]!);
  return out;
};

export function registerSearchRoutes(app: FastifyInstance, ctx: AppContext, perms: PermissionService): void {
  app.get("/api/search", async (req, reply) => {
    if (!req.admin) return reply.code(401).send({ error: "unauthenticated" });
    const q = ((req.query as { q?: string }).q ?? "").trim();
    if (q.length < 2) return { groups: [] };
    const needle = `%${foldQuery(q)}%`;
    const like = (col: SQL | { getSQL(): SQL }) => sql`${folded(col)} like ${needle}`;
    const canSee = await perms.permissionsFor(req.admin.role);

    const groups: Array<{ kind: string; results: unknown[] }> = [];

    if (canSee.has("items.view")) {
      const rows = await ctx.db
        .select({ id: items.id, sku: items.sku, title: items.title, status: items.status })
        .from(items)
        .where(or(like(items.sku), like(items.title)))
        .orderBy(desc(items.createdAt))
        .limit(6);
      if (rows.length) groups.push({ kind: "lots", results: rows });
    }

    if (canSee.has("auctions.view")) {
      const rows = await ctx.db
        .select({ id: auctions.id, status: auctions.status, currentPriceCents: auctions.currentPriceCents, sku: items.sku, title: items.title })
        .from(auctions)
        .innerJoin(listings, eq(auctions.listingId, listings.id))
        .innerJoin(items, eq(listings.itemId, items.id))
        .where(or(like(items.sku), like(items.title)))
        .orderBy(desc(auctions.createdAt))
        .limit(6);
      if (rows.length) groups.push({ kind: "auctions", results: rows });
    }

    if (canSee.has("orders.view")) {
      const rows = await ctx.db
        .select({ id: orders.id, ref: orders.ref, customerAlias: orders.customerAlias, status: orders.status, totalCents: orders.totalCents })
        .from(orders)
        .where(or(like(orders.ref), like(orders.customerAlias), like(orders.customerEmail)))
        .orderBy(desc(orders.createdAt))
        .limit(6);
      if (rows.length) groups.push({ kind: "orders", results: rows });
    }

    if (canSee.has("customers.view")) {
      const rows = await ctx.db
        .select({ id: customers.id, alias: customers.alias, email: customers.email, blocked: customers.blocked, strikes: customers.strikes })
        .from(customers)
        .where(or(like(customers.alias), like(customers.email), like(sql`coalesce(${customers.name}, '')`)))
        .orderBy(desc(customers.createdAt))
        .limit(6);
      if (rows.length) groups.push({ kind: "bidders", results: rows });
    }

    return { groups };
  });
}
