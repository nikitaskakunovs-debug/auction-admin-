import {
  adminUsers,
  auditLog,
  items,
  pickupTicketItems,
  pickupTickets,
  stockMovements,
  warehouseLocations,
} from "@auction/db";
import { activeSeconds, breakSeconds, picksPerHour, type StatusChange } from "@auction/domain";
import { and, desc, eq, gte, inArray, isNotNull, lt, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { requirePermission, type PermissionService } from "../auth/rbac.js";

/** Everything the per-worker table shows for one admin. */
interface WorkerStats {
  userId: string;
  name: string;
  received: number;
  putaway: number;
  moved: number;
  graded: number;
  picks: number;
  tickets: number;
  avgPickSec: number | null;
  picksPerHour: number | null;
  breakSec: number;
}

interface Totals {
  received: number;
  putaways: number;
  graded: number;
  picks: number;
  ticketsClosed: number;
  avgPickSec: number | null;
}

const DAY = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const dayStart = (day: string) => new Date(`${day}T00:00:00.000Z`);
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000);

/** UTC day key of a timestamp — matches the pickup board's dayKey(). */
const utcDay = (d: Date) => d.toISOString().slice(0, 10);

export function registerWarehouseStatsRoutes(app: FastifyInstance, ctx: AppContext, perms: PermissionService): void {
  const guard = (p: Parameters<typeof requirePermission>[1]) => ({ preHandler: requirePermission(perms, p) });

  /**
   * Aggregate one [start, end) window. Scheduler movements (actor_id null)
   * are excluded everywhere — worker numbers describe people.
   */
  async function aggregate(start: Date, end: Date) {
    const movementRows = await ctx.db
      .select({
        actorId: stockMovements.actorId,
        type: stockMovements.type,
        day: sql<string>`to_char(${stockMovements.createdAt} at time zone 'UTC', 'YYYY-MM-DD')`,
        count: sql<string>`count(*)`,
        first: sql<string>`min(${stockMovements.createdAt})`,
        last: sql<string>`max(${stockMovements.createdAt})`,
      })
      .from(stockMovements)
      .where(and(gte(stockMovements.createdAt, start), lt(stockMovements.createdAt, end), isNotNull(stockMovements.actorId)))
      .groupBy(stockMovements.actorId, stockMovements.type, sql`3`);

    const pickRows = await ctx.db
      .select({
        actorId: pickupTicketItems.pickedById,
        day: sql<string>`to_char(${pickupTicketItems.pickedAt} at time zone 'UTC', 'YYYY-MM-DD')`,
        count: sql<string>`count(*)`,
        first: sql<string>`min(${pickupTicketItems.pickedAt})`,
        last: sql<string>`max(${pickupTicketItems.pickedAt})`,
      })
      .from(pickupTicketItems)
      .where(and(gte(pickupTicketItems.pickedAt, start), lt(pickupTicketItems.pickedAt, end), isNotNull(pickupTicketItems.pickedById)))
      .groupBy(pickupTicketItems.pickedById, sql`2`);

    const gradeRows = await ctx.db
      .select({
        actorId: items.gradedById,
        day: sql<string>`to_char(${items.gradedAt} at time zone 'UTC', 'YYYY-MM-DD')`,
        count: sql<string>`count(*)`,
        first: sql<string>`min(${items.gradedAt})`,
        last: sql<string>`max(${items.gradedAt})`,
      })
      .from(items)
      .where(and(gte(items.gradedAt, start), lt(items.gradedAt, end), isNotNull(items.gradedById)))
      .groupBy(items.gradedById, sql`2`);

    const ticketRows = await ctx.db
      .select({
        actorId: pickupTickets.claimedById,
        count: sql<string>`count(*)`,
        avgSec: sql<string | null>`avg(extract(epoch from (${pickupTickets.completedAt} - ${pickupTickets.pickingStartedAt})))`,
      })
      .from(pickupTickets)
      .where(and(gte(pickupTickets.completedAt, start), lt(pickupTickets.completedAt, end), isNotNull(pickupTickets.claimedById)))
      .groupBy(pickupTickets.claimedById);

    // Break time: replay each worker's status-change log (already audited by
    // POST /api/warehouse/status) — no second clock system needed.
    const statusRows = await ctx.db
      .select({ actorId: auditLog.actorId, status: auditLog.target, at: auditLog.createdAt })
      .from(auditLog)
      .where(and(eq(auditLog.action, "worker_status"), gte(auditLog.createdAt, start), lt(auditLog.createdAt, end), isNotNull(auditLog.actorId)))
      .orderBy(auditLog.createdAt);

    // ── Fold into per-worker structures ────────────────────────────────────
    const workers = new Map<string, WorkerStats>();
    const spans = new Map<string, { first: Date; last: Date }>();
    const w = (id: string): WorkerStats => {
      let row = workers.get(id);
      if (!row) {
        row = { userId: id, name: "?", received: 0, putaway: 0, moved: 0, graded: 0, picks: 0, tickets: 0, avgPickSec: null, picksPerHour: null, breakSec: 0 };
        workers.set(id, row);
      }
      return row;
    };
    const widenSpan = (id: string, first: string, last: string) => {
      const f = new Date(first);
      const l = new Date(last);
      const s = spans.get(id);
      if (!s) spans.set(id, { first: f, last: l });
      else {
        if (f < s.first) s.first = f;
        if (l > s.last) s.last = l;
      }
    };

    const byDay = new Map<string, { received: number; putaway: number; picks: number; graded: number }>();
    const day = (d: string) => {
      let row = byDay.get(d);
      if (!row) {
        row = { received: 0, putaway: 0, picks: 0, graded: 0 };
        byDay.set(d, row);
      }
      return row;
    };

    for (const m of movementRows) {
      const id = m.actorId!;
      const n = Number(m.count);
      widenSpan(id, m.first, m.last);
      if (m.type === "intake") {
        w(id).received += n;
        day(m.day).received += n;
      } else if (m.type === "putaway") {
        w(id).putaway += n;
        day(m.day).putaway += n;
      } else if (m.type === "move" || m.type === "restock" || m.type === "adjust" || m.type === "handover") {
        w(id).moved += n;
      }
    }
    for (const p of pickRows) {
      const id = p.actorId!;
      const n = Number(p.count);
      w(id).picks += n;
      day(p.day).picks += n;
      widenSpan(id, p.first, p.last);
    }
    for (const g of gradeRows) {
      const id = g.actorId!;
      const n = Number(g.count);
      w(id).graded += n;
      day(g.day).graded += n;
      widenSpan(id, g.first, g.last);
    }
    for (const t of ticketRows) {
      const row = w(t.actorId!);
      row.tickets += Number(t.count);
      row.avgPickSec = t.avgSec === null ? null : Math.round(Number(t.avgSec));
    }

    // Breaks per worker per UTC day (a lunch left on overnight would otherwise
    // swallow the next morning); "until" is end-of-day, capped at the window
    // end and at now for the running day.
    const changesByWorkerDay = new Map<string, StatusChange[]>();
    for (const s of statusRows) {
      const key = `${s.actorId}|${utcDay(s.at)}`;
      const list = changesByWorkerDay.get(key) ?? [];
      list.push({ status: s.status, at: s.at });
      changesByWorkerDay.set(key, list);
    }
    for (const [key, changes] of changesByWorkerDay) {
      const [id, dayKey] = key.split("|") as [string, string];
      const dayEnd = addDays(dayStart(dayKey), 1);
      const until = new Date(Math.min(dayEnd.getTime(), end.getTime(), ctx.now().getTime()));
      w(id).breakSec += breakSeconds(changes, until);
    }

    for (const row of workers.values()) {
      const span = spans.get(row.userId);
      const active = activeSeconds(span?.first ?? null, span?.last ?? null, row.breakSec);
      row.picksPerHour = picksPerHour(row.picks, active);
    }

    // Names in one lookup; unknown ids (deleted admins) keep "?".
    const ids = [...workers.keys()];
    if (ids.length > 0) {
      const names = await ctx.db.select({ id: adminUsers.id, name: adminUsers.name }).from(adminUsers).where(inArray(adminUsers.id, ids));
      for (const n of names) {
        const row = workers.get(n.id);
        if (row) row.name = n.name;
      }
    }

    const list = [...workers.values()].sort((a, b) => b.picks - a.picks || b.received - a.received);
    const ticketSecTotal = ticketRows.reduce((a, t) => a + (t.avgSec === null ? 0 : Number(t.avgSec) * Number(t.count)), 0);
    const ticketsWithTime = ticketRows.reduce((a, t) => a + (t.avgSec === null ? 0 : Number(t.count)), 0);
    const totals: Totals = {
      received: list.reduce((a, r) => a + r.received, 0),
      putaways: list.reduce((a, r) => a + r.putaway, 0),
      graded: list.reduce((a, r) => a + r.graded, 0),
      picks: list.reduce((a, r) => a + r.picks, 0),
      ticketsClosed: list.reduce((a, r) => a + r.tickets, 0),
      avgPickSec: ticketsWithTime > 0 ? Math.round(ticketSecTotal / ticketsWithTime) : null,
    };
    const days = [...byDay.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([d, counts]) => ({ day: d, ...counts }));
    return { totals, workers: list, byDay: days };
  }

  // ── Stats (admin/manager only — stats.view is not seeded to operations) ────

  const statsQuery = z.object({ from: DAY, to: DAY });
  app.get("/api/warehouse/stats", guard("stats.view"), async (req, reply) => {
    const q = statsQuery.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: "invalid_query", detail: "from/to as YYYY-MM-DD" });
    const start = dayStart(q.data.from);
    const end = addDays(dayStart(q.data.to), 1);
    if (end <= start || end.getTime() - start.getTime() > 92 * 86_400_000)
      return reply.code(400).send({ error: "invalid_range", detail: "to must be ≥ from, window ≤ 92 days" });

    const current = await aggregate(start, end);
    // Same-length window immediately before, for the tiles' delta chips.
    const prev = await aggregate(new Date(start.getTime() - (end.getTime() - start.getTime())), start);
    return { from: q.data.from, to: q.data.to, ...current, prev: prev.totals };
  });

  const timelineQuery = z.object({ userId: z.string().uuid(), day: DAY });
  app.get("/api/warehouse/stats/timeline", guard("stats.view"), async (req, reply) => {
    const q = timelineQuery.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: "invalid_query", detail: "userId + day required" });
    const start = dayStart(q.data.day);
    const end = addDays(start, 1);
    const { userId } = q.data;

    const toLoc = warehouseLocations;
    const moveRows = await ctx.db
      .select({ at: stockMovements.createdAt, kind: stockMovements.type, sku: items.sku, itemId: items.id, label: toLoc.label, reason: stockMovements.reason })
      .from(stockMovements)
      .innerJoin(items, eq(stockMovements.itemId, items.id))
      .leftJoin(toLoc, eq(stockMovements.toLocationId, toLoc.id))
      .where(and(eq(stockMovements.actorId, userId), gte(stockMovements.createdAt, start), lt(stockMovements.createdAt, end)))
      .limit(500);

    const pickRows = await ctx.db
      .select({ at: pickupTicketItems.pickedAt, sku: items.sku, itemId: items.id, number: pickupTickets.number })
      .from(pickupTicketItems)
      .innerJoin(items, eq(pickupTicketItems.itemId, items.id))
      .innerJoin(pickupTickets, eq(pickupTicketItems.ticketId, pickupTickets.id))
      .where(and(eq(pickupTicketItems.pickedById, userId), gte(pickupTicketItems.pickedAt, start), lt(pickupTicketItems.pickedAt, end)))
      .limit(500);

    const gradeRows = await ctx.db
      .select({ at: items.gradedAt, sku: items.sku, itemId: items.id, condition: items.condition })
      .from(items)
      .where(and(eq(items.gradedById, userId), gte(items.gradedAt, start), lt(items.gradedAt, end)))
      .limit(500);

    const doneRows = await ctx.db
      .select({
        at: pickupTickets.completedAt,
        number: pickupTickets.number,
        durationSec: sql<string | null>`extract(epoch from (${pickupTickets.completedAt} - ${pickupTickets.pickingStartedAt}))`,
      })
      .from(pickupTickets)
      .where(and(eq(pickupTickets.claimedById, userId), gte(pickupTickets.completedAt, start), lt(pickupTickets.completedAt, end)))
      .limit(200);

    const statusRows = await ctx.db
      .select({ at: auditLog.createdAt, status: auditLog.target })
      .from(auditLog)
      .where(and(eq(auditLog.actorId, userId), eq(auditLog.action, "worker_status"), gte(auditLog.createdAt, start), lt(auditLog.createdAt, end)))
      .limit(200);

    interface Entry {
      at: string;
      kind: string;
      sku?: string | undefined;
      itemId?: string | undefined;
      detail?: string | undefined;
    }
    const entries: Entry[] = [
      ...moveRows.map((m) => ({
        at: m.at.toISOString(),
        kind: m.kind,
        sku: m.sku,
        itemId: m.itemId,
        detail: m.label ?? (m.reason || undefined),
      })),
      ...pickRows.map((p) => ({ at: p.at!.toISOString(), kind: "pick", sku: p.sku, itemId: p.itemId, detail: `#${p.number}` })),
      ...gradeRows.map((g) => ({ at: g.at!.toISOString(), kind: "grade", sku: g.sku, itemId: g.itemId, detail: g.condition })),
      ...doneRows.map((d) => ({
        at: d.at!.toISOString(),
        kind: "ticket_done",
        detail: `#${d.number}` + (d.durationSec !== null ? ` · ${Math.round(Number(d.durationSec) / 60)} min` : ""),
      })),
      ...statusRows.map((s) => ({ at: s.at.toISOString(), kind: "status", detail: s.status })),
    ].sort((a, b) => (a.at < b.at ? -1 : 1));

    const [user] = await ctx.db.select({ name: adminUsers.name }).from(adminUsers).where(eq(adminUsers.id, userId));
    return { userId, day: q.data.day, name: user?.name ?? "?", entries };
  });

  // ── Bin browser (read side open to every warehouse role) ───────────────────

  app.get("/api/warehouse/bins", guard("items.view"), async () => {
    const bins = await ctx.db.select().from(warehouseLocations).orderBy(warehouseLocations.zone, warehouseLocations.label);

    const counts = await ctx.db
      .select({ locationId: items.locationId, count: sql<string>`count(*)` })
      .from(items)
      .where(isNotNull(items.locationId))
      .groupBy(items.locationId);
    const countBy = new Map(counts.map((c) => [c.locationId!, Number(c.count)]));

    // Latest movement touching each bin (in OR out), one row per bin.
    const lastAct = await ctx.db.execute(sql`
      select distinct on (loc_id) loc_id, type, actor_label, created_at from (
        select to_location_id as loc_id, type, actor_label, created_at from stock_movements where to_location_id is not null
        union all
        select from_location_id as loc_id, type, actor_label, created_at from stock_movements where from_location_id is not null
      ) m order by loc_id, created_at desc
    `);
    const actBy = new Map(
      (lastAct.rows as Array<{ loc_id: string; type: string; actor_label: string; created_at: string | Date }>).map((r) => [
        r.loc_id,
        { type: r.type, actorLabel: r.actor_label, at: new Date(r.created_at).toISOString() },
      ]),
    );

    return {
      bins: bins.map((b) => ({
        ...b,
        itemCount: countBy.get(b.id) ?? 0,
        lastActivity: actBy.get(b.id) ?? null,
      })),
    };
  });

  app.get("/api/warehouse/bins/:id", guard("items.view"), async (req, reply) => {
    const { id } = req.params as { id: string };
    const [bin] = await ctx.db.select().from(warehouseLocations).where(eq(warehouseLocations.id, id));
    if (!bin) return reply.code(404).send({ error: "not_found" });

    const contents = await ctx.db
      .select({ id: items.id, sku: items.sku, title: items.title, status: items.status, photos: items.photos, updatedAt: items.updatedAt })
      .from(items)
      .where(eq(items.locationId, id))
      .orderBy(items.sku)
      .limit(500);

    // When each item landed in this bin — its latest inbound movement.
    const arrivals =
      contents.length === 0
        ? []
        : await ctx.db.execute(sql`
            select distinct on (item_id) item_id, created_at from stock_movements
            where to_location_id = ${id} order by item_id, created_at desc
          `);
    const arrivedBy = new Map(
      ((arrivals as { rows?: Array<{ item_id: string; created_at: string | Date }> }).rows ?? []).map((r) => [
        r.item_id,
        new Date(r.created_at).toISOString(),
      ]),
    );

    const activity = await ctx.db
      .select({
        at: stockMovements.createdAt,
        type: stockMovements.type,
        actorLabel: stockMovements.actorLabel,
        sku: items.sku,
        inbound: sql<boolean>`${stockMovements.toLocationId} = ${id}`,
      })
      .from(stockMovements)
      .innerJoin(items, eq(stockMovements.itemId, items.id))
      .where(sql`${stockMovements.toLocationId} = ${id} or ${stockMovements.fromLocationId} = ${id}`)
      .orderBy(desc(stockMovements.createdAt))
      .limit(20);

    return {
      bin,
      contents: contents.map((c) => ({ ...c, sinceAt: arrivedBy.get(c.id) ?? c.updatedAt.toISOString() })),
      activity: activity.map((a) => ({ ...a, at: a.at.toISOString() })),
    };
  });
}
