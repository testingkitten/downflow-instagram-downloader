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
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.6367.91 Safari/537.36",
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
  "Upgrade-Insecure-Requests": "1",
  "X-IG-App-ID": "936619743392459",
  "X-IG-D": "www",
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
      /\/v\/t51\.[^/]+-15\//i.test(url.pathname)
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

function collectMedia(
  value: unknown,
  media: MediaItem[],
  seen: Set<string>,
  fallbackType: MediaItem["type"] = "image",
  skipBranches = false,
) {
  if (typeof value === "string") {
    const url = cleanValue(value);
    const key = mediaKey(url);
    if (!isPostMediaUrl(url) || seen.has(key)) return;

    seen.add(key);
    media.push({ type: inferMediaType(url, fallbackType), url });
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) collectMedia(item, media, seen, fallbackType, skipBranches);
    return;
  }

  if (!value || typeof value !== "object") return;

  for (const [key, child] of Object.entries(value)) {
    if (
      skipBranches &&
      [
        "comments",
        "comments_connection",
        "coauthor_producers",
        "polaris_ordered_timeline_connection",
        "related_topic_pills",
        "user",
      ].includes(key)
    ) {
      continue;
    }

    const childType = /video|playable/i.test(key) ? "video" : fallbackType;
    if (typeof child === "string") {
      if (/url|uri|src|candidate/i.test(key)) {
        collectMedia(child, media, seen, childType);
      }
      continue;
    }

    collectMedia(child, media, seen, childType, skipBranches);
    if (media.length >= MAX_CAROUSEL_ITEMS) return;
  }
}

function extractTargetObjects(value: unknown, shortcode: string, matches: Record<string, unknown>[]) {
  if (Array.isArray(value)) {
    for (const item of value) extractTargetObjects(item, shortcode, matches);
    return;
  }

  if (!value || typeof value !== "object") return;

  const record = value as Record<string, unknown>;
  if (record.code === shortcode) matches.push(record);

  for (const child of Object.values(record)) {
    extractTargetObjects(child, shortcode, matches);
    if (matches.length >= 8) return;
  }
}

function extractMedia(html: string, shortcode?: string) {
  const media: MediaItem[] = [];
  const seen = new Set<string>();

  const add = (rawUrl: string | undefined, fallbackType: MediaItem["type"]) => {
    if (!rawUrl) return;
    const url = cleanValue(rawUrl);
    const key = mediaKey(url);
    if (!isMediaUrl(url) || seen.has(key)) return;

    seen.add(key);
    media.push({ type: inferMediaType(url, fallbackType), url });
  };

  add(extractMeta(html, "og:video:secure_url"), "video");
  add(extractMeta(html, "og:video"), "video");
  add(extractMeta(html, "og:image"), "image");

  if (shortcode) {
    const targetObjects: Record<string, unknown>[] = [];
    const scriptMatches = html.matchAll(
      /<script\b[^>]*type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi,
    );

    for (const match of scriptMatches) {
      try {
        const payload = JSON.parse(match[1]);
        extractTargetObjects(payload, shortcode, targetObjects);
      } catch {
        // Some Instagram bootstrap scripts are not standalone JSON documents.
      }
    }

    for (const target of targetObjects) {
      collectMedia(target, media, seen, "image", true);
      if (media.length >= MAX_CAROUSEL_ITEMS) return media.slice(0, MAX_CAROUSEL_ITEMS);
    }
  }

  if (!shortcode || !media.length) {
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
      /["'](?:display_url|display_uri)["']\s*:\s*["']([^"']+)["']/gi,
    );
    for (const match of displayMatches) add(match[1], "image");
  }

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
  const path = getPostPath(url).replace(/\/$/, "");
  return `https://www.instagram.com${path}/embed/captioned/`;
}

function getPageFetchUrl(url: URL) {
  const pageUrl = new URL(`https://www.instagram.com${getPostPath(url)}`);
  pageUrl.searchParams.set("hl", url.searchParams.get("hl") ?? "en");
  pageUrl.searchParams.set("img_index", url.searchParams.get("img_index") ?? "1");
  return pageUrl.toString();
}

function getMediaEndpointUrl(url: URL, index: number) {
  const path = getPostPath(url).replace(/\/$/, "");
  return `https://www.instagram.com${path}/media/?size=l&img_index=${index}`;
}

function getPostPath(url: URL) {
  const segments = url.pathname.replace(/^\/+|\/+$/g, "").split("/").filter(Boolean);
  const markerIndex = segments.findIndex((segment) =>
    ["p", "reel", "tv", "stories"].includes(segment),
  );

  if (markerIndex >= 0 && segments[markerIndex + 1]) {
    const length = segments[markerIndex] === "stories" ? 3 : 2;
    return `/${segments.slice(markerIndex, markerIndex + length).join("/")}`;
  }

  return `/${segments.join("/")}`;
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

  const firstMedia = await fetchMediaEndpoint(getMediaEndpointUrl(url, 0));
  return firstMedia ? [firstMedia] : [];
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

    const canonicalUrl = `https://www.instagram.com${getPostPath(sourceUrl)}`;
    const embedUrl = getEmbedUrl(sourceUrl);
    const fetchTargets = [getPageFetchUrl(sourceUrl), embedUrl];
    const [htmlChunks, endpointMedia] = await Promise.all([
      Promise.all(fetchTargets.map(fetchHtml)),
      fetchCarouselMedia(sourceUrl),
    ]);
    const html = htmlChunks.join("\n");
    const media = mergeMedia(endpointMedia, extractMedia(html, sourceUrl.pathname.split("/").filter(Boolean).pop()));
    const caption = extractMeta(html, "og:description");
    const title = extractMeta(html, "og:title");
    const discoveredCanonical = extractCanonical(html);

    if (new URL(request.url).searchParams.get("debug") === "1") {
      const debugTargets: Record<string, unknown>[] = [];
      let debugScriptCount = 0;
      let debugParsedScriptCount = 0;
      let debugParseError = "";
      const debugScriptMatches = html.matchAll(
        /<script\b[^>]*type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi,
      );
      for (const match of debugScriptMatches) {
        debugScriptCount += 1;
        try {
          extractTargetObjects(JSON.parse(match[1]), sourceUrl.pathname.split("/").filter(Boolean).pop() ?? "", debugTargets);
          debugParsedScriptCount += 1;
        } catch (error) {
          debugParseError ||= error instanceof Error ? error.message : "unknown parse error";
        }
      }

      return NextResponse.json({
        htmlLengths: htmlChunks.map((chunk) => chunk.length),
        hasShortcode: html.includes(sourceUrl.pathname.split("/").filter(Boolean).pop() ?? ""),
        carouselMarkerCount: (html.match(/carousel_media/g) ?? []).length,
        mediaCount: media.length,
        scriptCount: debugScriptCount,
        parsedScriptCount: debugParsedScriptCount,
        targetObjectCount: debugTargets.length,
        parseError: debugParseError,
      });
    }

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
