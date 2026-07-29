import { adminUsers, auditLog, conditionPresets, items } from "@auction/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auth, createWorld, loginAs, type TestWorld } from "./helpers.js";

/** Phase W2: condition presets + the grading review flow. */

let world: TestWorld;
let superToken: string; // super_admin — everything
let listerToken: string; // listing_manager — grading.review, no settings.edit
let opsToken: string; // operations — items.edit (the grading station), no grading.review
let opsId: string;
let listerId: string;

beforeAll(async () => {
  world = await createWorld();
  superToken = await loginAs(world, "super@auction.test");
  listerToken = await loginAs(world, "listings@auction.test");
  opsToken = await loginAs(world, "ops@auction.test");
  const [listerRow] = await world.ctx.db.select().from(adminUsers).where(eq(adminUsers.email, "listings@auction.test"));
  const [opsRow] = await world.ctx.db.select().from(adminUsers).where(eq(adminUsers.email, "ops@auction.test"));
  listerId = listerRow!.id;
  opsId = opsRow!.id;
});
afterAll(async () => {
  await world.close();
});

const app = () => world.server.app;

async function createItem(extra: Record<string, unknown> = {}): Promise<{ id: string; sku: string }> {
  const sku = `GR-${Math.random().toString(36).slice(2, 9)}`;
  const res = await app().inject({
    method: "POST",
    url: "/api/items",
    headers: auth(superToken),
    payload: { sku, title: `Grading ${sku}`, marketCode: "LV", ...extra },
  });
  expect(res.statusCode).toBe(200);
  return (res.json() as { item: { id: string; sku: string } }).item;
}

async function itemRow(id: string) {
  const [row] = await world.ctx.db.select().from(items).where(eq(items.id, id));
  return row!;
}

/** A seeded preset id for the given condition code. */
async function presetFor(code: string): Promise<{ id: string; textEn: string }> {
  const [row] = await world.ctx.db.select().from(conditionPresets).where(eq(conditionPresets.conditionCode, code));
  expect(row).toBeDefined();
  return { id: row!.id, textEn: row!.textEn };
}

type Preset = { id: string; conditionCode: string; textLv: string; textRu: string; textEn: string; position: number; active: boolean };

describe("condition presets", () => {
  it("are seeded for every condition code and served ordered by (code, position)", async () => {
    const res = await app().inject({ method: "GET", url: "/api/condition-presets", headers: auth(opsToken) });
    expect(res.statusCode).toBe(200);
    const { presets } = res.json() as { presets: Preset[] };
    expect(presets.length).toBeGreaterThan(30);
    for (const code of ["brand_new", "used", "used_with_issue", "as_is_salvage", "new_cosmetic_imperfection"]) {
      expect(presets.filter((p) => p.conditionCode === code).length).toBeGreaterThanOrEqual(3);
    }
    // All three languages populated, active only.
    for (const p of presets) {
      expect(p.textLv.length).toBeGreaterThan(0);
      expect(p.textRu.length).toBeGreaterThan(0);
      expect(p.textEn.length).toBeGreaterThan(0);
      expect(p.active).toBe(true);
    }
    // Ordered by (conditionCode, position).
    const keys = presets.map((p) => `${p.conditionCode}#${String(p.position).padStart(4, "0")}`);
    expect([...keys].sort()).toEqual(keys);
  });

  it("CRUD is reviewer-only (super-admin + listing-manager), delete is a soft retire, everything audited", async () => {
    // Operations can read but not mutate and not see inactive rows.
    const denied = await app().inject({
      method: "POST",
      url: "/api/condition-presets",
      headers: auth(opsToken),
      payload: { conditionCode: "used", textLv: "x", textRu: "x", textEn: "x" },
    });
    expect(denied.statusCode).toBe(403);
    const deniedAll = await app().inject({ method: "GET", url: "/api/condition-presets?all=1", headers: auth(opsToken) });
    expect(deniedAll.statusCode).toBe(403);

    // Unknown condition code refused.
    const badCode = await app().inject({
      method: "POST",
      url: "/api/condition-presets",
      headers: auth(listerToken),
      payload: { conditionCode: "damaged", textLv: "x", textRu: "x", textEn: "x" },
    });
    expect(badCode.statusCode).toBe(400);

    const created = await app().inject({
      method: "POST",
      url: "/api/condition-presets",
      headers: auth(listerToken),
      payload: { conditionCode: "used", textLv: "Nav pults", textRu: "Нет пульта", textEn: "Remote missing", position: 9 },
    });
    expect(created.statusCode).toBe(200);
    const preset = (created.json() as { preset: Preset }).preset;
    expect(preset.active).toBe(true);

    const patched = await app().inject({
      method: "PATCH",
      url: `/api/condition-presets/${preset.id}`,
      headers: auth(listerToken),
      payload: { textEn: "No remote control" },
    });
    expect(patched.statusCode).toBe(200);
    expect((patched.json() as { preset: Preset }).preset.textEn).toBe("No remote control");

    // DELETE only retires the row — items keep referencing the id.
    const deleted = await app().inject({ method: "DELETE", url: `/api/condition-presets/${preset.id}`, headers: auth(listerToken) });
    expect(deleted.statusCode).toBe(200);
    const [dbRow] = await world.ctx.db.select().from(conditionPresets).where(eq(conditionPresets.id, preset.id));
    expect(dbRow).toBeDefined();
    expect(dbRow!.active).toBe(false);

    // Hidden from the worker-facing list, still visible with ?all=1.
    const active = await app().inject({ method: "GET", url: "/api/condition-presets", headers: auth(opsToken) });
    expect((active.json() as { presets: Preset[] }).presets.some((p) => p.id === preset.id)).toBe(false);
    const all = await app().inject({ method: "GET", url: "/api/condition-presets?all=1", headers: auth(listerToken) });
    expect((all.json() as { presets: Preset[] }).presets.some((p) => p.id === preset.id)).toBe(true);

    // Each mutation audited.
    for (const action of ["condition_preset_created", "condition_preset_updated", "condition_preset_deactivated"]) {
      const rows = await world.ctx.db.select().from(auditLog).where(eq(auditLog.action, action));
      expect(rows.length).toBeGreaterThanOrEqual(1);
    }
  });

  it("requires items.view to read at all", async () => {
    const contentToken = await loginAs(world, "content@auction.test");
    const res = await app().inject({ method: "GET", url: "/api/condition-presets", headers: auth(contentToken) });
    expect(res.statusCode).toBe(403);
  });
});

describe("grading on PATCH /api/items/:id", () => {
  it("auto-approves clean grades and stamps the grader", async () => {
    const item = await createItem();
    const res = await app().inject({
      method: "PATCH",
      url: `/api/items/${item.id}`,
      headers: auth(opsToken),
      payload: { condition: "brand_new" },
    });
    expect(res.statusCode).toBe(200);
    const row = await itemRow(item.id);
    expect(row.gradeStatus).toBe("approved");
    expect(row.gradedById).toBe(opsId);
    expect(row.gradedAt).not.toBeNull();
    expect(row.reviewedById).toBeNull();
    expect(row.reviewedAt).toBeNull();

    const audits = await world.ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "graded"), eq(auditLog.target, item.sku)));
    expect(audits).toHaveLength(1);
    expect(audits[0]!.detail).toMatchObject({ condition: "brand_new", gradeStatus: "approved" });
  });

  it("damaged-family grades go to pending_review; preset chips satisfy SEE-NOTES; ids are validated", async () => {
    const item = await createItem();
    const chip = await presetFor("used_with_issue");

    // Unknown preset id → 422.
    const bogus = await app().inject({
      method: "PATCH",
      url: `/api/items/${item.id}`,
      headers: auth(opsToken),
      payload: { condition: "used_with_issue", conditionPresetIds: ["00000000-0000-0000-0000-000000000000"] },
    });
    expect(bogus.statusCode).toBe(422);
    expect((bogus.json() as { error: string }).error).toBe("unknown_preset");

    // SEE-NOTES grade with neither notes nor chips still refused.
    const bare = await app().inject({
      method: "PATCH",
      url: `/api/items/${item.id}`,
      headers: auth(opsToken),
      payload: { condition: "used_with_issue" },
    });
    expect(bare.statusCode).toBe(400);
    expect((bare.json() as { error: string }).error).toBe("condition_notes_required");

    // Chips alone are enough (workers pick, never type).
    const res = await app().inject({
      method: "PATCH",
      url: `/api/items/${item.id}`,
      headers: auth(opsToken),
      payload: { condition: "used_with_issue", conditionPresetIds: [chip.id] },
    });
    expect(res.statusCode).toBe(200);
    const row = await itemRow(item.id);
    expect(row.gradeStatus).toBe("pending_review");
    expect(row.conditionPresetIds).toEqual([chip.id]);
    expect(row.gradedById).toBe(opsId);
  });

  it("excludes pending_review items from the ready-to-list feed and blocks publish with 409", async () => {
    const item = await createItem();
    await app().inject({
      method: "PATCH",
      url: `/api/items/${item.id}`,
      headers: auth(opsToken),
      payload: { condition: "as_is_salvage" },
    });
    expect((await itemRow(item.id)).gradeStatus).toBe("pending_review");

    const ready = await app().inject({ method: "GET", url: "/api/items?status=draft", headers: auth(superToken) });
    expect((ready.json() as { items: Array<{ id: string }> }).items.map((i) => i.id)).not.toContain(item.id);

    const listing = await app().inject({
      method: "POST",
      url: "/api/listings",
      headers: auth(superToken),
      payload: { itemId: item.id, type: "fixed", title: `Pending ${item.sku}`, marketCode: "LV", priceCents: 5_000 },
    });
    const listingId = (listing.json() as { listing: { id: string } }).listing.id;
    const publish = await app().inject({ method: "POST", url: `/api/listings/${listingId}/publish`, headers: auth(superToken) });
    expect(publish.statusCode).toBe(409);
    expect((publish.json() as { error: string }).error).toBe("grade_pending_review");

    // After approval the same item lists normally.
    await app().inject({ method: "POST", url: `/api/grading/${item.id}/approve`, headers: auth(listerToken) });
    const republish = await app().inject({ method: "POST", url: `/api/listings/${listingId}/publish`, headers: auth(superToken) });
    expect(republish.statusCode).toBe(200);
  });

  it("the reviewAll toggle forces review of clean grades (super-admin only writes it)", async () => {
    // listing_manager can read but not write.
    const read = await app().inject({ method: "GET", url: "/api/settings/grading", headers: auth(listerToken) });
    expect(read.statusCode).toBe(200);
    expect((read.json() as { reviewAll: boolean }).reviewAll).toBe(false);
    const deniedPut = await app().inject({
      method: "PUT",
      url: "/api/settings/grading",
      headers: auth(listerToken),
      payload: { reviewAll: true },
    });
    expect(deniedPut.statusCode).toBe(403);

    const put = await app().inject({
      method: "PUT",
      url: "/api/settings/grading",
      headers: auth(superToken),
      payload: { reviewAll: true },
    });
    expect(put.statusCode).toBe(200);

    try {
      const item = await createItem();
      await app().inject({
        method: "PATCH",
        url: `/api/items/${item.id}`,
        headers: auth(opsToken),
        payload: { condition: "brand_new" },
      });
      expect((await itemRow(item.id)).gradeStatus).toBe("pending_review");
    } finally {
      await app().inject({ method: "PUT", url: "/api/settings/grading", headers: auth(superToken), payload: { reviewAll: false } });
    }

    const audits = await world.ctx.db.select().from(auditLog).where(eq(auditLog.action, "grading_review_all"));
    expect(audits.length).toBeGreaterThanOrEqual(2);
  });
});

describe("review queue: approve / edit / reject + worker notices", () => {
  async function pendingItem(): Promise<{ id: string; sku: string }> {
    const item = await createItem();
    const res = await app().inject({
      method: "PATCH",
      url: `/api/items/${item.id}`,
      headers: auth(opsToken),
      payload: { condition: "used_with_issue", conditionNotes: "Deep dent on the left side." },
    });
    expect(res.statusCode).toBe(200);
    return item;
  }

  it("lists pending items with resolved preset texts and the grader name (reviewer-only)", async () => {
    const chip = await presetFor("used_with_issue");
    const item = await createItem();
    await app().inject({
      method: "PATCH",
      url: `/api/items/${item.id}`,
      headers: auth(opsToken),
      payload: { condition: "used_with_issue", conditionPresetIds: [chip.id], conditionNotes: "" },
    });

    const denied = await app().inject({ method: "GET", url: "/api/grading/review", headers: auth(opsToken) });
    expect(denied.statusCode).toBe(403);

    const res = await app().inject({ method: "GET", url: "/api/grading/review", headers: auth(listerToken) });
    expect(res.statusCode).toBe(200);
    const { items: queue } = res.json() as {
      items: Array<{
        id: string;
        sku: string;
        title: string;
        condition: string;
        presets: Array<{ id: string; textEn: string }>;
        graderName: string | null;
        gradedAt: string | null;
        photos: string[];
      }>;
    };
    const entry = queue.find((q) => q.id === item.id)!;
    expect(entry).toBeDefined();
    expect(entry.condition).toBe("used_with_issue");
    expect(entry.presets.map((p) => p.textEn)).toContain(chip.textEn);
    expect(entry.graderName).toBe("Operations");
    expect(entry.gradedAt).toBeTruthy();
  });

  it("approve sets approved + reviewer, audits, and refuses non-pending items", async () => {
    const item = await pendingItem();
    const denied = await app().inject({ method: "POST", url: `/api/grading/${item.id}/approve`, headers: auth(opsToken) });
    expect(denied.statusCode).toBe(403);

    const res = await app().inject({ method: "POST", url: `/api/grading/${item.id}/approve`, headers: auth(listerToken) });
    expect(res.statusCode).toBe(200);
    const row = await itemRow(item.id);
    expect(row.gradeStatus).toBe("approved");
    expect(row.reviewedById).toBe(listerId); // reviewer stamped
    expect(row.reviewedAt).not.toBeNull();
    expect(row.gradeNoticePending).toBe(false); // plain approve = no banner

    const again = await app().inject({ method: "POST", url: `/api/grading/${item.id}/approve`, headers: auth(listerToken) });
    expect(again.statusCode).toBe(409);

    const audit = await world.ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "grade_approved"), eq(auditLog.target, item.sku)));
    expect(audit).toHaveLength(1);
  });

  it("edit applies changes, approves, flags the worker notice, and audits before→after", async () => {
    const item = await pendingItem();
    const res = await app().inject({
      method: "POST",
      url: `/api/grading/${item.id}/edit`,
      headers: auth(listerToken),
      payload: { condition: "used", conditionNotes: "Dent on the left side; fully working." },
    });
    expect(res.statusCode).toBe(200);
    const row = await itemRow(item.id);
    expect(row.gradeStatus).toBe("approved");
    expect(row.condition).toBe("used");
    expect(row.gradeNoticePending).toBe(true);
    expect(row.reviewedAt).not.toBeNull();

    const [audit] = await world.ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "grade_edited"), eq(auditLog.target, item.sku)));
    expect(audit).toBeDefined();
    const detail = audit!.detail as { old: { condition: string; conditionNotes: string }; new: { condition: string } };
    expect(detail.old.condition).toBe("used_with_issue");
    expect(detail.old.conditionNotes).toBe("Deep dent on the left side.");
    expect(detail.new.condition).toBe("used");

    // Empty edit body refused; edit of an already-approved item is a 409.
    const empty = await app().inject({ method: "POST", url: `/api/grading/${item.id}/edit`, headers: auth(listerToken), payload: {} });
    expect(empty.statusCode).toBe(400);
    const notPending = await app().inject({
      method: "POST",
      url: `/api/grading/${item.id}/edit`,
      headers: auth(listerToken),
      payload: { condition: "brand_new" },
    });
    expect(notPending.statusCode).toBe(409);
  });

  it("reject demands a reason, marks rejected + notice, and a re-grade goes back through the rules", async () => {
    const item = await pendingItem();
    const noReason = await app().inject({
      method: "POST",
      url: `/api/grading/${item.id}/reject`,
      headers: auth(listerToken),
      payload: { reason: "  " },
    });
    expect(noReason.statusCode).toBe(400);

    const res = await app().inject({
      method: "POST",
      url: `/api/grading/${item.id}/reject`,
      headers: auth(listerToken),
      payload: { reason: "Photos don't match the grade — re-check." },
    });
    expect(res.statusCode).toBe(200);
    const row = await itemRow(item.id);
    expect(row.gradeStatus).toBe("rejected");
    expect(row.gradeRejectReason).toBe("Photos don't match the grade — re-check.");
    expect(row.gradeNoticePending).toBe(true);

    const audit = await world.ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "grade_rejected"), eq(auditLog.target, item.sku)));
    expect(audit).toHaveLength(1);

    // Re-grading the rejected item clears the rejection and re-runs the rules.
    const regrade = await app().inject({
      method: "PATCH",
      url: `/api/items/${item.id}`,
      headers: auth(opsToken),
      payload: { condition: "refurbished" },
    });
    expect(regrade.statusCode).toBe(200);
    const after = await itemRow(item.id);
    expect(after.gradeStatus).toBe("approved");
    expect(after.gradeRejectReason).toBeNull();
    expect(after.gradeNoticePending).toBe(false);
    expect(after.reviewedById).toBeNull();
  });

  it("notices show edits (old→new) and rejects to the grader; only the grader can ack", async () => {
    const edited = await pendingItem();
    const rejected = await pendingItem();
    await app().inject({
      method: "POST",
      url: `/api/grading/${edited.id}/edit`,
      headers: auth(listerToken),
      payload: { condition: "lightly_used", conditionNotes: "Actually only light scuffs." },
    });
    await app().inject({
      method: "POST",
      url: `/api/grading/${rejected.id}/reject`,
      headers: auth(listerToken),
      payload: { reason: "Wrong item photographed." },
    });

    // The reviewer has no notices — they belong to the grader (ops).
    const forLister = await app().inject({ method: "GET", url: "/api/grading/notices", headers: auth(listerToken) });
    type Notice = {
      itemId: string;
      sku: string;
      kind: "edited" | "rejected";
      rejectReason: string | null;
      oldCondition: string | null;
      newCondition: string | null;
      reviewerName: string | null;
      reviewedAt: string | null;
    };
    expect(
      (forLister.json() as { notices: Notice[] }).notices.some((n) => n.itemId === edited.id || n.itemId === rejected.id),
    ).toBe(false);

    const res = await app().inject({ method: "GET", url: "/api/grading/notices", headers: auth(opsToken) });
    expect(res.statusCode).toBe(200);
    const { notices } = res.json() as { notices: Notice[] };
    const editNotice = notices.find((n) => n.itemId === edited.id)!;
    expect(editNotice.kind).toBe("edited");
    expect(editNotice.oldCondition).toBe("used_with_issue");
    expect(editNotice.newCondition).toBe("lightly_used");
    expect(editNotice.reviewerName).toBe("Listing Manager");
    expect(editNotice.reviewedAt).toBeTruthy();
    const rejectNotice = notices.find((n) => n.itemId === rejected.id)!;
    expect(rejectNotice.kind).toBe("rejected");
    expect(rejectNotice.rejectReason).toBe("Wrong item photographed.");

    // Someone else (even super-admin) cannot ack the grader's banner.
    const deniedAck = await app().inject({ method: "POST", url: `/api/grading/${edited.id}/notice-ack`, headers: auth(superToken) });
    expect(deniedAck.statusCode).toBe(403);

    for (const id of [edited.id, rejected.id]) {
      const ack = await app().inject({ method: "POST", url: `/api/grading/${id}/notice-ack`, headers: auth(opsToken) });
      expect(ack.statusCode).toBe(200);
    }
    const after = await app().inject({ method: "GET", url: "/api/grading/notices", headers: auth(opsToken) });
    expect(
      (after.json() as { notices: Notice[] }).notices.some((n) => n.itemId === edited.id || n.itemId === rejected.id),
    ).toBe(false);
  });
});

describe("grading admin events", () => {
  it("publishes grade_review_pending / grade_edited / grade_rejected on the admin channel", async () => {
    const { Redis } = await import("ioredis");
    const sub = new Redis(world.ctx.config.redisUrl);
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    await sub.subscribe("admin:events");
    sub.on("message", (_ch, msg) => events.push(JSON.parse(msg) as { type: string; data: Record<string, unknown> }));

    try {
      const item = await createItem();
      await app().inject({
        method: "PATCH",
        url: `/api/items/${item.id}`,
        headers: auth(opsToken),
        payload: { condition: "used_with_issue", conditionNotes: "Chipped corner." },
      });
      await app().inject({
        method: "POST",
        url: `/api/grading/${item.id}/reject`,
        headers: auth(listerToken),
        payload: { reason: "Needs better photos." },
      });
      await app().inject({
        method: "PATCH",
        url: `/api/items/${item.id}`,
        headers: auth(opsToken),
        payload: { condition: "used", conditionNotes: "Chipped corner, otherwise fine." },
      });
      await app().inject({
        method: "POST",
        url: `/api/grading/${item.id}/edit`,
        headers: auth(listerToken),
        payload: { condition: "lightly_used" },
      });

      const deadline = Date.now() + 2_000;
      const want = ["grade_review_pending", "grade_rejected", "grade_edited"];
      while (Date.now() < deadline && !want.every((t) => events.some((e) => e.type === t))) {
        await new Promise((r) => setTimeout(r, 25));
      }
      for (const type of want) {
        const ev = events.find((e) => e.type === type)!;
        expect(ev).toBeDefined();
        expect(ev.data).toMatchObject({ itemId: item.id, sku: item.sku });
      }
    } finally {
      await sub.quit().catch(() => undefined);
    }
  });
});
