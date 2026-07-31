import { items, stockCountScans, stockCounts, stockMovements, warehouseLocations } from "@auction/db";
import { and, desc, eq, gt, inArray, or } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { writeAudit } from "../audit.js";
import type { AppContext } from "../context.js";
import { requirePermission, type PermissionService } from "../auth/rbac.js";

/**
 * W5 — stock-taking (inventarizācija). A session scopes a set of bins,
 * workers scan blind (the phone never reveals what a bin should hold), and
 * the diff is computed at review time against live data:
 *
 *   match         scanned where the system expects it
 *   wrong_bin     scanned, but the system thinks it lives elsewhere
 *   missing       expected in a *finished* bin, never scanned — and no
 *                 movement since the session started explains it
 *   moved_during  expected but legitimately picked/moved mid-session
 *   unknown_label a code the system cannot resolve
 *
 * Nothing changes stock until a manager approves; corrections then land in
 * the movements ledger as `count_adjust` with the operator's name.
 */

/** Item statuses that mean "physically on our shelves". */
const PHYSICAL_STATUSES = ["draft", "listed", "live", "won", "awaiting_payment", "paid", "unsold", "unpaid_cancelled", "no_pickup_cancelled"];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface DiffLine {
  outcome: "match" | "wrong_bin" | "missing" | "moved_during" | "unknown_label";
  itemId: string | null;
  sku: string | null;
  title: string | null;
  /** Where the system thinks it lives. */
  expectedLocationId: string | null;
  expectedLabel: string | null;
  /** Where it was actually scanned (null for missing). */
  foundLocationId: string | null;
  foundLabel: string | null;
  /** Raw code, for unknown labels. */
  code: string | null;
}

export function registerStockCountRoutes(app: FastifyInstance, ctx: AppContext, perms: PermissionService): void {
  const guard = (p: Parameters<typeof requirePermission>[1]) => ({ preHandler: requirePermission(perms, p) });
  const actor = (req: { admin?: { sub: string; name: string } }) => ({
    id: req.admin?.sub ?? null,
    label: req.admin?.name ?? "Unknown",
  });

  /** Bins a session covers: explicit list, else zones, else every active bin. */
  async function scopedBins(count: typeof stockCounts.$inferSelect) {
    if (count.locationIds.length > 0) {
      return ctx.db.select().from(warehouseLocations).where(inArray(warehouseLocations.id, count.locationIds));
    }
    if (count.zones.length > 0) {
      return ctx.db.select().from(warehouseLocations).where(inArray(warehouseLocations.zone, count.zones));
    }
    return ctx.db.select().from(warehouseLocations).where(eq(warehouseLocations.active, true));
  }

  // ── Sessions ───────────────────────────────────────────────────────────────

  const createBody = z.object({
    name: z.string().min(2).max(120),
    zones: z.array(z.string().min(1).max(16)).max(20).default([]),
    locationIds: z.array(z.string().uuid()).max(500).default([]),
  });
  app.post("/api/stock-counts", guard("warehouse.manage"), async (req, reply) => {
    const body = createBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body", detail: body.error.flatten() });
    const [row] = await ctx.db
      .insert(stockCounts)
      .values({
        name: body.data.name,
        zones: body.data.zones.map((zn) => zn.toUpperCase()),
        locationIds: body.data.locationIds,
        createdById: req.admin!.sub,
        startedAt: ctx.now(),
      })
      .returning();
    await writeAudit(ctx.db, actor(req), "item", "count_started", row!.name, { countId: row!.id });
    return { count: row };
  });

  app.get("/api/stock-counts", guard("items.view"), async () => {
    const rows = await ctx.db.select().from(stockCounts).orderBy(desc(stockCounts.startedAt)).limit(50);
    const withProgress = await Promise.all(
      rows.map(async (c) => {
        const bins = await scopedBins(c);
        const scans = await ctx.db
          .select({ id: stockCountScans.id })
          .from(stockCountScans)
          .where(eq(stockCountScans.countId, c.id));
        return { ...c, binCount: bins.length, doneCount: c.doneLocationIds.length, scanCount: scans.length };
      }),
    );
    return { counts: withProgress };
  });

  app.get("/api/stock-counts/:id", guard("items.view"), async (req, reply) => {
    const { id } = req.params as { id: string };
    const [count] = await ctx.db.select().from(stockCounts).where(eq(stockCounts.id, id));
    if (!count) return reply.code(404).send({ error: "not_found" });
    const bins = await scopedBins(count);
    const scans = await ctx.db.select().from(stockCountScans).where(eq(stockCountScans.countId, id));
    const perBin = new Map<string, number>();
    for (const s of scans) perBin.set(s.locationId, (perBin.get(s.locationId) ?? 0) + 1);
    return {
      count,
      bins: bins
        .map((b) => ({ id: b.id, label: b.label, zone: b.zone, scanned: perBin.get(b.id) ?? 0, done: count.doneLocationIds.includes(b.id) }))
        .sort((a, b) => a.label.localeCompare(b.label)),
      scanCount: scans.length,
    };
  });

  // ── Counting (the phone) ───────────────────────────────────────────────────

  const scanBody = z.object({ code: z.string().min(2).max(200), locationId: z.string().uuid() });
  app.post("/api/stock-counts/:id/scan", guard("warehouse.manage"), async (req, reply) => {
    const body = scanBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body" });
    const { id } = req.params as { id: string };
    const [count] = await ctx.db.select().from(stockCounts).where(eq(stockCounts.id, id));
    if (!count) return reply.code(404).send({ error: "not_found" });
    if (count.status !== "open") return reply.code(409).send({ error: "count_not_open" });

    const code = body.data.code.trim();
    // Same resolution as the scan-lookup: an item uuid from the QR, or a SKU.
    const [item] = await ctx.db
      .select({ id: items.id, sku: items.sku, title: items.title, locationId: items.locationId })
      .from(items)
      .where(UUID_RE.test(code) ? or(eq(items.id, code), eq(items.sku, code.toUpperCase())) : eq(items.sku, code.toUpperCase()));

    await ctx.db.insert(stockCountScans).values({
      countId: id,
      code,
      itemId: item?.id ?? null,
      locationId: body.data.locationId,
      scannedById: req.admin!.sub,
      scannedByLabel: req.admin!.name,
      scannedAt: ctx.now(),
    });

    // Per-scan feedback stays blind: it says where THIS item belongs, never
    // what else the bin should contain.
    if (!item) return { known: false as const };
    return {
      known: true as const,
      sku: item.sku,
      title: item.title,
      samePlace: item.locationId === body.data.locationId,
    };
  });

  const binDoneBody = z.object({ locationId: z.string().uuid() });
  app.post("/api/stock-counts/:id/bin-done", guard("warehouse.manage"), async (req, reply) => {
    const body = binDoneBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body" });
    const { id } = req.params as { id: string };
    const [count] = await ctx.db.select().from(stockCounts).where(eq(stockCounts.id, id));
    if (!count) return reply.code(404).send({ error: "not_found" });
    if (count.status !== "open") return reply.code(409).send({ error: "count_not_open" });
    if (!count.doneLocationIds.includes(body.data.locationId)) {
      await ctx.db
        .update(stockCounts)
        .set({ doneLocationIds: [...count.doneLocationIds, body.data.locationId] })
        .where(eq(stockCounts.id, id));
    }
    return { ok: true };
  });

  // ── Review ─────────────────────────────────────────────────────────────────

  async function computeDiff(count: typeof stockCounts.$inferSelect): Promise<DiffLine[]> {
    const bins = await scopedBins(count);
    const binById = new Map(bins.map((b) => [b.id, b]));
    const allLabels = new Map<string, string>();
    for (const b of await ctx.db.select({ id: warehouseLocations.id, label: warehouseLocations.label }).from(warehouseLocations)) {
      allLabels.set(b.id, b.label);
    }
    const scans = await ctx.db.select().from(stockCountScans).where(eq(stockCountScans.countId, count.id));
    const scannedByItem = new Map<string, (typeof scans)[number]>();
    for (const s of scans) if (s.itemId && !scannedByItem.has(s.itemId)) scannedByItem.set(s.itemId, s);

    const lines: DiffLine[] = [];

    // Unknown labels — dedupe by code.
    const unknownCodes = new Set<string>();
    for (const s of scans) {
      if (!s.itemId && !unknownCodes.has(s.code)) {
        unknownCodes.add(s.code);
        lines.push({
          outcome: "unknown_label", itemId: null, sku: null, title: null,
          expectedLocationId: null, expectedLabel: null,
          foundLocationId: s.locationId, foundLabel: allLabels.get(s.locationId) ?? null, code: s.code,
        });
      }
    }

    // Expected = physically-present items whose bin is inside the scope.
    const doneBinIds = count.doneLocationIds.filter((b) => binById.has(b));
    const expected = doneBinIds.length
      ? await ctx.db
          .select({ id: items.id, sku: items.sku, title: items.title, locationId: items.locationId, status: items.status })
          .from(items)
          .where(and(inArray(items.locationId, [...binById.keys()]), inArray(items.status, PHYSICAL_STATUSES)))
      : [];

    for (const it of expected) {
      const scan = scannedByItem.get(it.id);
      if (scan) {
        const same = scan.locationId === it.locationId;
        lines.push({
          outcome: same ? "match" : "wrong_bin",
          itemId: it.id, sku: it.sku, title: it.title,
          expectedLocationId: it.locationId, expectedLabel: it.locationId ? allLabels.get(it.locationId) ?? null : null,
          foundLocationId: scan.locationId, foundLabel: allLabels.get(scan.locationId) ?? null, code: null,
        });
        continue;
      }
      // Not scanned. Only a problem if its bin was actually counted to the end.
      if (!it.locationId || !doneBinIds.includes(it.locationId)) continue;
      // A movement after the session opened explains the absence.
      const [moved] = await ctx.db
        .select({ id: stockMovements.id })
        .from(stockMovements)
        .where(and(eq(stockMovements.itemId, it.id), gt(stockMovements.createdAt, count.startedAt)))
        .limit(1);
      lines.push({
        outcome: moved ? "moved_during" : "missing",
        itemId: it.id, sku: it.sku, title: it.title,
        expectedLocationId: it.locationId, expectedLabel: allLabels.get(it.locationId) ?? null,
        foundLocationId: null, foundLabel: null, code: null,
      });
    }

    // Items scanned inside scope whose system bin is OUTSIDE the scope: they
    // exist, they were found, the system just files them elsewhere.
    for (const [itemId, scan] of scannedByItem) {
      if (expected.some((e) => e.id === itemId)) continue;
      const [it] = await ctx.db
        .select({ id: items.id, sku: items.sku, title: items.title, locationId: items.locationId })
        .from(items)
        .where(eq(items.id, itemId));
      if (!it) continue;
      lines.push({
        outcome: it.locationId === scan.locationId ? "match" : "wrong_bin",
        itemId: it.id, sku: it.sku, title: it.title,
        expectedLocationId: it.locationId, expectedLabel: it.locationId ? allLabels.get(it.locationId) ?? null : null,
        foundLocationId: scan.locationId, foundLabel: allLabels.get(scan.locationId) ?? null, code: null,
      });
    }

    const order = { missing: 0, wrong_bin: 1, unknown_label: 2, moved_during: 3, match: 4 };
    return lines.sort((a, b) => order[a.outcome] - order[b.outcome] || (a.sku ?? "").localeCompare(b.sku ?? ""));
  }

  app.get("/api/stock-counts/:id/diff", guard("items.view"), async (req, reply) => {
    const { id } = req.params as { id: string };
    const [count] = await ctx.db.select().from(stockCounts).where(eq(stockCounts.id, id));
    if (!count) return reply.code(404).send({ error: "not_found" });
    const lines = await computeDiff(count);
    const tally = { match: 0, wrong_bin: 0, missing: 0, moved_during: 0, unknown_label: 0 };
    for (const l of lines) tally[l.outcome] += 1;
    return { count, lines, tally };
  });

  /** Approve: wrong-bin items move to where they were found; missing items
   * lose their bin (physical search continues, the shelf is honest). All of
   * it lands in the movements ledger as count_adjust. */
  app.post("/api/stock-counts/:id/approve", guard("grading.review"), async (req, reply) => {
    const { id } = req.params as { id: string };
    const [count] = await ctx.db.select().from(stockCounts).where(eq(stockCounts.id, id));
    if (!count) return reply.code(404).send({ error: "not_found" });
    if (count.status !== "open") return reply.code(409).send({ error: "count_not_open" });

    const lines = await computeDiff(count);
    let moves = 0;
    let cleared = 0;
    await ctx.db.transaction(async (tx) => {
      for (const line of lines) {
        if (!line.itemId) continue;
        if (line.outcome === "wrong_bin" && line.foundLocationId) {
          await tx.insert(stockMovements).values({
            itemId: line.itemId,
            type: "count_adjust",
            fromLocationId: line.expectedLocationId,
            toLocationId: line.foundLocationId,
            actorId: req.admin!.sub,
            actorLabel: req.admin!.name,
            reason: `inventarizācija: ${count.name}`,
          });
          await tx
            .update(items)
            .set({ locationId: line.foundLocationId, location: line.foundLabel ?? "", updatedAt: ctx.now() })
            .where(eq(items.id, line.itemId));
          moves += 1;
        } else if (line.outcome === "missing") {
          await tx.insert(stockMovements).values({
            itemId: line.itemId,
            type: "count_adjust",
            fromLocationId: line.expectedLocationId,
            toLocationId: null,
            actorId: req.admin!.sub,
            actorLabel: req.admin!.name,
            reason: `inventarizācija: ${count.name} — nav atrasts`,
          });
          await tx.update(items).set({ locationId: null, location: "", updatedAt: ctx.now() }).where(eq(items.id, line.itemId));
          cleared += 1;
        }
      }
      await tx
        .update(stockCounts)
        .set({ status: "approved", approvedById: req.admin!.sub, approvedAt: ctx.now() })
        .where(eq(stockCounts.id, id));
      await writeAudit(tx, actor(req), "item", "count_approved", count.name, {
        countId: id,
        moved: moves,
        missing: cleared,
      });
    });
    return { ok: true, moved: moves, missing: cleared };
  });

  app.post("/api/stock-counts/:id/cancel", guard("warehouse.manage"), async (req, reply) => {
    const { id } = req.params as { id: string };
    const [row] = await ctx.db
      .update(stockCounts)
      .set({ status: "cancelled" })
      .where(and(eq(stockCounts.id, id), eq(stockCounts.status, "open")))
      .returning();
    if (!row) return reply.code(409).send({ error: "count_not_open" });
    await writeAudit(ctx.db, actor(req), "item", "count_cancelled", row.name, { countId: id });
    return { ok: true };
  });
}
