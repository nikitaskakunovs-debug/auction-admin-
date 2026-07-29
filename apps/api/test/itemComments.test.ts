import { itemComments } from "@auction/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auth, createWorld, loginAs, type TestWorld } from "./helpers.js";

/** Phase W2: per-item comment threads + read cursors + unread badges. */

let world: TestWorld;
let superToken: string;
let opsToken: string;

beforeAll(async () => {
  world = await createWorld();
  superToken = await loginAs(world, "super@auction.test");
  opsToken = await loginAs(world, "ops@auction.test");
});
afterAll(async () => {
  await world.close();
});

const app = () => world.server.app;

async function createItem(): Promise<{ id: string; sku: string }> {
  const sku = `CM-${Math.random().toString(36).slice(2, 9)}`;
  const res = await app().inject({
    method: "POST",
    url: "/api/items",
    headers: auth(superToken),
    payload: { sku, title: `Comments ${sku}`, marketCode: "LV" },
  });
  expect(res.statusCode).toBe(200);
  return (res.json() as { item: { id: string; sku: string } }).item;
}

type Comment = { id: string; userId: string | null; authorLabel: string; body: string; createdAt: string };
type Thread = { comments: Comment[]; lastReadAt: string | null };
type Unread = { unread: Array<{ itemId: string; sku: string; count: number }> };

async function unreadFor(token: string): Promise<Unread["unread"]> {
  const res = await app().inject({ method: "GET", url: "/api/comments/unread", headers: auth(token) });
  expect(res.statusCode).toBe(200);
  return (res.json() as Unread).unread;
}

describe("item comment threads", () => {
  it("posts trimmed comments with the author label, lists them chronologically, publishes an event", async () => {
    const { Redis } = await import("ioredis");
    const sub = new Redis(world.ctx.config.redisUrl);
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    await sub.subscribe("admin:events");
    sub.on("message", (_ch, msg) => events.push(JSON.parse(msg) as { type: string; data: Record<string, unknown> }));

    try {
      const item = await createItem();

      const first = await app().inject({
        method: "POST",
        url: `/api/items/${item.id}/comments`,
        headers: auth(opsToken),
        payload: { body: "  Box was already open at intake.  " },
      });
      expect(first.statusCode).toBe(200);
      expect((first.json() as { comment: Comment }).comment.body).toBe("Box was already open at intake.");
      expect((first.json() as { comment: Comment }).comment.authorLabel).toBe("Operations");

      const second = await app().inject({
        method: "POST",
        url: `/api/items/${item.id}/comments`,
        headers: auth(superToken),
        payload: { body: "Noted — photograph the seal damage please." },
      });
      expect(second.statusCode).toBe(200);

      const res = await app().inject({ method: "GET", url: `/api/items/${item.id}/comments`, headers: auth(opsToken) });
      expect(res.statusCode).toBe(200);
      const thread = res.json() as Thread;
      expect(thread.comments).toHaveLength(2);
      expect(thread.comments[0]!.authorLabel).toBe("Operations"); // chronological
      expect(thread.comments[1]!.authorLabel).toBe("Super Admin");
      expect(thread.comments[0]!.createdAt <= thread.comments[1]!.createdAt).toBe(true);
      // Posting upserted the poster's own read cursor.
      expect(thread.lastReadAt).not.toBeNull();

      // Event carries itemId + sku (pickup_checkin envelope shape).
      const deadline = Date.now() + 2_000;
      while (Date.now() < deadline && !events.some((e) => e.type === "item_comment")) {
        await new Promise((r) => setTimeout(r, 25));
      }
      const ev = events.find((e) => e.type === "item_comment")!;
      expect(ev).toBeDefined();
      expect(ev.data).toMatchObject({ itemId: item.id, sku: item.sku });
    } finally {
      await sub.quit().catch(() => undefined);
    }
  });

  it("rejects empty / oversized bodies and unknown items", async () => {
    const item = await createItem();
    const empty = await app().inject({
      method: "POST",
      url: `/api/items/${item.id}/comments`,
      headers: auth(opsToken),
      payload: { body: "   " },
    });
    expect(empty.statusCode).toBe(400);
    const oversized = await app().inject({
      method: "POST",
      url: `/api/items/${item.id}/comments`,
      headers: auth(opsToken),
      payload: { body: "x".repeat(2001) },
    });
    expect(oversized.statusCode).toBe(400);
    expect(await world.ctx.db.select().from(itemComments).where(eq(itemComments.itemId, item.id))).toHaveLength(0);

    const missing = await app().inject({
      method: "POST",
      url: "/api/items/00000000-0000-0000-0000-000000000000/comments",
      headers: auth(opsToken),
      payload: { body: "hello" },
    });
    expect(missing.statusCode).toBe(404);
    const missingList = await app().inject({
      method: "GET",
      url: "/api/items/00000000-0000-0000-0000-000000000000/comments",
      headers: auth(opsToken),
    });
    expect(missingList.statusCode).toBe(404);
  });

  it("requires items.view (content editor refused)", async () => {
    const contentToken = await loginAs(world, "content@auction.test");
    const item = await createItem();
    const post = await app().inject({
      method: "POST",
      url: `/api/items/${item.id}/comments`,
      headers: auth(contentToken),
      payload: { body: "nope" },
    });
    expect(post.statusCode).toBe(403);
    const unread = await app().inject({ method: "GET", url: "/api/comments/unread", headers: auth(contentToken) });
    expect(unread.statusCode).toBe(403);
  });
});

describe("read cursors + unread badges", () => {
  it("counts comments newer than my cursor, never my own, and drops after marking read", async () => {
    const item = await createItem();

    // Ops posts twice — super has never read the thread.
    for (const body of ["Shrink wrap torn.", "Manual missing too."]) {
      const res = await app().inject({
        method: "POST",
        url: `/api/items/${item.id}/comments`,
        headers: auth(opsToken),
        payload: { body },
      });
      expect(res.statusCode).toBe(200);
    }

    const forSuper = await unreadFor(superToken);
    const badge = forSuper.find((u) => u.itemId === item.id)!;
    expect(badge).toBeDefined();
    expect(badge.sku).toBe(item.sku);
    expect(badge.count).toBe(2);

    // The poster's own comments are behind their auto-advanced cursor.
    expect((await unreadFor(opsToken)).find((u) => u.itemId === item.id)).toBeUndefined();

    // Super marks the thread read → the badge disappears…
    const read = await app().inject({ method: "POST", url: `/api/items/${item.id}/comments/read`, headers: auth(superToken) });
    expect(read.statusCode).toBe(200);
    expect((read.json() as { lastReadAt: string }).lastReadAt).toBeTruthy();
    expect((await unreadFor(superToken)).find((u) => u.itemId === item.id)).toBeUndefined();

    // …and the thread now reports the cursor.
    const thread = await app().inject({ method: "GET", url: `/api/items/${item.id}/comments`, headers: auth(superToken) });
    expect((thread.json() as Thread).lastReadAt).not.toBeNull();

    // A fresh reply makes exactly the new comment unread again.
    const reply = await app().inject({
      method: "POST",
      url: `/api/items/${item.id}/comments`,
      headers: auth(opsToken),
      payload: { body: "Also: no power cable." },
    });
    expect(reply.statusCode).toBe(200);
    const after = (await unreadFor(superToken)).find((u) => u.itemId === item.id)!;
    expect(after.count).toBe(1);
  });

  it("ignores threads with no comments in the last 30 days", async () => {
    const item = await createItem();
    await app().inject({
      method: "POST",
      url: `/api/items/${item.id}/comments`,
      headers: auth(opsToken),
      payload: { body: "Old note from last quarter." },
    });
    // Age the comment past the 30-day badge window.
    await world.ctx.db
      .update(itemComments)
      .set({ createdAt: new Date(Date.now() - 31 * 86_400_000) })
      .where(eq(itemComments.itemId, item.id));
    expect((await unreadFor(superToken)).find((u) => u.itemId === item.id)).toBeUndefined();
  });
});
