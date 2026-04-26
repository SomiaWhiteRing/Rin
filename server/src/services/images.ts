import { and, asc, desc, eq, gte, inArray, like, lte, sql } from "drizzle-orm";
import { Hono } from "hono";
import type { AppContext, DB } from "../core/hono-types";
import { imageAssets, imageUsages, feeds } from "../db/schema";
import { createImageCompressionTask, createTaskQueue } from "../queue";
import { listContentImageUrls, parseImageMetadataFromUrl } from "../utils/image";
import {
  deleteStorageObject,
  getStorageObject,
  getStoragePublicUrl,
  headStorageObject,
  listStorageObjects,
  putStorageObject,
  putStorageObjectAtKey,
  type StorageObjectInfo,
} from "../utils/storage";
import { canCompressWithTinyPng, compressWithTinyPng } from "../utils/tinypng";

type ImageSource = "upload" | "article" | "storage" | "external";

type UpsertImageAssetOptions = {
  source?: ImageSource;
  storageKey?: string | null;
  contentType?: string | null;
  size?: number | null;
  width?: number | null;
  height?: number | null;
  blurhash?: string | null;
};

const IMAGE_EXTENSION_PATTERN = /\.(avif|gif|jpe?g|png|svg|webp)$/i;

function stripTrailingSlash(value?: string | null) {
  return value?.endsWith("/") ? value.slice(0, -1) : value || "";
}

function normalizeContentType(contentType?: string | null) {
  return contentType?.split(";", 1)[0]?.trim().toLowerCase() || "";
}

function isImageObject(object: StorageObjectInfo) {
  const contentType = normalizeContentType(object.contentType);
  return contentType.startsWith("image/") || IMAGE_EXTENSION_PATTERN.test(object.key);
}

function filenameFromUrlOrKey(url: string, storageKey?: string | null) {
  const value = storageKey || url;
  try {
    const pathname = value.includes("://") ? new URL(value).pathname : value;
    return decodeURIComponent(pathname.split("/").filter(Boolean).pop() || "image");
  } catch {
    return value.split("/").filter(Boolean).pop() || "image";
  }
}

function getOrigin(value?: string | null) {
  if (!value) {
    return "";
  }
  try {
    return new URL(value).origin;
  } catch {
    return "";
  }
}

export function resolveImageStorageKey(env: Env, rawUrl: string, baseUrl?: string) {
  const { src } = parseImageMetadataFromUrl(rawUrl);
  if (!src) {
    return undefined;
  }

  const baseOrigin = getOrigin(baseUrl);
  const accessOrigin = getOrigin(env.S3_ACCESS_HOST);
  const endpointOrigin = getOrigin(env.S3_ENDPOINT);
  let parsed: URL;

  try {
    parsed = new URL(src, baseUrl);
  } catch {
    return undefined;
  }

  if (baseOrigin && parsed.origin === baseOrigin && parsed.pathname.startsWith("/api/blob/")) {
    return decodeURIComponent(parsed.pathname.replace(/^\/api\/blob\/?/, ""));
  }

  if (accessOrigin && parsed.origin === accessOrigin) {
    return decodeURIComponent(parsed.pathname.replace(/^\/+/, ""));
  }

  if (endpointOrigin && parsed.origin === endpointOrigin) {
    const path = decodeURIComponent(parsed.pathname.replace(/^\/+/, ""));
    if (env.S3_FORCE_PATH_STYLE === "true" && env.S3_BUCKET && path.startsWith(`${env.S3_BUCKET}/`)) {
      return path.slice(env.S3_BUCKET.length + 1);
    }
    return path;
  }

  return undefined;
}

function normalizeAssetUrl(env: Env, rawUrl: string, storageKey?: string | null, baseUrl?: string) {
  const metadata = parseImageMetadataFromUrl(rawUrl);
  if (storageKey) {
    return getStoragePublicUrl(env, storageKey, baseUrl);
  }
  return metadata.src || rawUrl;
}

async function inspectStorageObject(env: Env, storageKey?: string | null) {
  if (!storageKey) {
    return {};
  }

  if (env.R2_BUCKET && typeof (env.R2_BUCKET as any).head !== "function") {
    return {};
  }

  const response = await headStorageObject(env, storageKey);
  if (!response) {
    return {};
  }

  return {
    size: Number(response.headers.get("Content-Length") || 0),
    contentType: response.headers.get("Content-Type") || "",
  };
}

export async function upsertImageAssetForUrl(
  db: DB,
  env: Env,
  rawUrl: string,
  baseUrl?: string,
  options: UpsertImageAssetOptions = {},
) {
  const parsed = parseImageMetadataFromUrl(rawUrl);
  if (!parsed.src) {
    return null;
  }

  const storageKey = options.storageKey ?? resolveImageStorageKey(env, rawUrl, baseUrl);
  const inspected = await inspectStorageObject(env, storageKey);
  const url = normalizeAssetUrl(env, rawUrl, storageKey, baseUrl);
  const existing = await db.query.imageAssets.findFirst({
    where: storageKey ? eq(imageAssets.storageKey, storageKey) : eq(imageAssets.url, url),
  });
  const now = new Date();
  const values = {
    url,
    storageKey: storageKey || null,
    source: options.source || (storageKey ? "article" : "external"),
    filename: filenameFromUrlOrKey(url, storageKey),
    contentType: options.contentType || inspected.contentType || "",
    size: options.size ?? inspected.size ?? 0,
    width: options.width ?? parsed.width ?? null,
    height: options.height ?? parsed.height ?? null,
    blurhash: options.blurhash ?? parsed.blurhash ?? "",
    updatedAt: now,
  };

  if (existing) {
    await db.update(imageAssets).set({
      ...values,
      source: existing.source === "upload" ? existing.source : values.source,
      contentType: values.contentType || existing.contentType,
      size: values.size || existing.size,
      width: values.width ?? existing.width,
      height: values.height ?? existing.height,
      blurhash: values.blurhash || existing.blurhash,
    }).where(eq(imageAssets.id, existing.id));
    return { ...existing, ...values, id: existing.id };
  }

  const result = await db.insert(imageAssets).values(values).returning();
  return result[0] || null;
}

export async function registerUploadedImageAsset(
  db: DB,
  env: Env,
  storageKey: string,
  url: string,
  metadata: { contentType?: string; size?: number },
  baseUrl?: string,
) {
  return upsertImageAssetForUrl(db, env, url, baseUrl, {
    source: "upload",
    storageKey,
    contentType: metadata.contentType,
    size: metadata.size,
  });
}

export async function syncFeedImageUsages(db: DB, env: Env, feedId: number, content: string, baseUrl?: string) {
  const urls = [...new Set(listContentImageUrls(content))];
  const assetIds: number[] = [];

  for (const rawUrl of urls) {
    const asset = await upsertImageAssetForUrl(db, env, rawUrl, baseUrl, {
      source: resolveImageStorageKey(env, rawUrl, baseUrl) ? "article" : "external",
    });
    if (!asset) {
      continue;
    }

    assetIds.push(asset.id);
    const existing = await db.query.imageUsages.findFirst({
      where: and(eq(imageUsages.assetId, asset.id), eq(imageUsages.feedId, feedId)),
    });

    if (existing) {
      await db.update(imageUsages).set({ rawUrl, updatedAt: new Date() }).where(eq(imageUsages.id, existing.id));
    } else {
      await db.insert(imageUsages).values({ assetId: asset.id, feedId, rawUrl });
    }
  }

  const existingUsages = await db.query.imageUsages.findMany({
    where: eq(imageUsages.feedId, feedId),
    columns: { id: true, assetId: true },
  });

  const staleIds = existingUsages
    .filter((usage) => !assetIds.includes(usage.assetId))
    .map((usage) => usage.id);

  if (staleIds.length > 0) {
    await db.delete(imageUsages).where(inArray(imageUsages.id, staleIds));
  }

  return { indexed: assetIds.length, removed: staleIds.length };
}

export async function removeFeedImageUsages(db: DB, feedId: number) {
  await db.delete(imageUsages).where(eq(imageUsages.feedId, feedId));
}

export async function buildImageAssetIndex(db: DB, env: Env, baseUrl?: string) {
  const allFeeds = await db.query.feeds.findMany({
    columns: { id: true, content: true },
    orderBy: [desc(feeds.updatedAt)],
  });
  let articleImages = 0;
  let storageImages = 0;
  let externalImages = 0;
  let failed = 0;

  for (const feed of allFeeds) {
    try {
      const result = await syncFeedImageUsages(db, env, feed.id, feed.content, baseUrl);
      articleImages += result.indexed;
    } catch (error) {
      console.error("Image usage indexing failed:", error);
      failed += 1;
    }
  }

  try {
    const objects = (await listStorageObjects(env, env.S3_FOLDER || "")).filter(isImageObject);
    for (const object of objects) {
      try {
        const url = getStoragePublicUrl(env, object.key, baseUrl);
        await upsertImageAssetForUrl(db, env, url, baseUrl, {
          source: "storage",
          storageKey: object.key,
          contentType: object.contentType,
          size: object.size,
        });
        storageImages += 1;
      } catch (error) {
        console.error("Storage image indexing failed:", error);
        failed += 1;
      }
    }
  } catch (error) {
    console.error("Storage image scan failed:", error);
    failed += 1;
  }

  const externalCount = await db.select({ count: sql<number>`count(*)` }).from(imageAssets).where(eq(imageAssets.source, "external"));
  externalImages = Number(externalCount[0]?.count || 0);
  const unused = await countUnusedImages(db);

  return {
    articleImages,
    storageImages,
    externalImages,
    unused,
    failed,
  };
}

async function countUsagesByAsset(db: DB, assetIds: number[]) {
  if (assetIds.length === 0) {
    return new Map<number, number>();
  }

  const rows = await db
    .select({ assetId: imageUsages.assetId, count: sql<number>`count(*)` })
    .from(imageUsages)
    .where(inArray(imageUsages.assetId, assetIds))
    .groupBy(imageUsages.assetId);

  return new Map(rows.map((row) => [row.assetId, Number(row.count)]));
}

async function getUsageFeeds(db: DB, assetIds: number[]) {
  if (assetIds.length === 0) {
    return new Map<number, Array<{ id: number; title: string | null }>>();
  }

  const rows = await db
    .select({ assetId: imageUsages.assetId, feedId: feeds.id, title: feeds.title })
    .from(imageUsages)
    .innerJoin(feeds, eq(imageUsages.feedId, feeds.id))
    .where(inArray(imageUsages.assetId, assetIds));
  const result = new Map<number, Array<{ id: number; title: string | null }>>();

  for (const row of rows) {
    const items = result.get(row.assetId) || [];
    items.push({ id: row.feedId, title: row.title });
    result.set(row.assetId, items);
  }

  return result;
}

async function countUnusedImages(db: DB) {
  const rows = await db
    .select({ id: imageAssets.id })
    .from(imageAssets)
    .leftJoin(imageUsages, eq(imageAssets.id, imageUsages.assetId))
    .where(sql`${imageUsages.id} is null`);
  return rows.length;
}

async function listImages(db: DB, params: URLSearchParams) {
  const page = Math.max(Number(params.get("page") || 1), 1);
  const limit = Math.min(Math.max(Number(params.get("limit") || 24), 1), 100);
  const keyword = params.get("keyword")?.trim();
  const usage = params.get("usage");
  const feedId = Number(params.get("feedId") || 0);
  const contentType = params.get("contentType")?.trim();
  const compressionStatus = params.get("compressionStatus")?.trim();
  const favorite = params.get("favorite") || "all";
  const createdFrom = params.get("createdFrom")?.trim();
  const createdTo = params.get("createdTo")?.trim();
  const sort = params.get("sort") || "created_desc";
  const conditions = [];

  if (keyword) {
    conditions.push(sql`(${imageAssets.filename} like ${`%${keyword}%`} or ${imageAssets.url} like ${`%${keyword}%`} or ${imageAssets.note} like ${`%${keyword}%`})`);
  }
  if (contentType) {
    conditions.push(like(imageAssets.contentType, `${contentType}%`));
  }
  if (compressionStatus) {
    conditions.push(eq(imageAssets.compressionStatus, compressionStatus));
  }
  if (favorite === "favorited") {
    conditions.push(eq(imageAssets.favorite, 1));
  } else if (favorite === "normal") {
    conditions.push(eq(imageAssets.favorite, 0));
  }
  if (createdFrom) {
    const date = new Date(createdFrom);
    if (!Number.isNaN(date.getTime())) {
      conditions.push(gte(imageAssets.createdAt, date));
    }
  }
  if (createdTo) {
    const date = new Date(createdTo);
    if (!Number.isNaN(date.getTime())) {
      conditions.push(lte(imageAssets.createdAt, date));
    }
  }
  if (feedId > 0) {
    conditions.push(sql`${imageAssets.id} in (select asset_id from image_usages where feed_id = ${feedId})`);
  }
  if (usage === "used") {
    conditions.push(sql`${imageAssets.id} in (select asset_id from image_usages)`);
  } else if (usage === "unused") {
    conditions.push(sql`${imageAssets.id} not in (select asset_id from image_usages)`);
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;
  const orderBy = sort === "created_asc"
    ? [asc(imageAssets.createdAt)]
    : sort === "size_desc"
      ? [desc(imageAssets.size)]
      : sort === "size_asc"
        ? [asc(imageAssets.size)]
        : [desc(imageAssets.createdAt)];
  const total = await db.select({ count: sql<number>`count(*)` }).from(imageAssets).where(where);
  const assets = await db.query.imageAssets.findMany({
    where,
    orderBy,
    offset: (page - 1) * limit,
    limit: limit + 1,
  });
  const hasNext = assets.length > limit;
  if (hasNext) {
    assets.pop();
  }

  const ids = assets.map((asset) => asset.id);
  const usageCounts = await countUsagesByAsset(db, ids);
  const usageFeeds = await getUsageFeeds(db, ids);

  return {
    size: Number(total[0]?.count || 0),
    data: assets.map((asset) => ({
      ...asset,
      usageCount: usageCounts.get(asset.id) || 0,
      usages: usageFeeds.get(asset.id) || [],
    })),
    hasNext,
  };
}

async function buildStats(db: DB) {
  const total = await db.select({ count: sql<number>`count(*)` }).from(imageAssets);
  const used = await db
    .select({ id: imageAssets.id })
    .from(imageAssets)
    .where(sql`exists (select 1 from image_usages where image_usages.asset_id = image_assets.id)`);
  const storage = await db
    .select({ totalSize: sql<number>`coalesce(sum(${imageAssets.size}), 0)` })
    .from(imageAssets)
    .where(sql`${imageAssets.storageKey} is not null`);
  const compressible = await db
    .select({ count: sql<number>`count(*)` })
    .from(imageAssets)
    .where(sql`${imageAssets.storageKey} is not null and (${imageAssets.contentType} like 'image/png%' or ${imageAssets.contentType} like 'image/jpeg%' or ${imageAssets.contentType} like 'image/webp%')`);

  return {
    total: Number(total[0]?.count || 0),
    used: used.length,
    unused: await countUnusedImages(db),
    totalSize: Number(storage[0]?.totalSize || 0),
    compressible: Number(compressible[0]?.count || 0),
  };
}

async function deleteImageAsset(db: DB, env: Env, id: number) {
  const asset = await db.query.imageAssets.findFirst({ where: eq(imageAssets.id, id) });
  if (!asset) {
    throw new Error("Image not found");
  }
  const usages = await db.query.imageUsages.findMany({ where: eq(imageUsages.assetId, id), columns: { id: true } });
  if (usages.length > 0) {
    throw new Error("Image is used by articles");
  }
  if (asset.favorite === 1) {
    throw new Error("Favorite image cannot be deleted");
  }
  if (!asset.storageKey) {
    throw new Error("External image cannot be deleted");
  }

  await deleteStorageObject(env, asset.storageKey);
  await db.delete(imageAssets).where(eq(imageAssets.id, id));
}

async function bulkDeleteImages(db: DB, env: Env, ids: number[]) {
  const result = { deleted: 0, skipped: 0, items: [] as Array<{ id: number; status: "deleted" | "skipped"; reason?: string }> };

  for (const id of ids) {
    try {
      await deleteImageAsset(db, env, id);
      result.deleted += 1;
      result.items.push({ id, status: "deleted" });
    } catch (error) {
      result.skipped += 1;
      result.items.push({ id, status: "skipped", reason: error instanceof Error ? error.message : String(error) });
    }
  }

  return result;
}

export async function processImageCompressionTask(env: Env, db: DB, serverConfig: { get(key: string): Promise<unknown> }, imageId: number) {
  const asset = await db.query.imageAssets.findFirst({ where: eq(imageAssets.id, imageId) });
  if (!asset || !asset.storageKey) {
    return;
  }

  const apiKeyValue = await serverConfig.get("tinypng.api_key");
  const apiKey = typeof apiKeyValue === "string" ? apiKeyValue.trim() : "";
  if (!apiKey) {
    await db.update(imageAssets).set({ compressionStatus: "failed", compressionError: "TinyPNG API key is not configured" }).where(eq(imageAssets.id, imageId));
    return;
  }

  if (!canCompressWithTinyPng(asset.contentType)) {
    await db.update(imageAssets).set({ compressionStatus: "skipped", compressionError: "Unsupported image type" }).where(eq(imageAssets.id, imageId));
    return;
  }

  await db.update(imageAssets).set({ compressionStatus: "processing", compressionError: "", updatedAt: new Date() }).where(eq(imageAssets.id, imageId));

  try {
    const response = await getStorageObject(env, asset.storageKey);
    if (!response) {
      throw new Error("Storage object not found");
    }

    const originalBody = await response.arrayBuffer();
    const compressed = await compressWithTinyPng(originalBody, asset.contentType, apiKey);
    await putStorageObjectAtKey(env, asset.storageKey, compressed.body, compressed.contentType || asset.contentType);
    await db.update(imageAssets).set({
      contentType: compressed.contentType || asset.contentType,
      size: compressed.body.byteLength,
      originalSize: originalBody.byteLength,
      compressionStatus: "completed",
      compressionError: "",
      compressedAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(imageAssets.id, imageId));
  } catch (error) {
    await db.update(imageAssets).set({
      compressionStatus: "failed",
      compressionError: error instanceof Error ? error.message : String(error),
      updatedAt: new Date(),
    }).where(eq(imageAssets.id, imageId));
  }
}

export function ImageService(): Hono {
  const app = new Hono();

  app.get("/", async (c: AppContext) => {
    if (!c.get("admin")) {
      return c.text("Unauthorized", 401);
    }

    return c.json(await listImages(c.get("db"), new URL(c.req.url).searchParams));
  });

  app.get("/stats", async (c: AppContext) => {
    if (!c.get("admin")) {
      return c.text("Unauthorized", 401);
    }

    return c.json(await buildStats(c.get("db")));
  });

  app.post("/", async (c: AppContext) => {
    if (!c.get("admin")) {
      return c.text("Unauthorized", 401);
    }

    const body = await c.req.parseBody();
    const file = body.file as File;
    if (!file) {
      return c.text("File is required", 400);
    }

    const key = (body.key as string | undefined) || file.name;
    const suffix = key.includes(".") ? key.split(".").pop() : "";
    const fileBuffer = await file.arrayBuffer();
    const hashArray = await crypto.subtle.digest({ name: "SHA-1" }, fileBuffer);
    const hash = [...new Uint8Array(hashArray)].map((x) => x.toString(16).padStart(2, "0")).join("");
    const result = await putStorageObject(c.get("env"), `${hash}.${suffix}`, fileBuffer, file.type, new URL(c.req.url).origin);
    const asset = await registerUploadedImageAsset(c.get("db"), c.get("env"), result.key, result.url, {
      contentType: file.type,
      size: fileBuffer.byteLength,
    }, new URL(c.req.url).origin);

    return c.json({ url: result.url, asset });
  });

  app.patch("/:id", async (c: AppContext) => {
    if (!c.get("admin")) {
      return c.text("Unauthorized", 401);
    }

    const id = Number(c.req.param("id"));
    const body = await c.req.json() as { filename?: string; note?: string; favorite?: boolean };
    await c.get("db").update(imageAssets).set({
      filename: body.filename,
      note: body.note,
      favorite: body.favorite === undefined ? undefined : body.favorite ? 1 : 0,
      updatedAt: new Date(),
    }).where(eq(imageAssets.id, id));
    return c.json({ success: true });
  });

  app.delete("/:id", async (c: AppContext) => {
    if (!c.get("admin")) {
      return c.text("Unauthorized", 401);
    }

    try {
      await deleteImageAsset(c.get("db"), c.get("env"), Number(c.req.param("id")));
      return c.json({ success: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return c.text(message, message === "Image not found" ? 404 : 400);
    }
  });

  app.post("/bulk-delete", async (c: AppContext) => {
    if (!c.get("admin")) {
      return c.text("Unauthorized", 401);
    }

    const body = await c.req.json() as { ids?: number[] };
    return c.json(await bulkDeleteImages(c.get("db"), c.get("env"), body.ids || []));
  });

  app.post("/bulk-compress", async (c: AppContext) => {
    if (!c.get("admin")) {
      return c.text("Unauthorized", 401);
    }

    const body = await c.req.json() as { ids?: number[] };
    const ids = [...new Set((body.ids || []).filter((id) => Number.isInteger(id) && id > 0))];
    const assets = ids.length > 0
      ? await c.get("db").query.imageAssets.findMany({ where: inArray(imageAssets.id, ids) })
      : [];
    let queued = 0;
    let skipped = 0;

    for (const asset of assets) {
      if (!asset.storageKey || !canCompressWithTinyPng(asset.contentType)) {
        skipped += 1;
        continue;
      }

      await c.get("db").update(imageAssets).set({ compressionStatus: "pending", compressionError: "", updatedAt: new Date() }).where(eq(imageAssets.id, asset.id));
      await createTaskQueue(c.get("env")).send(createImageCompressionTask({ imageId: asset.id }));
      queued += 1;
    }

    return c.json({ queued, skipped });
  });

  return app;
}
