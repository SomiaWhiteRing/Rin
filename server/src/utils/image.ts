export function stripImageMetadataFromUrl(url?: string | null) {
    if (!url) {
        return undefined;
    }

    return url.split("#", 2)[0];
}

export function parseImageMetadataFromUrl(url?: string | null) {
    if (!url) {
        return {
            src: undefined,
            blurhash: undefined,
            width: undefined,
            height: undefined,
        };
    }

    const [src, fragment = ""] = url.split("#", 2);
    const params = new URLSearchParams(fragment);
    const width = params.get("width");
    const height = params.get("height");

    return {
        src,
        blurhash: params.get("blurhash") || undefined,
        width: width ? Number.parseInt(width, 10) : undefined,
        height: height ? Number.parseInt(height, 10) : undefined,
    };
}

export function listMarkdownImageUrls(content: string) {
    const imagePattern = /!\[.*?\]\((\S+?)(?:\s+"[^"]*")?\)/g;
    const matches: string[] = [];

    for (const match of content.matchAll(imagePattern)) {
        if (match[1]) {
            matches.push(match[1]);
        }
    }

    return matches;
}

export function listHtmlImageUrls(content: string) {
    const imagePattern = /<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi;
    const matches: string[] = [];

    for (const match of content.matchAll(imagePattern)) {
        if (match[1]) {
            matches.push(match[1]);
        }
    }

    return matches;
}

export function listContentImageUrls(content: string) {
    return [...listMarkdownImageUrls(content), ...listHtmlImageUrls(content)];
}

function getComparableUrl(value?: string | null) {
    if (!value) {
        return undefined;
    }

    try {
        return new URL(value);
    } catch {
        return undefined;
    }
}

function isSameOriginUrl(url: URL, origin?: string) {
    const comparable = getComparableUrl(origin);
    return comparable ? url.origin === comparable.origin : false;
}

export function isExternalContentImageUrl(url: string, env?: Env, baseUrl?: string) {
    const metadata = parseImageMetadataFromUrl(url);
    const src = metadata.src;
    if (!src) {
        return false;
    }

    let parsed: URL;
    try {
        parsed = new URL(src);
    } catch {
        return false;
    }

    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return false;
    }

    if (isSameOriginUrl(parsed, baseUrl)) {
        return false;
    }

    if (isSameOriginUrl(parsed, env?.S3_ACCESS_HOST) || isSameOriginUrl(parsed, env?.S3_ENDPOINT)) {
        return false;
    }

    return true;
}

export function contentHasExternalImages(content: string, env?: Env, baseUrl?: string) {
    return listContentImageUrls(content).some((url) => isExternalContentImageUrl(url, env, baseUrl));
}

export function contentHasImagesMissingMetadata(content: string) {
    return listContentImageUrls(content).some((url) => {
        const metadata = parseImageMetadataFromUrl(url);
        return !metadata.blurhash || !metadata.width || !metadata.height;
    });
}

export function extractImage(content: string) {
    const img_reg = /!\[.*?\]\((\S+?)(?:\s+"[^"]*")?\)/;
    const img_match = img_reg.exec(content);
    let avatar: string | undefined = undefined;
    if (img_match) {
        avatar = stripImageMetadataFromUrl(img_match[1]);
    }
    return avatar;
}

export function extractImageWithMetadata(content: string) {
    const img_reg = /!\[.*?\]\((\S+?)(?:\s+"[^"]*")?\)/;
    const img_match = img_reg.exec(content);
    return img_match?.[1];
}
