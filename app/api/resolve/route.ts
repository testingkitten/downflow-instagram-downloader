import { NextResponse } from "next/server";

const SOURCE_HOSTS = new Set([
  "instagram.com",
  "www.instagram.com",
  "instagr.am",
  "www.instagr.am",
]);

const REQUEST_HEADERS = {
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124.0 Safari/537.36",
};

const UPSTREAM_TIMEOUT_MS = 6500;
const MAX_CAROUSEL_ITEMS = 20;

type MediaItem = {
  type: "image" | "video";
  url: string;
  thumbnailUrl?: string;
};

function cleanValue(value: string) {
  return value
    .replace(/\\u0026/g, "&")
    .replace(/\\u003D/gi, "=")
    .replace(/\\u002F/gi, "/")
    .replace(/\\\//g, "/")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .trim();
}

function extractAttribute(tag: string, attribute: string) {
  const match = tag.match(
    new RegExp(`${attribute}\\s*=\\s*["']([^"']+)["']`, "i"),
  );
  return match ? cleanValue(match[1]) : undefined;
}

function extractMeta(html: string, key: string) {
  const tags = html.match(/<meta\b[^>]*>/gi) ?? [];

  for (const tag of tags) {
    const name = extractAttribute(tag, "property") ?? extractAttribute(tag, "name");
    if (name?.toLowerCase() === key.toLowerCase()) {
      return extractAttribute(tag, "content");
    }
  }

  return undefined;
}

function extractCanonical(html: string) {
  const tags = html.match(/<link\b[^>]*>/gi) ?? [];

  for (const tag of tags) {
    if (extractAttribute(tag, "rel")?.toLowerCase() === "canonical") {
      return extractAttribute(tag, "href");
    }
  }

  return undefined;
}

function isMediaUrl(value: string) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return (
      url.protocol === "https:" &&
      (host === "instagram.com" ||
        host.endsWith(".instagram.com") ||
        host.endsWith(".cdninstagram.com") ||
        host.endsWith(".fbcdn.net") ||
        host.endsWith(".fbsbx.com"))
    );
  } catch {
    return false;
  }
}

function isPostMediaUrl(value: string) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return (
      isMediaUrl(value) &&
      (host.startsWith("scontent.") || host.endsWith(".fbcdn.net")) &&
      /\/v\/t51\./i.test(url.pathname)
    );
  } catch {
    return false;
  }
}

function inferMediaType(url: string, fallback: MediaItem["type"] = "image") {
  return /\.(mp4|mov|m4v)(?:$|[?#])/i.test(url) || /video/i.test(url)
    ? "video"
    : fallback;
}

function extractMedia(html: string) {
  const media: MediaItem[] = [];
  const seen = new Set<string>();

  const add = (rawUrl: string | undefined, fallbackType: MediaItem["type"]) => {
    if (!rawUrl) return;
    const url = cleanValue(rawUrl);
    if (!isMediaUrl(url) || seen.has(url)) return;

    seen.add(url);
    media.push({ type: inferMediaType(url, fallbackType), url });
  };

  add(extractMeta(html, "og:video:secure_url"), "video");
  add(extractMeta(html, "og:video"), "video");
  add(extractMeta(html, "og:image"), "image");

  const directMatches = html.matchAll(
    /https?:\\?\/\\?\/[^"'\\\s<>]+?\.(?:jpe?g|png|webp|mp4)(?:\?[^"'\\\s<>]*)?/gi,
  );
  for (const match of directMatches) {
    const url = cleanValue(match[0]);
    if (isPostMediaUrl(url)) add(url, inferMediaType(url));
  }

  const videoMatches = html.matchAll(
    /["'](?:video_url|playable_url|video_versions)["']\s*:\s*["']([^"']+)["']/gi,
  );
  for (const match of videoMatches) add(match[1], "video");

  const displayMatches = html.matchAll(
    /["']display_url["']\s*:\s*["']([^"']+)["']/gi,
  );
  for (const match of displayMatches) add(match[1], "image");

  return media;
}

function getPostKind(pathname: string) {
  const [firstSegment] = pathname.replace(/^\/+|\/+$/g, "").split("/");
  if (firstSegment === "reel") return "reel";
  if (firstSegment === "tv") return "video";
  if (firstSegment === "stories") return "story";
  if (firstSegment === "p") return "post";
  return "link";
}

function getEmbedUrl(url: URL) {
  const path = url.pathname.replace(/\/$/, "");
  return `https://www.instagram.com${path}/embed/captioned/`;
}

function getMediaEndpointUrl(url: URL, index: number) {
  const path = url.pathname.replace(/\/$/, "");
  return `https://www.instagram.com${path}/media/?size=l&img_index=${index}`;
}

function mediaKey(value: string) {
  try {
    return new URL(value).pathname;
  } catch {
    return value;
  }
}

function mergeMedia(...groups: MediaItem[][]) {
  const seen = new Set<string>();
  const merged: MediaItem[] = [];

  for (const group of groups) {
    for (const item of group) {
      const key = mediaKey(item.url);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(item);
      if (merged.length >= MAX_CAROUSEL_ITEMS) return merged;
    }
  }

  return merged;
}

async function fetchHtml(target: string) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  const timeoutFallback = new Promise<string>((resolve) => {
    setTimeout(() => resolve(""), UPSTREAM_TIMEOUT_MS);
  });

  try {
    const request = fetch(target, {
      headers: REQUEST_HEADERS,
      redirect: "follow",
      cache: "no-store",
      signal: controller.signal,
    }).then(async (response) => (response.ok ? response.text() : ""));
    return await Promise.race([request, timeoutFallback]);
  } catch {
    return "";
  } finally {
    clearTimeout(timeoutId);
  }
}

async function fetchMediaEndpoint(target: string): Promise<MediaItem | undefined> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

  try {
    const response = await fetch(target, {
      headers: REQUEST_HEADERS,
      redirect: "follow",
      cache: "no-store",
      signal: controller.signal,
    });
    const contentType = response.headers.get("content-type") ?? "";
    const isImage = contentType.startsWith("image/");
    const isVideo = contentType.startsWith("video/");
    await response.body?.cancel();

    if (!response.ok || (!isImage && !isVideo) || !isMediaUrl(response.url)) return undefined;
    return { type: isVideo ? "video" : "image", url: response.url };
  } catch {
    return undefined;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function fetchCarouselMedia(url: URL) {
  if (getPostKind(url.pathname) === "story") return [];

  const targets = Array.from({ length: MAX_CAROUSEL_ITEMS }, (_, index) =>
    getMediaEndpointUrl(url, index),
  );
  const results = await Promise.all(targets.map(fetchMediaEndpoint));
  return mergeMedia(results.filter((item): item is MediaItem => Boolean(item)));
}

export async function POST(request: Request) {
  try {
    const payload = (await request.json()) as { url?: string };
    const input = payload.url?.trim();
    if (!input) {
      return NextResponse.json({ error: "Paste an Instagram link first." }, { status: 400 });
    }

    const sourceUrl = new URL(input);
    if (!SOURCE_HOSTS.has(sourceUrl.hostname.toLowerCase())) {
      return NextResponse.json(
        { error: "Use a link from instagram.com." },
        { status: 422 },
      );
    }

    const canonicalUrl = `https://www.instagram.com${sourceUrl.pathname}`;
    const embedUrl = getEmbedUrl(sourceUrl);
    const fetchTargets = [canonicalUrl, embedUrl];
    const [htmlChunks, endpointMedia] = await Promise.all([
      Promise.all(fetchTargets.map(fetchHtml)),
      fetchCarouselMedia(sourceUrl),
    ]);
    const html = htmlChunks.join("\n");
    const media = mergeMedia(endpointMedia, extractMedia(html));
    const caption = extractMeta(html, "og:description");
    const title = extractMeta(html, "og:title");
    const discoveredCanonical = extractCanonical(html);

    if (!media.length) {
      return NextResponse.json({
        ok: true,
        status: "embed-only",
        kind: getPostKind(sourceUrl.pathname),
        canonicalUrl: discoveredCanonical ?? canonicalUrl,
        embedUrl,
        caption,
        title,
        media: [],
        message:
          "Instagram did not expose a direct media URL to this request. The public embed is still available below.",
      });
    }

    return NextResponse.json({
      ok: true,
      status: "ready",
      kind: getPostKind(sourceUrl.pathname),
      canonicalUrl: discoveredCanonical ?? canonicalUrl,
      embedUrl,
      caption,
      title,
      media,
    });
  } catch {
    return NextResponse.json(
      { error: "That does not look like a valid Instagram link." },
      { status: 422 },
    );
  }
}
