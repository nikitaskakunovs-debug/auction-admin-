import { consignments, counters, items, stockMovements, warehouseLocations } from "@auction/db";
import {
  conditionByCode,
  conditionRequiresNotes,
  formatConsignmentRef,
  formatSku,
} from "@auction/domain";
import { and, desc, eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import QRCode from "qrcode";
import { z } from "zod";
import { writeAudit } from "../audit.js";
import type { AppContext } from "../context.js";
import { requirePermission, type PermissionService } from "../auth/rbac.js";

const actor = (req: { admin?: { sub: string; name: string } }) => ({
  id: req.admin?.sub ?? null,
  label: req.admin?.name ?? "Unknown",
});

/** Next value of a named counter under the row lock (invoice/ticket pattern). */
async function nextCounter(tx: Pick<AppContext["db"], "update" | "insert">, key: string): Promise<number> {
  await tx.insert(counters).values({ key, value: 0 }).onConflictDoNothing();
  const [row] = await tx
    .update(counters)
    .set({ value: sql`${counters.value} + 1` })
    .where(eq(counters.key, key))
    .returning({ value: counters.value });
  return row!.value;
}

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** One 57×32mm-ish thermal label. QR payload = item id (uuid) — stable even
 * if the SKU is ever re-stickered; /api/items/lookup resolves both. */
async function itemLabelHtml(item: { id: string; sku: string; title: string; condition: string }): Promise<string> {
  const qr = await QRCode.toString(item.id, { type: "svg", margin: 0, errorCorrectionLevel: "M" });
  const grade = conditionByCode(item.condition)?.label ?? item.condition;
  return `<div class="label">
  <div class="qr">${qr}</div>
  <div class="txt">
    <div class="sku">${esc(item.sku)}</div>
    <div class="title">${esc(item.title.slice(0, 60))}</div>
    <div class="cond">${esc(grade)}</div>
  </div>
</div>`;
}

function labelPage(bodyHtml: string, title: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>
  @page { size: 57mm 32mm; margin: 2mm; }
  * { box-sizing: border-box; margin: 0; }
  body { font-family: system-ui, sans-serif; }
  .label { width: 53mm; height: 28mm; display: flex; gap: 2.5mm; align-items: center; page-break-after: always; overflow: hidden; }
  .qr { width: 24mm; height: 24mm; flex: none; }
  .qr svg { width: 100%; height: 100%; }
  .txt { min-width: 0; }
  .sku { font-size: 13pt; font-weight: 800; font-family: ui-monospace, monospace; }
  .title { font-size: 7pt; line-height: 1.25; margin-top: 1mm; }
  .cond { font-size: 6.5pt; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; margin-top: 1mm; }
  @media screen { body { background: #eee; padding: 12px; } .label { background: #fff; padding: 2mm; margin-bottom: 8px; box-shadow: 0 1px 4px rgba(0,0,0,0.2); } }
</style></head><body>${bodyHtml}<script>window.print()</script></body></html>`;
}

export function registerReceivingRoutes(app: FastifyInstance, ctx: AppContext, perms: PermissionService): void {
  const guard = (p: Parameters<typeof requirePermission>[1]) => ({ preHandler: requirePermission(perms, p) });

  // ── Consignments ───────────────────────────────────────────────────────────

  const consignmentBody = z.object({
    supplier: z.string().min(2).max(120),
    marketCode: z.string().length(2),
    notes: z.string().max(2000).default(""),
    expectedCount: z.number().int().min(0).default(0),
  });

  app.post("/api/consignments", guard("warehouse.manage"), async (req, reply) => {
    const body = consignmentBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body", detail: body.error.flatten() });
    const row = await ctx.db.transaction(async (tx) => {
      const ref = formatConsignmentRef(await nextCounter(tx, "consignment_ref"));
      const [created] = await tx
        .insert(consignments)
        .values({ ...body.data, marketCode: body.data.marketCode.toUpperCase(), ref, createdById: req.admin!.sub })
        .returning();
      await writeAudit(tx, actor(req), "item", "consignment_created", ref, { supplier: body.data.supplier });
      return created;
    });
    return { consignment: row };
  });

  app.get("/api/consignments", guard("items.view"), async (req) => {
    const q = req.query as { status?: string };
    // Join + group-by (not a raw correlated subquery: drizzle renders sql``
    // column refs unqualified, so the inner "id" would bind to items.id).
    const rows = await ctx.db
      .select({ consignment: consignments, receivedCount: sql<string>`count(${items.id})` })
      .from(consignments)
      .leftJoin(items, eq(items.consignmentId, consignments.id))
      .where(q.status ? eq(consignments.status, q.status) : undefined)
      .groupBy(consignments.id)
      .orderBy(desc(consignments.createdAt))
      .limit(200);
    return { consignments: rows.map((r) => ({ ...r.consignment, receivedCount: Number(r.receivedCount) })) };
  });

  app.get("/api/consignments/:id", guard("items.view"), async (req, reply) => {
    const { id } = req.params as { id: string };
    const [row] = await ctx.db.select().from(consignments).where(eq(consignments.id, id));
    if (!row) return reply.code(404).send({ error: "not_found" });
    const itemRows = await ctx.db
      .select()
      .from(items)
      .where(eq(items.consignmentId, id))
      .orderBy(desc(items.createdAt))
      .limit(500);
    return { consignment: row, items: itemRows };
  });

  app.post("/api/consignments/:id/close", guard("warehouse.manage"), async (req, reply) => {
    const { id } = req.params as { id: string };
    const [row] = await ctx.db
      .update(consignments)
      .set({ status: "closed", closedAt: ctx.now() })
      .where(and(eq(consignments.id, id), eq(consignments.status, "open")))
      .returning();
    if (!row) return reply.code(409).send({ error: "not_open" });
    await writeAudit(ctx.db, actor(req), "item", "consignment_closed", row.ref);
    return { consignment: row };
  });

  // ── Receive one unit (intake station's rapid-entry endpoint) ───────────────

  const receiveBody = z.object({
    title: z.string().min(2),
    condition: z.string().default("brand_new"),
    conditionNotes: z.string().default(""),
    description: z.string().default(""),
    weightGrams: z.number().int().positive().nullable().optional(),
  });

  app.post("/api/consignments/:id/receive", guard("warehouse.manage"), async (req, reply) => {
    const body = receiveBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body", detail: body.error.flatten() });
    if (conditionRequiresNotes(body.data.condition) && body.data.conditionNotes.trim().length < 3)
      return reply.code(400).send({ error: "condition_notes_required", detail: "This condition grade is a SEE NOTES grade — describe the issue." });
    const { id } = req.params as { id: string };

    const result = await ctx.db.transaction(async (tx) => {
      const [con] = await tx.select().from(consignments).where(eq(consignments.id, id)).for("update");
      if (!con) return null;
      if (con.status !== "open") return "closed" as const;
      const sku = formatSku(await nextCounter(tx, "sku"));
      const [item] = await tx
        .insert(items)
        .values({
          sku,
          title: body.data.title,
          description: body.data.description,
          condition: body.data.condition,
          conditionNotes: body.data.conditionNotes,
          weightGrams: body.data.weightGrams ?? null,
          marketCode: con.marketCode,
          consignmentId: con.id,
          status: "draft",
        })
        .returning();
      await tx.insert(stockMovements).values({
        itemId: item!.id,
        type: "intake",
        actorId: req.admin!.sub,
        actorLabel: req.admin!.name,
        reason: `received with ${con.ref} (${con.supplier})`,
      });
      await writeAudit(tx, actor(req), "item", "received", sku, { consignment: con.ref });
      return item;
    });
    if (result === null) return reply.code(404).send({ error: "not_found" });
    if (result === "closed") return reply.code(409).send({ error: "consignment_closed" });
    return { item: result };
  });

  // ── Scan lookup (QR = item uuid, or a typed/scanned SKU) ───────────────────

  app.get("/api/items/lookup", guard("items.view"), async (req, reply) => {
    const code = ((req.query as { code?: string }).code ?? "").trim();
    if (code.length < 3) return reply.code(400).send({ error: "code_required" });
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(code);
    const [row] = await ctx.db
      .select({ item: items, binLabel: warehouseLocations.label, consignmentRef: consignments.ref })
      .from(items)
      .leftJoin(warehouseLocations, eq(items.locationId, warehouseLocations.id))
      .leftJoin(consignments, eq(items.consignmentId, consignments.id))
      .where(isUuid ? eq(items.id, code.toLowerCase()) : sql`upper(${items.sku}) = ${code.toUpperCase()}`)
      .limit(1);
    if (!row) return reply.code(404).send({ error: "not_found" });
    return { item: row.item, binLabel: row.binLabel, consignmentRef: row.consignmentRef };
  });

  // ── Printable labels (admin fetches the HTML with its bearer token and
  //    writes it into a print window) ─────────────────────────────────────────

  app.get("/api/items/:id/label", guard("items.view"), async (req, reply) => {
    const { id } = req.params as { id: string };
    const [item] = await ctx.db.select().from(items).where(eq(items.id, id));
    if (!item) return reply.code(404).send({ error: "not_found" });
    const html = labelPage(await itemLabelHtml(item), `Label ${item.sku}`);
    return reply.type("text/html; charset=utf-8").send(html);
  });

  app.get("/api/consignments/:id/labels", guard("items.view"), async (req, reply) => {
    const { id } = req.params as { id: string };
    const [con] = await ctx.db.select().from(consignments).where(eq(consignments.id, id));
    if (!con) return reply.code(404).send({ error: "not_found" });
    const rows = await ctx.db.select().from(items).where(eq(items.consignmentId, id)).orderBy(items.sku).limit(500);
    const labels = await Promise.all(rows.map(itemLabelHtml));
    const html = labelPage(labels.join("\n"), `Labels ${con.ref}`);
    return reply.type("text/html; charset=utf-8").send(html);
  });

  /** Bin labels — the whole rack plan on one print run. */
  app.get("/api/warehouse/locations/labels", guard("warehouse.manage"), async (_req, reply) => {
    const bins = await ctx.db
      .select()
      .from(warehouseLocations)
      .where(eq(warehouseLocations.active, true))
      .orderBy(warehouseLocations.label)
      .limit(1000);
    const labels = await Promise.all(
      bins.map(async (b) => {
        const qr = await QRCode.toString(`BIN:${b.id}`, { type: "svg", margin: 0, errorCorrectionLevel: "M" });
        return `<div class="label"><div class="qr">${qr}</div><div class="txt"><div class="sku">${esc(b.label)}</div><div class="cond">${esc(b.zone)}</div></div></div>`;
      }),
    );
    const html = labelPage(labels.join("\n"), "Bin labels");
    return reply.type("text/html; charset=utf-8").send(html);
  });
}
