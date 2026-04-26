import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import type { Database } from "bun:sqlite";
import { ImageService, buildImageAssetIndex, syncFeedImageUsages } from "../images";
import { cleanupTestDB, createTestUser, setupTestApp, type TestContext } from "../../../tests/fixtures";

describe("ImageService", () => {
  let context: TestContext;
  let sqlite: Database;
  let deletedKeys: string[];

  beforeEach(async () => {
    deletedKeys = [];
    context = await setupTestApp(() => ImageService(), {
      R2_BUCKET: {
        list: async () => ({
          objects: [
            {
              key: "images/orphan.png",
              size: 50,
              uploaded: new Date("2025-01-01T00:00:00Z"),
            },
          ],
          truncated: false,
          cursor: undefined,
        }),
        head: async (key: string) => ({
          key,
          size: key.endsWith("orphan.png") ? 50 : 100,
          uploaded: new Date("2025-01-01T00:00:00Z"),
          httpMetadata: { contentType: "image/png" },
          writeHttpMetadata(headers: Headers) {
            headers.set("Content-Type", "image/png");
          },
        }),
        delete: async (key: string) => {
          deletedKeys.push(key);
        },
      } as any,
      S3_ACCESS_HOST: "https://images.example.com" as any,
      S3_ENDPOINT: "" as any,
      S3_BUCKET: "" as any,
      S3_ACCESS_KEY_ID: "",
      S3_SECRET_ACCESS_KEY: "",
    });
    sqlite = context.sqlite;
    createTestUser(sqlite);
  });

  afterEach(() => {
    cleanupTestDB(sqlite);
  });

  function adminHeaders() {
    return {
      Authorization: "Bearer mock_token_1",
    };
  }

  it("builds an index from article images and storage orphan images", async () => {
    sqlite.exec(`
      INSERT INTO feeds (id, title, content, uid, draft, listed)
      VALUES (1, 'Post', '![hero](https://images.example.com/images/hero.png#width=640&height=360)', 1, 0, 1)
    `);

    const result = await buildImageAssetIndex(context.db, context.env, "https://site.example.com");

    expect(result.articleImages).toBe(1);
    expect(result.storageImages).toBe(1);
    expect(result.unused).toBe(1);

    const assets = sqlite.prepare("SELECT storage_key, width, height FROM image_assets ORDER BY storage_key").all() as any[];
    expect(assets.map((asset) => asset.storage_key)).toEqual(["images/hero.png", "images/orphan.png"]);
    expect(assets[0].width).toBe(640);
    expect(assets[0].height).toBe(360);
  });

  it("filters unused images and reports storage size stats", async () => {
    sqlite.exec(`
      INSERT INTO feeds (id, title, content, uid, draft, listed)
      VALUES (1, 'Post', '![hero](https://images.example.com/images/hero.png)', 1, 0, 1)
    `);
    await syncFeedImageUsages(context.db, context.env, 1, "![hero](https://images.example.com/images/hero.png)", "https://site.example.com");
    sqlite.exec(`
      INSERT INTO image_assets (id, url, storage_key, source, filename, content_type, size)
      VALUES (20, 'https://images.example.com/images/free.png', 'images/free.png', 'storage', 'free.png', 'image/png', 25)
    `);

    const list = await context.app.request("/?usage=unused", { headers: adminHeaders() }, context.env);
    const payload = await list.json() as any;
    expect(payload.size).toBe(1);
    expect(payload.data[0].filename).toBe("free.png");

    const stats = await context.app.request("/stats", { headers: adminHeaders() }, context.env);
    const statsPayload = await stats.json() as any;
    expect(statsPayload.total).toBe(2);
    expect(statsPayload.used).toBe(1);
    expect(statsPayload.unused).toBe(1);
    expect(statsPayload.totalSize).toBe(125);
  });

  it("skips used images during bulk delete and deletes unused storage assets", async () => {
    sqlite.exec(`
      INSERT INTO feeds (id, title, content, uid, draft, listed)
      VALUES (1, 'Post', '![hero](https://images.example.com/images/hero.png)', 1, 0, 1);
      INSERT INTO image_assets (id, url, storage_key, source, filename, content_type, size)
      VALUES
        (10, 'https://images.example.com/images/hero.png', 'images/hero.png', 'article', 'hero.png', 'image/png', 100),
        (20, 'https://images.example.com/images/free.png', 'images/free.png', 'storage', 'free.png', 'image/png', 25);
      INSERT INTO image_usages (asset_id, feed_id, raw_url)
      VALUES (10, 1, 'https://images.example.com/images/hero.png');
    `);

    const response = await context.app.request("/bulk-delete", {
      method: "POST",
      headers: {
        ...adminHeaders(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ids: [10, 20] }),
    }, context.env);
    const payload = await response.json() as any;

    expect(payload.deleted).toBe(1);
    expect(payload.skipped).toBe(1);
    expect(deletedKeys).toEqual(["images/free.png"]);

    const remaining = sqlite.prepare("SELECT id FROM image_assets ORDER BY id").all() as any[];
    expect(remaining.map((row) => row.id)).toEqual([10]);
  });

  it("updates favorite state and protects favorite unused images from deletion", async () => {
    sqlite.exec(`
      INSERT INTO image_assets (id, url, storage_key, source, filename, content_type, size)
      VALUES (10, 'https://images.example.com/images/free.png', 'images/free.png', 'storage', 'free.png', 'image/png', 25)
    `);

    const update = await context.app.request("/10", {
      method: "PATCH",
      headers: {
        ...adminHeaders(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ favorite: true }),
    }, context.env);
    expect(update.status).toBe(200);

    const deleteResponse = await context.app.request("/10", {
      method: "DELETE",
      headers: adminHeaders(),
    }, context.env);
    expect(deleteResponse.status).toBe(400);
    expect(await deleteResponse.text()).toBe("Favorite image cannot be deleted");

    const bulkResponse = await context.app.request("/bulk-delete", {
      method: "POST",
      headers: {
        ...adminHeaders(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ids: [10] }),
    }, context.env);
    const payload = await bulkResponse.json() as any;
    expect(payload.deleted).toBe(0);
    expect(payload.skipped).toBe(1);
    expect(payload.items[0].reason).toBe("Favorite image cannot be deleted");
  });

  it("filters by favorite and created date and sorts by size", async () => {
    sqlite.exec(`
      INSERT INTO image_assets (id, url, storage_key, source, filename, content_type, size, favorite, created_at)
      VALUES
        (10, 'https://images.example.com/images/small.png', 'images/small.png', 'storage', 'small.png', 'image/png', 25, 1, unixepoch('2025-01-01')),
        (20, 'https://images.example.com/images/large.png', 'images/large.png', 'storage', 'large.png', 'image/png', 100, 1, unixepoch('2025-02-01')),
        (30, 'https://images.example.com/images/normal.png', 'images/normal.png', 'storage', 'normal.png', 'image/png', 200, 0, unixepoch('2025-03-01'))
    `);

    const response = await context.app.request("/?favorite=favorited&createdFrom=2025-01-15T00:00:00.000Z&sort=size_desc", {
      headers: adminHeaders(),
    }, context.env);
    const payload = await response.json() as any;

    expect(payload.size).toBe(1);
    expect(payload.data[0].id).toBe(20);
    expect(payload.data[0].favorite).toBe(1);
  });

  it("filters unused images without expanding usage ids into SQL variables", async () => {
    sqlite.exec(`
      INSERT INTO users (id, username, openid, permission)
      VALUES (2, 'writer', 'writer', 1)
    `);

    const insertAsset = sqlite.prepare(`
      INSERT INTO image_assets (id, url, storage_key, source, filename, content_type, size)
      VALUES (?, ?, ?, 'storage', ?, 'image/png', 1)
    `);
    const insertFeed = sqlite.prepare(`
      INSERT INTO feeds (id, title, content, uid, draft, listed)
      VALUES (?, ?, 'content', 2, 0, 1)
    `);
    const insertUsage = sqlite.prepare(`
      INSERT INTO image_usages (asset_id, feed_id, raw_url)
      VALUES (?, ?, ?)
    `);

    for (let index = 1; index <= 1100; index += 1) {
      const url = `https://images.example.com/images/${index}.png`;
      insertAsset.run(index, url, `images/${index}.png`, `${index}.png`);
      insertFeed.run(index, `Post ${index}`);
      insertUsage.run(index, index, url);
    }
    insertAsset.run(2000, "https://images.example.com/images/free.png", "images/free.png", "free.png");

    const response = await context.app.request("/?usage=unused", {
      headers: adminHeaders(),
    }, context.env);
    const payload = await response.json() as any;

    expect(response.status).toBe(200);
    expect(payload.size).toBe(1);
    expect(payload.data[0].id).toBe(2000);
  });

  it("queues only supported local images for TinyPNG compression", async () => {
    const sent: unknown[] = [];
    context.env.TASK_QUEUE = {
      send: async (task: unknown) => {
        sent.push(task);
      },
    } as any;
    sqlite.exec(`
      INSERT INTO image_assets (id, url, storage_key, source, filename, content_type, size)
      VALUES
        (10, 'https://images.example.com/images/hero.png', 'images/hero.png', 'storage', 'hero.png', 'image/png', 100),
        (20, 'https://remote.example.com/free.gif', NULL, 'external', 'free.gif', 'image/gif', 0)
    `);

    const response = await context.app.request("/bulk-compress", {
      method: "POST",
      headers: {
        ...adminHeaders(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ids: [10, 20] }),
    }, context.env);
    const payload = await response.json() as any;

    expect(payload.queued).toBe(1);
    expect(payload.skipped).toBe(1);
    expect(sent).toHaveLength(1);
  });
});
