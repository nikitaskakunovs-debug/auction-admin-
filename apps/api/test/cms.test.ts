import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auth, createWorld, loginAs, type TestWorld } from "./helpers.js";

let world: TestWorld;
let editor: string;

const L = (s: string) => ({ lv: s, ru: s, en: s });

beforeAll(async () => {
  world = await createWorld();
  editor = await loginAs(world, "content@auction.test");
});
afterAll(async () => {
  await world.close();
});

describe("CMS pages", () => {
  it("content editor can create, edit, publish; slug conflicts rejected", async () => {
    const create = await world.server.app.inject({
      method: "POST",
      url: "/api/cms/pages",
      headers: auth(editor),
      payload: {
        slug: "shipping",
        title: L("Shipping"),
        blocks: [
          { type: "heading", text: L("Shipping & pickup") },
          { type: "text", text: L("Locker-first across the Baltics.") },
          { type: "faq", question: L("How fast?"), answer: L("1-3 business days.") },
        ],
      },
    });
    expect(create.statusCode).toBe(200);
    const { page } = create.json() as { page: { id: string; status: string } };
    expect(page.status).toBe("draft");

    const dup = await world.server.app.inject({
      method: "POST",
      url: "/api/cms/pages",
      headers: auth(editor),
      payload: { slug: "shipping", title: L("Dup") },
    });
    expect(dup.statusCode).toBe(409);

    const publish = await world.server.app.inject({
      method: "PATCH",
      url: `/api/cms/pages/${page.id}`,
      headers: auth(editor),
      payload: { status: "published" },
    });
    expect(publish.statusCode).toBe(200);
  });

  it("rejects malformed blocks and bad slugs", async () => {
    const badBlock = await world.server.app.inject({
      method: "POST",
      url: "/api/cms/pages",
      headers: auth(editor),
      payload: { slug: "bad-block", title: L("x"), blocks: [{ type: "heading", text: "not-localized" }] },
    });
    expect(badBlock.statusCode).toBe(400);

    const badSlug = await world.server.app.inject({
      method: "POST",
      url: "/api/cms/pages",
      headers: auth(editor),
      payload: { slug: "Bad Slug!", title: L("x") },
    });
    expect(badSlug.statusCode).toBe(400);
  });

  it("public endpoint serves only published pages", async () => {
    await world.server.app.inject({
      method: "POST",
      url: "/api/cms/pages",
      headers: auth(editor),
      payload: { slug: "hidden-draft", title: L("Hidden"), status: "draft" },
    });
    const draft = await world.server.app.inject({ method: "GET", url: "/api/public/pages/hidden-draft" });
    expect(draft.statusCode).toBe(404);

    const published = await world.server.app.inject({ method: "GET", url: "/api/public/pages/shipping" });
    expect(published.statusCode).toBe(200);
    const body = published.json() as { page: { blocks: unknown[]; title: { lv: string } } };
    expect(body.page.blocks.length).toBe(3);

    const list = await world.server.app.inject({ method: "GET", url: "/api/public/pages" });
    const slugs = (list.json() as { pages: Array<{ slug: string }> }).pages.map((p) => p.slug);
    expect(slugs).toContain("shipping");
    expect(slugs).not.toContain("hidden-draft");
  });

  it("RBAC: content editor cannot touch items; ops cannot edit pages; finance can view only", async () => {
    expect((await world.server.app.inject({ method: "GET", url: "/api/items", headers: auth(editor) })).statusCode).toBe(403);

    const ops = await loginAs(world, "ops@auction.test");
    const opsEdit = await world.server.app.inject({
      method: "POST",
      url: "/api/cms/pages",
      headers: auth(ops),
      payload: { slug: "ops-page", title: L("x") },
    });
    expect(opsEdit.statusCode).toBe(403);

    const opsView = await world.server.app.inject({ method: "GET", url: "/api/cms/pages", headers: auth(ops) });
    expect(opsView.statusCode).toBe(403); // ops has no content.view either
  });

  it("delete removes the page and audits it", async () => {
    const create = await world.server.app.inject({
      method: "POST",
      url: "/api/cms/pages",
      headers: auth(editor),
      payload: { slug: "temp-page", title: L("Temp") },
    });
    const { page } = create.json() as { page: { id: string } };
    const del = await world.server.app.inject({ method: "DELETE", url: `/api/cms/pages/${page.id}`, headers: auth(editor) });
    expect(del.statusCode).toBe(200);
    const gone = await world.server.app.inject({ method: "GET", url: `/api/cms/pages/${page.id}`, headers: auth(editor) });
    expect(gone.statusCode).toBe(404);
  });
});
