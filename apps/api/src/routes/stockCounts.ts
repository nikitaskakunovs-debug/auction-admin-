import { items, stockCountScans, stockCounts, stockMovements, warehouseLocations } from "@auction/db";
import { and, desc, eq, gt, inArray, or, sql } from "drizzle-orm";
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
 * the movements ledger as `count_adjust` with the operator's name. The diff
 * as approved is snapshotted onto the session (stock_counts.result) — after
 * approval the live data no longer shows what was corrected.
 */

/** Item statuses that mean "physically on our shelves". */
const PHYSICAL_STATUSES = ["draft", "listed", "live", "won", "awaiting_payment", "paid", "unsold", "unpaid_cancelled", "no_pickup_cancelled"];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Either the pool handle or an open transaction — the review path runs the
 * whole diff inside the approving transaction, under the session row lock. */
type DbLike = Pick<AppContext["db"], "select">;

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
  /** The same item (or code) was scanned in more than one bin this session —
   * the latest scan decides the outcome, but the review screen must say so. */
  multipleBins: boolean;
}

export function registerStockCountRoutes(app: FastifyInstance, ctx: AppContext, perms: PermissionService): void {
  const guard = (p: Parameters<typeof requirePermission>[1]) => ({ preHandler: requirePermission(perms, p) });
  const actor = (req: { admin?: { sub: string; name: string } }) => ({
    id: req.admin?.sub ?? null,
    label: req.admin?.name ?? "Unknown",
  });

  /** The session row as the floor is allowed to see it: progress only. The
   * approved diff snapshot lives on the same row and is answer-key material,
   * so it never rides along on the items.view endpoints. */
  const publicCount = (c: typeof stockCounts.$inferSelect) => {
    const { result: _snapshot, ...rest } = c;
    return rest;
  };

  /** Bins a session covers: explicit list, else zones, else the whole
   * warehouse — which means every bin that is active OR still holds stock, so
   * a deactivated bin with items in it cannot silently drop out of the count. */
  async function scopedBins(db: DbLike, count: typeof stockCounts.$inferSelect) {
    if (count.locationIds.length > 0) {
      return db.select().from(warehouseLocations).where(inArray(warehouseLocations.id, count.locationIds));
    }
    if (count.zones.length > 0) {
      return db.select().from(warehouseLocations).where(inArray(warehouseLocations.zone, count.zones));
    }
    return db
      .select()
      .from(warehouseLocations)
      .where(
        or(
          eq(warehouseLocations.active, true),
          sql`exists (select 1 from ${items} where ${items.locationId} = ${warehouseLocations.id})`,
        ),
      );
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
    return { count: publicCount(row!) };
  });

  app.get("/api/stock-counts", guard("items.view"), async () => {
    const rows = await ctx.db.select().from(stockCounts).orderBy(desc(stockCounts.startedAt)).limit(50);
    const withProgress = await Promise.all(
      rows.map(async (c) => {
        const bins = await scopedBins(ctx.db, c);
        const binIds = new Set(bins.map((b) => b.id));
        const scans = await ctx.db
          .select({ id: stockCountScans.id })
          .from(stockCountScans)
          .where(eq(stockCountScans.countId, c.id));
        return {
          ...publicCount(c),
          binCount: bins.length,
          // Only bins inside the scope count towards progress — a stale
          // done-flag for a bin outside it must not read as 3/2 done.
          doneCount: c.doneLocationIds.filter((id) => binIds.has(id)).length,
          scanCount: scans.length,
        };
      }),
    );
    return { counts: withProgress };
  });

  app.get("/api/stock-counts/:id", guard("items.view"), async (req, reply) => {
    const { id } = req.params as { id: string };
    const [count] = await ctx.db.select().from(stockCounts).where(eq(stockCounts.id, id));
    if (!count) return reply.code(404).send({ error: "not_found" });
    const bins = await scopedBins(ctx.db, count);
    const scans = await ctx.db.select().from(stockCountScans).where(eq(stockCountScans.countId, id));
    const perBin = new Map<string, number>();
    for (const s of scans) perBin.set(s.locationId, (perBin.get(s.locationId) ?? 0) + 1);
    return {
      count: publicCount(count),
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
    const bins = await scopedBins(ctx.db, count);
    if (!bins.some((b) => b.id === body.data.locationId)) return reply.code(409).send({ error: "bin_out_of_scope" });

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
    // Two phones finishing two bins at the same moment used to lose one of
    // them (read-modify-write on a jsonb array) — the row lock serialises it.
    const outcome = await ctx.db.transaction(async (tx): Promise<{ code: number; error: string } | { ok: true }> => {
      const [count] = await tx.select().from(stockCounts).where(eq(stockCounts.id, id)).for("update");
      if (!count) return { code: 404, error: "not_found" };
      if (count.status !== "open") return { code: 409, error: "count_not_open" };
      const bins = await scopedBins(tx, count);
      if (!bins.some((b) => b.id === body.data.locationId)) return { code: 409, error: "bin_out_of_scope" };
      if (!count.doneLocationIds.includes(body.data.locationId)) {
        await tx
          .update(stockCounts)
          .set({ doneLocationIds: [...count.doneLocationIds, body.data.locationId] })
          .where(eq(stockCounts.id, id));
      }
      return { ok: true };
    });
    if ("error" in outcome) return reply.code(outcome.code).send({ error: outcome.error });
    return outcome;
  });

  // ── Review ─────────────────────────────────────────────────────────────────

  async function computeDiff(db: DbLike, count: typeof stockCounts.$inferSelect): Promise<DiffLine[]> {
    const bins = await scopedBins(db, count);
    const binById = new Map(bins.map((b) => [b.id, b]));
    const allLabels = new Map<string, string>();
    for (const b of await db.select({ id: warehouseLocations.id, label: warehouseLocations.label }).from(warehouseLocations)) {
      allLabels.set(b.id, b.label);
    }
    // Chronological: a re-scan in the right bin must beat the earlier mistake,
    // so the LAST scan of an item decides its outcome. Without the ORDER BY
    // Postgres row order picked the winner and approval could file the item
    // into the wrong bin.
    const scans = await db
      .select()
      .from(stockCountScans)
      .where(eq(stockCountScans.countId, count.id))
      .orderBy(stockCountScans.scannedAt, stockCountScans.id);
    const scannedByItem = new Map<string, (typeof scans)[number]>();
    /** itemId (or raw code, for unresolved labels) → the distinct bins it turned up in. */
    const binsSeen = new Map<string, Set<string>>();
    for (const s of scans) {
      if (s.itemId) scannedByItem.set(s.itemId, s);
      const key = s.itemId ?? s.code;
      const seen = binsSeen.get(key) ?? new Set<string>();
      seen.add(s.locationId);
      binsSeen.set(key, seen);
    }
    const multiBin = (key: string | null) => (key ? (binsSeen.get(key)?.size ?? 0) > 1 : false);

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
          multipleBins: multiBin(s.code),
        });
      }
    }

    // Expected = physically-present items whose bin is inside the scope.
    const doneBinIds = count.doneLocationIds.filter((b) => binById.has(b));
    const expected = doneBinIds.length
      ? await db
          .select({ id: items.id, sku: items.sku, title: items.title, locationId: items.locationId, status: items.status })
          .from(items)
          .where(and(inArray(items.locationId, [...binById.keys()]), inArray(items.status, PHYSICAL_STATUSES)))
      : [];
    const expectedIds = new Set(expected.map((e) => e.id));

    // The shelf keeps working during a count, so every classification below
    // has to ask "did this item legitimately move after we started?". One
    // query answers it for all of them instead of one query per line.
    const involved = [...new Set([...expectedIds, ...scannedByItem.keys()])];
    const movesByItem = new Map<string, Array<{ fromLocationId: string | null }>>();
    if (involved.length > 0) {
      const rows = await db
        .select({ itemId: stockMovements.itemId, fromLocationId: stockMovements.fromLocationId })
        .from(stockMovements)
        .where(and(inArray(stockMovements.itemId, involved), gt(stockMovements.createdAt, count.startedAt)));
      for (const m of rows) {
        const list = movesByItem.get(m.itemId) ?? [];
        list.push({ fromLocationId: m.fromLocationId });
        movesByItem.set(m.itemId, list);
      }
    }
    /** Did something take this item out of `bin` after the session opened? */
    const leftBin = (itemId: string, bin: string | null): boolean =>
      bin !== null && (movesByItem.get(itemId) ?? []).some((m) => m.fromLocationId === bin);

    for (const it of expected) {
      const scan = scannedByItem.get(it.id);
      if (scan) {
        // Scanned somewhere other than where the system files it. That is a
        // misfiling — unless the item left the bin it was counted in after we
        // counted it, in which case the system is right and we are stale:
        // calling that `wrong_bin` made approval undo a legitimate move.
        const outcome =
          scan.locationId === it.locationId ? "match" : leftBin(it.id, scan.locationId) ? "moved_during" : "wrong_bin";
        lines.push({
          outcome,
          itemId: it.id, sku: it.sku, title: it.title,
          expectedLocationId: it.locationId, expectedLabel: it.locationId ? allLabels.get(it.locationId) ?? null : null,
          foundLocationId: scan.locationId, foundLabel: allLabels.get(scan.locationId) ?? null, code: null,
          multipleBins: multiBin(it.id),
        });
        continue;
      }
      // Not scanned. Only a problem if its bin was actually counted to the end.
      if (!it.locationId || !doneBinIds.includes(it.locationId)) continue;
      // Only a movement that took the item OUT of the bin we expected it in
      // excuses the absence — a putaway INTO that very bin used to downgrade a
      // genuine `missing` to `moved_during`.
      lines.push({
        outcome: leftBin(it.id, it.locationId) ? "moved_during" : "missing",
        itemId: it.id, sku: it.sku, title: it.title,
        expectedLocationId: it.locationId, expectedLabel: allLabels.get(it.locationId) ?? null,
        foundLocationId: null, foundLabel: null, code: null,
        multipleBins: multiBin(it.id),
      });
    }

    // Items scanned inside scope whose system bin is OUTSIDE the scope: they
    // exist, they were found, the system just files them elsewhere — unless
    // the shelf moved on after the scan. An item picked for an order mid-count
    // lands here with locationId = null; calling that `wrong_bin` made
    // approval put a shipped item back on the shelf.
    for (const [itemId, scan] of scannedByItem) {
      if (expectedIds.has(itemId)) continue;
      const [it] = await db
        .select({ id: items.id, sku: items.sku, title: items.title, locationId: items.locationId })
        .from(items)
        .where(eq(items.id, itemId));
      if (!it) continue;
      const movements = await db
        .select({ fromLocationId: stockMovements.fromLocationId })
        .from(stockMovements)
        .where(and(eq(stockMovements.itemId, it.id), gt(stockMovements.createdAt, count.startedAt)));
      // Took it out of the bin it was counted in, or it left the shelf
      // entirely (picked → no location at all): legitimately moved, not misfiled.
      const leftScannedBin = movements.some((m) => m.fromLocationId === scan.locationId);
      const offShelf = it.locationId === null && movements.length > 0;
      const outcome = leftScannedBin || offShelf ? "moved_during" : it.locationId === scan.locationId ? "match" : "wrong_bin";
      lines.push({
        outcome,
        itemId: it.id, sku: it.sku, title: it.title,
        expectedLocationId: it.locationId, expectedLabel: it.locationId ? allLabels.get(it.locationId) ?? null : null,
        foundLocationId: scan.locationId, foundLabel: allLabels.get(scan.locationId) ?? null, code: null,
        multipleBins: multiBin(it.id),
      });
    }

    const order = { missing: 0, wrong_bin: 1, unknown_label: 2, moved_during: 3, match: 4 };
    return lines.sort((a, b) => order[a.outcome] - order[b.outcome] || (a.sku ?? "").localeCompare(b.sku ?? ""));
  }

  const tallyOf = (lines: DiffLine[]) => {
    const tally = { match: 0, wrong_bin: 0, missing: 0, moved_during: 0, unknown_label: 0 };
    for (const l of lines) tally[l.outcome] += 1;
    return tally;
  };

  /** The diff is the answer key — it says exactly what each bin should hold,
   * so it is manager-only (`grading.review`), same as approval. The list and
   * detail endpoints stay on items.view: they carry progress, never contents. */
  app.get("/api/stock-counts/:id/diff", guard("grading.review"), async (req, reply) => {
    const { id } = req.params as { id: string };
    const [count] = await ctx.db.select().from(stockCounts).where(eq(stockCounts.id, id));
    if (!count) return reply.code(404).send({ error: "not_found" });
    // A closed session answers from the snapshot taken at approval — live data
    // has since been corrected and would show an empty, misleading diff.
    if (count.status !== "open" && count.result) {
      return { count: publicCount(count), lines: count.result.lines, tally: count.result.tally };
    }
    const lines = await computeDiff(ctx.db, count);
    return { count: publicCount(count), lines, tally: tallyOf(lines) };
  });

  /** Approve: wrong-bin items move to where they were found; missing items
   * lose their bin (physical search continues, the shelf is honest). All of
   * it lands in the movements ledger as count_adjust. The whole thing runs
   * under a FOR UPDATE lock on the session with an `open` predicate on the
   * closing write, so two managers clicking at once cannot both apply it. */
  app.post("/api/stock-counts/:id/approve", guard("grading.review"), async (req, reply) => {
    const { id } = req.params as { id: string };
    const outcome = await ctx.db.transaction(
      async (tx): Promise<{ code: number; error: string } | { ok: true; moved: number; missing: number }> => {
        const [count] = await tx.select().from(stockCounts).where(eq(stockCounts.id, id)).for("update");
        if (!count) return { code: 404, error: "not_found" };
        if (count.status !== "open") return { code: 409, error: "count_not_open" };

        const lines = await computeDiff(tx, count);
        let moves = 0;
        let cleared = 0;
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
        const [closed] = await tx
          .update(stockCounts)
          .set({
            status: "approved",
            approvedById: req.admin!.sub,
            approvedAt: ctx.now(),
            result: { tally: tallyOf(lines), lines, moved: moves, missing: cleared },
          })
          .where(and(eq(stockCounts.id, id), eq(stockCounts.status, "open")))
          .returning();
        if (!closed) return { code: 409, error: "count_not_open" };
        await writeAudit(tx, actor(req), "item", "count_approved", count.name, {
          countId: id,
          moved: moves,
          missing: cleared,
        });
        return { ok: true, moved: moves, missing: cleared };
      },
    );
    if ("error" in outcome) return reply.code(outcome.code).send({ error: outcome.error });
    return outcome;
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
