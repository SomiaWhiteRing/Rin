import { path_join } from "./path";
import { buildS3ListUrl, buildS3ObjectUrl, createS3Client, deleteObject as deleteS3Object, putObject as putS3Object } from "./s3";

type StorageTarget =
  | {
      type: "r2";
      bucket: R2Bucket;
      folder: string;
      publicBaseUrl: string;
    }
  | {
      type: "s3";
      env: Env;
      folder: string;
      publicBaseUrl: string;
    };

function trimTrailingSlash(value: string) {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

export function resolveStorageTarget(env: Env): StorageTarget {
  const folder = env.S3_FOLDER || "";
  const publicBaseUrl = trimTrailingSlash(env.S3_ACCESS_HOST || env.S3_ENDPOINT || "");

  if (env.R2_BUCKET) {
    return {
      type: "r2",
      bucket: env.R2_BUCKET,
      folder,
      publicBaseUrl,
    };
  }

  if (!env.S3_ENDPOINT) {
    throw new Error("S3_ENDPOINT is not defined");
  }
  if (!env.S3_ACCESS_KEY_ID) {
    throw new Error("S3_ACCESS_KEY_ID is not defined");
  }
  if (!env.S3_SECRET_ACCESS_KEY) {
    throw new Error("S3_SECRET_ACCESS_KEY is not defined");
  }
  if (!env.S3_BUCKET) {
    throw new Error("S3_BUCKET is not defined");
  }

  return {
    type: "s3",
    env,
    folder,
    publicBaseUrl,
  };
}

function encodeStorageKey(key: string) {
  return key
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function buildBlobUrl(storageKey: string, baseUrl?: string) {
  const encodedKey = encodeStorageKey(storageKey);
  const path = `/api/blob/${encodedKey}`;

  if (!baseUrl) {
    return path;
  }

  return `${trimTrailingSlash(baseUrl)}${path}`;
}

function createStorageResponse(object: R2ObjectBody | R2Object, body?: BodyInit | null) {
  const headers = new Headers();
  object.writeHttpMetadata(headers);

  if (object.httpEtag) {
    headers.set("ETag", object.httpEtag);
  }

  if (!headers.has("Content-Length")) {
    headers.set("Content-Length", String(object.size));
  }

  if (!headers.has("Last-Modified")) {
    headers.set("Last-Modified", object.uploaded.toUTCString());
  }

  return new Response(body ?? null, {
    status: 200,
    headers,
  });
}

export async function getStorageObject(env: Env, storageKey: string): Promise<Response | null> {
  if (env.R2_BUCKET) {
    const object = await env.R2_BUCKET.get(storageKey);
    if (!object) {
      return null;
    }
    return createStorageResponse(object, object.body);
  }

  const client = createS3Client(env);
  const response = await client.fetch(buildS3ObjectUrl(env, storageKey), {
    method: "GET",
  });

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    throw new Error(`Failed to fetch storage object: ${response.status} ${response.statusText}`);
  }

  return response;
}

export async function headStorageObject(env: Env, storageKey: string): Promise<Response | null> {
  if (env.R2_BUCKET) {
    const object = await env.R2_BUCKET.head(storageKey);
    if (!object) {
      return null;
    }
    return createStorageResponse(object);
  }

  const client = createS3Client(env);
  const response = await client.fetch(buildS3ObjectUrl(env, storageKey), {
    method: "HEAD",
  });

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    throw new Error(`Failed to inspect storage object: ${response.status} ${response.statusText}`);
  }

  return response;
}

export function getStoragePublicUrl(env: Env, storageKey: string, baseUrl?: string) {
  if (env.S3_ACCESS_HOST) {
    return `${trimTrailingSlash(env.S3_ACCESS_HOST)}/${storageKey}`;
  }

  return buildBlobUrl(storageKey, baseUrl);
}

export async function putStorageObject(
  env: Env,
  key: string,
  body: Blob | ArrayBuffer | Uint8Array | string,
  contentType?: string,
  baseUrl?: string,
) {
  const target = resolveStorageTarget(env);
  const storageKey = path_join(target.folder, key);

  return putStorageObjectAtKey(env, storageKey, body, contentType, baseUrl);
}

export async function putStorageObjectAtKey(
  env: Env,
  storageKey: string,
  body: Blob | ArrayBuffer | Uint8Array | string,
  contentType?: string,
  baseUrl?: string,
) {
  if (env.R2_BUCKET) {
    await env.R2_BUCKET.put(storageKey, body, {
      httpMetadata: contentType ? { contentType } : undefined,
    });
  } else {
    const client = createS3Client(env);
    await putS3Object(client, env, storageKey, body, contentType);
  }

  return {
    key: storageKey,
    url: getStoragePublicUrl(env, storageKey, baseUrl),
  };
}

export type StorageObjectInfo = {
  key: string;
  size: number;
  uploaded?: Date;
  contentType?: string;
};

export async function deleteStorageObject(env: Env, storageKey: string) {
  if (env.R2_BUCKET) {
    await env.R2_BUCKET.delete(storageKey);
    return;
  }

  const client = createS3Client(env);
  await deleteS3Object(client, env, storageKey);
}

function parseS3Text(value: any) {
  if (Array.isArray(value)) {
    return parseS3Text(value[0]);
  }
  if (value === undefined || value === null) {
    return "";
  }
  return String(value);
}

async function listS3StorageObjects(env: Env, prefix: string): Promise<StorageObjectInfo[]> {
  const { XMLParser } = await import("fast-xml-parser");
  const client = createS3Client(env);
  const parser = new XMLParser({ ignoreAttributes: false });
  const items: StorageObjectInfo[] = [];
  let continuationToken: string | undefined;

  do {
    const response = await client.fetch(buildS3ListUrl(env, prefix, continuationToken), {
      method: "GET",
    });

    if (!response.ok) {
      throw new Error(`Failed to list S3 objects: ${response.status} ${response.statusText}`);
    }

    const parsed = parser.parse(await response.text()) as any;
    const result = parsed.ListBucketResult || {};
    const contents = Array.isArray(result.Contents)
      ? result.Contents
      : result.Contents
        ? [result.Contents]
        : [];

    for (const object of contents) {
      const key = parseS3Text(object.Key);
      if (!key) {
        continue;
      }

      const head = await headStorageObject(env, key);
      items.push({
        key,
        size: Number.parseInt(parseS3Text(object.Size), 10) || Number(head?.headers.get("Content-Length") || 0),
        uploaded: parseS3Text(object.LastModified) ? new Date(parseS3Text(object.LastModified)) : undefined,
        contentType: head?.headers.get("Content-Type") || undefined,
      });
    }

    const truncated = parseS3Text(result.IsTruncated) === "true";
    continuationToken = truncated ? parseS3Text(result.NextContinuationToken) : undefined;
  } while (continuationToken);

  return items;
}

export async function listStorageObjects(env: Env, prefix = env.S3_FOLDER || ""): Promise<StorageObjectInfo[]> {
  if (env.R2_BUCKET) {
    const items: StorageObjectInfo[] = [];
    let cursor: string | undefined;

    do {
      const result = await env.R2_BUCKET.list({ prefix, cursor });
      for (const object of result.objects) {
        const head = typeof (env.R2_BUCKET as any).head === "function"
          ? await env.R2_BUCKET.head(object.key)
          : undefined;
        const contentType = (head as any)?.httpMetadata?.contentType;
        items.push({
          key: object.key,
          size: object.size,
          uploaded: object.uploaded,
          contentType,
        });
      }
      cursor = result.truncated ? result.cursor : undefined;
    } while (cursor);

    return items;
  }

  return listS3StorageObjects(env, prefix);
}
