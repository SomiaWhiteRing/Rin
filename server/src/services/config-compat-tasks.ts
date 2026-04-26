import { desc, eq } from "drizzle-orm";
import type { CacheImpl, DB } from "../core/hono-types";
import { feeds } from "../db/schema";
import { syncFeedAISummaryQueueState } from "./feed-ai-summary";
import { clearFeedCache } from "./feed";
import {
  contentHasExternalImages,
  contentHasImagesMissingMetadata,
  isExternalContentImageUrl,
  parseImageMetadataFromUrl,
} from "../utils/image";
import { getAIConfig } from "../utils/db-config";
import { putStorageObject } from "../utils/storage";

type ConfigReader = {
  get(key: string): Promise<unknown>;
};

function isAISummaryBackfillEligible(feed: {
  draft: number;
  ai_summary: string;
  ai_summary_status: string;
}) {
  if (feed.draft === 1) {
    return false;
  }

  if (feed.ai_summary.trim().length > 0) {
    return false;
  }

  return feed.ai_summary_status !== "pending" && feed.ai_summary_status !== "processing";
}

function isAISummaryForceBackfillEligible(feed: {
  draft: number;
  ai_summary_status: string;
}) {
  if (feed.draft === 1) {
    return false;
  }

  return feed.ai_summary_status !== "pending" && feed.ai_summary_status !== "processing";
}

export async function buildCompatTasksResponse(db: DB, serverConfig: ConfigReader, env: Env, baseUrl?: string) {
  const aiConfig = await getAIConfig(serverConfig);
  const items = await db.query.feeds.findMany({
    columns: {
      id: true,
      content: true,
      ai_summary: true,
      ai_summary_status: true,
      draft: true,
    },
  });

  return {
    generatedAt: new Date().toISOString(),
    aiSummary: {
      enabled: aiConfig.enabled,
      queueConfigured: Boolean(env.TASK_QUEUE),
      eligible: items.filter(isAISummaryBackfillEligible).length,
      forceEligible: items.filter(isAISummaryForceBackfillEligible).length,
    },
    blurhash: {
      eligible: items.filter((item) => contentHasImagesMissingMetadata(item.content)).length,
    },
    externalImages: {
      eligible: items.filter((item) => contentHasExternalImages(item.content, env, baseUrl)).length,
    },
  };
}

export async function runCompatAISummaryBackfill(
  db: DB,
  cache: CacheImpl,
  serverConfig: ConfigReader,
  env: Env,
  force = false,
) {
  const aiConfig = await getAIConfig(serverConfig);
  if (!aiConfig.enabled) {
    throw new Error("AI summary is not enabled");
  }
  if (!env.TASK_QUEUE) {
    throw new Error("TASK_QUEUE binding is not configured");
  }

  const items = await db.query.feeds.findMany({
    columns: {
      id: true,
      alias: true,
      updatedAt: true,
      ai_summary: true,
      ai_summary_status: true,
      draft: true,
    },
    orderBy: [desc(feeds.updatedAt)],
  });

  let queued = 0;
  let skipped = 0;

  for (const item of items) {
    const eligible = force
      ? isAISummaryForceBackfillEligible(item)
      : isAISummaryBackfillEligible(item);

    if (!eligible) {
      skipped += 1;
      continue;
    }

    await syncFeedAISummaryQueueState(db, serverConfig, env, item.id, {
      draft: false,
      updatedAt: item.updatedAt,
      resetSummary: true,
    });
    await clearFeedCache(cache, item.id, item.alias, item.alias);
    queued += 1;
  }

  return {
    queued,
    skipped,
    forced: force,
  };
}

export async function listBlurhashCompatCandidates(db: DB) {
  const items = await db.query.feeds.findMany({
    columns: {
      id: true,
      title: true,
      content: true,
    },
    orderBy: [desc(feeds.updatedAt)],
  });

  return {
    generatedAt: new Date().toISOString(),
    items: items.filter((item) => contentHasImagesMissingMetadata(item.content)),
  };
}

export async function applyBlurhashCompatUpdate(db: DB, cache: CacheImpl, feedId: number, content: string) {
  const feed = await db.query.feeds.findFirst({
    where: eq(feeds.id, feedId),
    columns: {
      id: true,
      alias: true,
      content: true,
    },
  });

  if (!feed) {
    throw new Error("Feed not found");
  }

  if (feed.content === content) {
    return { updated: false };
  }

  await db.update(feeds).set({ content }).where(eq(feeds.id, feed.id));
  await clearFeedCache(cache, feed.id, feed.alias, feed.alias);

  return { updated: true };
}

export async function listExternalImageCompatCandidates(db: DB, env: Env, baseUrl?: string) {
  const items = await db.query.feeds.findMany({
    columns: {
      id: true,
      title: true,
      content: true,
    },
    orderBy: [desc(feeds.updatedAt)],
  });

  return {
    generatedAt: new Date().toISOString(),
    items: items
      .filter((item) => contentHasExternalImages(item.content, env, baseUrl))
      .map((item) => ({
        id: item.id,
        title: item.title,
        images: countExternalImages(item.content, env, baseUrl),
      })),
  };
}

function countExternalImages(content: string, env: Env, baseUrl?: string) {
  const markdownPattern = /!\[.*?\]\((\S+?)(?:\s+"[^"]*")?\)/g;
  const htmlPattern = /<img\b[^>]*?\bsrc=["']([^"']+)["'][^>]*?>/gi;
  let count = 0;

  for (const match of content.matchAll(markdownPattern)) {
    if (match[1] && isExternalContentImageUrl(match[1], env, baseUrl)) {
      count += 1;
    }
  }
  for (const match of content.matchAll(htmlPattern)) {
    if (match[1] && isExternalContentImageUrl(match[1], env, baseUrl)) {
      count += 1;
    }
  }

  return count;
}

function getImageExtension(url: string, contentType?: string | null) {
  const normalizedType = contentType?.split(";", 1)[0]?.trim().toLowerCase();
  const byType: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/svg+xml": "svg",
    "image/avif": "avif",
  };
  if (normalizedType && byType[normalizedType]) {
    return byType[normalizedType];
  }

  try {
    const pathname = new URL(url).pathname;
    const extension = pathname.match(/\.([a-z0-9]{1,8})$/i)?.[1];
    return extension?.toLowerCase() || "bin";
  } catch {
    return "bin";
  }
}

function buf2hex(buffer: ArrayBuffer) {
  return [...new Uint8Array(buffer)]
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}

async function uploadExternalImage(env: Env, rawUrl: string, baseUrl?: string) {
  const { src } = parseImageMetadataFromUrl(rawUrl);
  if (!src) {
    throw new Error("Image URL is empty");
  }

  const response = await fetch(src, {
    headers: {
      "User-Agent": "Rin-Image-Migration/1.0",
      Accept: "image/avif,image/webp,image/png,image/jpeg,image/gif,image/svg+xml,image/*,*/*;q=0.8",
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch image: ${response.status} ${response.statusText}`);
  }

  const contentType = response.headers.get("Content-Type") || undefined;
  if (contentType && !contentType.toLowerCase().startsWith("image/")) {
    throw new Error(`Remote resource is not an image: ${contentType}`);
  }

  const body = await response.arrayBuffer();
  const hashArray = await crypto.subtle.digest({ name: "SHA-1" }, body);
  const key = `${buf2hex(hashArray)}.${getImageExtension(src, contentType)}`;
  const result = await putStorageObject(env, key, body, contentType, baseUrl);
  const fragment = rawUrl.includes("#") ? rawUrl.slice(rawUrl.indexOf("#")) : "";

  return `${result.url}${fragment}`;
}

export async function migrateExternalImagesForFeed(
  db: DB,
  cache: CacheImpl,
  env: Env,
  feedId: number,
  baseUrl?: string,
) {
  const feed = await db.query.feeds.findFirst({
    where: eq(feeds.id, feedId),
    columns: {
      id: true,
      alias: true,
      content: true,
    },
  });

  if (!feed) {
    throw new Error("Feed not found");
  }

  const markdownPattern = /!\[(.*?)\]\((\S+?)(?:\s+"[^"]*")?\)/g;
  const htmlPattern = /<img\b([^>]*?)\bsrc=["']([^"']+)["']([^>]*?)>/gi;
  const matches = [
    ...[...feed.content.matchAll(markdownPattern)].map((match) => ({
      type: "markdown" as const,
      fullMatch: match[0],
      alt: match[1] || "",
      rawUrl: match[2] || "",
    })),
    ...[...feed.content.matchAll(htmlPattern)].map((match) => ({
      type: "html" as const,
      fullMatch: match[0],
      beforeSrc: match[1] || "",
      rawUrl: match[2] || "",
      afterSrc: match[3] || "",
    })),
  ];

  let nextContent = feed.content;
  let migrated = 0;
  let failed = 0;

  for (const match of matches) {
    if (!match.rawUrl || !isExternalContentImageUrl(match.rawUrl, env, baseUrl)) {
      continue;
    }

    try {
      const nextUrl = await uploadExternalImage(env, match.rawUrl, baseUrl);
      const replacement = match.type === "markdown"
        ? `![${match.alt}](${nextUrl})`
        : `<img${match.beforeSrc}src="${nextUrl}"${match.afterSrc}>`;
      nextContent = nextContent.replace(match.fullMatch, replacement);
      migrated += 1;
    } catch (error) {
      console.error("External image migration failed:", error);
      failed += 1;
    }
  }

  if (nextContent !== feed.content) {
    await db.update(feeds).set({ content: nextContent }).where(eq(feeds.id, feed.id));
    await clearFeedCache(cache, feed.id, feed.alias, feed.alias);
  }

  return {
    updated: nextContent !== feed.content,
    migrated,
    failed,
  };
}
