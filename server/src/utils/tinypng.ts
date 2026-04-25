const TINYPNG_SHRINK_URL = "https://api.tinify.com/shrink";
const TINYPNG_SUPPORTED_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

type TinyPngShrinkResponse = {
    output?: {
        url?: string;
    };
};

function createTinyPngAuthHeader(apiKey: string) {
    return `Basic ${btoa(`api:${apiKey}`)}`;
}

export function canCompressWithTinyPng(contentType?: string) {
    if (!contentType) {
        return false;
    }

    return TINYPNG_SUPPORTED_TYPES.has(contentType.split(";")[0]?.trim().toLowerCase() ?? "");
}

export async function compressWithTinyPng(
    input: ArrayBuffer,
    contentType: string | undefined,
    apiKey: string,
): Promise<{ body: ArrayBuffer; contentType?: string }> {
    if (!canCompressWithTinyPng(contentType)) {
        return { body: input, contentType };
    }

    const authHeader = createTinyPngAuthHeader(apiKey);
    const shrinkResponse = await fetch(TINYPNG_SHRINK_URL, {
        method: "POST",
        headers: {
            Authorization: authHeader,
            "Content-Type": contentType || "application/octet-stream",
        },
        body: input,
    });

    if (!shrinkResponse.ok) {
        const message = await shrinkResponse.text();
        throw new Error(`TinyPNG compression failed: ${message || shrinkResponse.statusText}`);
    }

    const result = await shrinkResponse.json() as TinyPngShrinkResponse;
    const outputUrl = result.output?.url || shrinkResponse.headers.get("Location");
    if (!outputUrl) {
        throw new Error("TinyPNG compression failed: missing output URL");
    }

    const outputResponse = await fetch(outputUrl, {
        headers: {
            Authorization: authHeader,
        },
    });

    if (!outputResponse.ok) {
        const message = await outputResponse.text();
        throw new Error(`TinyPNG download failed: ${message || outputResponse.statusText}`);
    }

    return {
        body: await outputResponse.arrayBuffer(),
        contentType: outputResponse.headers.get("Content-Type") || contentType,
    };
}
