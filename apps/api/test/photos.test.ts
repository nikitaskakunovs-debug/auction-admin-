import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auth, createWorld, loginAs, type TestWorld } from "./helpers.js";

let world: TestWorld;
let listerToken: string;
let contentToken: string;

beforeAll(async () => {
  world = await createWorld();
  listerToken = await loginAs(world, "listings@auction.test");
  contentToken = await loginAs(world, "content@auction.test");
});
afterAll(async () => {
  await world.close();
});

/** 1×1 red PNG — enough for sharp to decode and re-encode. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function multipartBody(files: Array<{ filename: string; contentType: string; data: Buffer }>): {
  payload: Buffer;
  headers: Record<string, string>;
} {
  const boundary = "----photo-test-boundary";
  const parts: Buffer[] = [];
  for (const f of files) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\n` +
          `content-disposition: form-data; name="photos"; filename="${f.filename}"\r\n` +
          `content-type: ${f.contentType}\r\n\r\n`,
      ),
    );
    parts.push(f.data, Buffer.from("\r\n"));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    payload: Buffer.concat(parts),
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
  };
}

async function createItem(): Promise<string> {
  const sku = `PH-${Math.random().toString(36).slice(2, 9)}`;
  const res = await world.server.app.inject({
    method: "POST",
    url: "/api/items",
    headers: auth(listerToken),
    payload: { sku, title: `Photo ${sku}`, marketCode: "LV" },
  });
  expect(res.statusCode).toBe(200);
  return (res.json() as { item: { id: string } }).item.id;
}

const pathOf = (url: string) => new URL(url).pathname;

describe("item photos", () => {
  it("uploads, re-encodes to web+thumb webp, serves the files, and exposes URLs publicly", async () => {
    const app = world.server.app;
    const itemId = await createItem();

    const body = multipartBody([
      { filename: "front.png", contentType: "image/png", data: PNG },
      { filename: "back.png", contentType: "image/png", data: PNG },
    ]);
    const up = await app.inject({
      method: "POST",
      url: `/api/items/${itemId}/photos`,
      headers: { ...auth(listerToken), ...body.headers },
      payload: body.payload,
    });
    expect(up.statusCode).toBe(200);
    const { item } = up.json() as { item: { photos: string[] } };
    expect(item.photos).toHaveLength(2);
    for (const url of item.photos) {
      expect(url).toMatch(new RegExp(`/uploads/items/${itemId}/[0-9a-f-]+-web\\.webp$`));
      const web = await app.inject({ method: "GET", url: pathOf(url) });
      expect(web.statusCode).toBe(200);
      expect(web.headers["content-type"]).toContain("image/webp");
      const thumb = await app.inject({ method: "GET", url: pathOf(url).replace("-web.webp", "-thumb.webp") });
      expect(thumb.statusCode).toBe(200);
    }

    // Photos ride into the public payload once the item is listed.
    const listing = await app.inject({
      method: "POST",
      url: "/api/listings",
      headers: auth(listerToken),
      payload: { itemId, type: "fixed", title: "With photos", marketCode: "LV", priceCents: 5_000, quantity: 1 },
    });
    const listingId = (listing.json() as { listing: { id: string } }).listing.id;
    await app.inject({ method: "POST", url: `/api/listings/${listingId}/publish`, headers: auth(listerToken) });
    const pub = await app.inject({ method: "GET", url: `/api/public/listings/${listingId}` });
    expect(pub.statusCode).toBe(200);
    expect((pub.json() as { listing: { photos: string[] } }).listing.photos).toHaveLength(2);
  });

  it("sets a cover (moves to front) and deletes photos including the stored files", async () => {
    const app = world.server.app;
    const itemId = await createItem();
    const body = multipartBody([
      { filename: "a.png", contentType: "image/png", data: PNG },
      { filename: "b.png", contentType: "image/png", data: PNG },
    ]);
    const up = await app.inject({
      method: "POST",
      url: `/api/items/${itemId}/photos`,
      headers: { ...auth(listerToken), ...body.headers },
      payload: body.payload,
    });
    const photos = (up.json() as { item: { photos: string[] } }).item.photos;
    const [first, second] = photos as [string, string];

    const cover = await app.inject({
      method: "POST",
      url: `/api/items/${itemId}/photos/cover`,
      headers: auth(listerToken),
      payload: { url: second },
    });
    expect(cover.statusCode).toBe(200);
    expect((cover.json() as { item: { photos: string[] } }).item.photos).toEqual([second, first]);

    const del = await app.inject({
      method: "DELETE",
      url: `/api/items/${itemId}/photos`,
      headers: auth(listerToken),
      payload: { url: second },
    });
    expect(del.statusCode).toBe(200);
    expect((del.json() as { item: { photos: string[] } }).item.photos).toEqual([first]);
    // The stored objects are gone (web + derived thumb).
    expect((await app.inject({ method: "GET", url: pathOf(second) })).statusCode).toBe(404);
    expect(
      (await app.inject({ method: "GET", url: pathOf(second).replace("-web.webp", "-thumb.webp") })).statusCode,
    ).toBe(404);

    // Deleting a URL the item does not have is a 404, not a silent no-op.
    const again = await app.inject({
      method: "DELETE",
      url: `/api/items/${itemId}/photos`,
      headers: auth(listerToken),
      payload: { url: second },
    });
    expect(again.statusCode).toBe(404);
  });

  it("rejects non-image types and corrupt image data", async () => {
    const app = world.server.app;
    const itemId = await createItem();

    const text = multipartBody([{ filename: "notes.txt", contentType: "text/plain", data: Buffer.from("hello") }]);
    const r1 = await app.inject({
      method: "POST",
      url: `/api/items/${itemId}/photos`,
      headers: { ...auth(listerToken), ...text.headers },
      payload: text.payload,
    });
    expect(r1.statusCode).toBe(400);
    expect((r1.json() as { error: string }).error).toBe("unsupported_image_type");

    const corrupt = multipartBody([{ filename: "x.png", contentType: "image/png", data: Buffer.from("not a png") }]);
    const r2 = await app.inject({
      method: "POST",
      url: `/api/items/${itemId}/photos`,
      headers: { ...auth(listerToken), ...corrupt.headers },
      payload: corrupt.payload,
    });
    expect(r2.statusCode).toBe(400);
    expect((r2.json() as { error: string }).error).toBe("invalid_image");

    const [row] = await app
      .inject({ method: "GET", url: `/api/items/${itemId}`, headers: auth(listerToken) })
      .then((r) => [r.json() as { item: { photos: string[] } }]);
    expect(row!.item.photos).toHaveLength(0);
  });

  it("requires items.edit (content editor is refused)", async () => {
    const app = world.server.app;
    const itemId = await createItem();
    const body = multipartBody([{ filename: "a.png", contentType: "image/png", data: PNG }]);
    const res = await app.inject({
      method: "POST",
      url: `/api/items/${itemId}/photos`,
      headers: { ...auth(contentToken), ...body.headers },
      payload: body.payload,
    });
    expect(res.statusCode).toBe(403);
  });
});
