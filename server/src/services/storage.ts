import { Hono } from "hono";
import type { AppContext } from "../core/hono-types";
import { profileAsync } from "../core/server-timing";
import { getStorageObject, putStorageObject, putStorageObjectAtKey } from "../utils/storage";
import { canCompressWithTinyPng, compressWithTinyPng } from "../utils/tinypng";

function buf2hex(buffer: ArrayBuffer) {
    return [...new Uint8Array(buffer)]
        .map(x => x.toString(16).padStart(2, '0'))
        .join('');
}

export function StorageService(): Hono {
    const app = new Hono();

    function runInBackground(c: AppContext, task: Promise<unknown>) {
        let executionCtx: ExecutionContext | undefined;
        try {
            executionCtx = c.executionCtx;
        } catch {
            executionCtx = undefined;
        }

        if (executionCtx) {
            executionCtx.waitUntil(task);
            return;
        }

        task.catch((error) => {
            console.error("Background storage task failed:", error);
        });
    }

    // POST /storage
    app.post('/', async (c: AppContext) => {
        const uid = c.get('uid');
        const env = c.get('env');
        const serverConfig = c.get('serverConfig');
        
        const body = await profileAsync(c, 'storage_parse', () => c.req.parseBody());
        const key = body.key as string;
        const file = body.file as File;
        
        if (!uid) {
            return c.text('Unauthorized', 401);
        }
        
        const suffix = key.includes(".") ? key.split('.').pop() : "";
        let fileBuffer = await profileAsync(c, 'storage_file_buffer', () => file.arrayBuffer());
        let contentType = file.type;
        const tinypngEnabled = await profileAsync(c, 'storage_tinypng_config', async () => {
            const enabled = await serverConfig.get("tinypng.enabled");
            const apiKey = await serverConfig.get("tinypng.api_key");
            return {
                enabled: enabled === true || enabled === "true",
                apiKey: typeof apiKey === "string" ? apiKey.trim() : "",
            };
        });

        const hashArray = await profileAsync(c, 'storage_hash', () => crypto.subtle.digest(
            { name: 'SHA-1' },
            fileBuffer
        ));
        const hash = buf2hex(hashArray);
        const hashkey = `${hash}.${suffix}`;
        
        try {
            const result = await profileAsync(c, 'storage_put', () => putStorageObject(env, hashkey, fileBuffer, contentType, new URL(c.req.url).origin));

            if (tinypngEnabled.enabled && tinypngEnabled.apiKey && canCompressWithTinyPng(contentType)) {
                const originalBuffer = fileBuffer;
                const originalContentType = contentType;
                runInBackground(c, (async () => {
                    try {
                        const compressed = await compressWithTinyPng(originalBuffer, originalContentType, tinypngEnabled.apiKey);
                        await putStorageObjectAtKey(
                            env,
                            result.key,
                            compressed.body,
                            compressed.contentType || originalContentType,
                            new URL(c.req.url).origin,
                        );
                    } catch (error) {
                        console.error("TinyPNG background compression failed:", error);
                    }
                })());
            }

            return c.json({ url: result.url });
        } catch (e: any) {
            console.error(e.message);
            const status = e.message?.includes('is not defined') ? 500 : 400;
            return c.text(e.message, status);
        }
    });

    return app;
}

export function BlobService(): Hono {
    const app = new Hono();

    app.get("/*", async (c: AppContext) => {
        const env = c.get("env");
        const key = c.req.path.replace(/^\/blob\/?/, "");

        if (!key) {
            return c.text("Blob key is required", 400);
        }

        try {
            const response = await profileAsync(c, "blob_fetch", () => getStorageObject(env, decodeURIComponent(key)));

            if (!response) {
                return c.text("Not found", 404);
            }

            return new Response(response.body, {
                status: response.status,
                headers: response.headers,
            });
        } catch (error) {
            console.error("Blob fetch failed:", error);
            return c.text("Blob fetch failed", 500);
        }
    });

    return app;
}
