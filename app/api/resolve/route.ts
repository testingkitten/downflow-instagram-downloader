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

function decodeEscapedUnicode(value: string) {
  return value.replace(/\\u([0-9a-f]{4})/gi, (_, code: string) =>
    String.fromCharCode(Number.parseInt(code, 16)),
  );
}

function cleanValue(value: string) {
  return decodeEscapedUnicode(value)
    .replace(/\\(["'])/g, "$1")
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

function extractUsername(html: string, description?: string) {
  const descriptionMatch = description?.match(/-\s*([a-z0-9._-]{1,50})\s+on\s+/i);
  if (descriptionMatch?.[1]) return descriptionMatch[1];

  const ownerMatch = html.match(
    /["\\']owner["\\']\s*:\s*\{[\s\S]{0,600}?["\\']username["\\']\s*:\s*["\\']([^"\\']+)["\\']/i,
  );
  if (ownerMatch?.[1]) return ownerMatch[1];

  const usernameMatch = html.match(
    /["\\']username["\\']\s*:\s*["\\']([a-z0-9._-]{1,50})["\\']/i,
  );
  return usernameMatch?.[1];
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
    const imagePath = /\/v\/t51\.[^/]+-15\//i.test(url.pathname);
    const videoPath =
      /\/v\/t2\//i.test(url.pathname) && /\.(mp4|mov|m4v)(?:$|[?#])/i.test(value);
    return (
      isMediaUrl(value) &&
      (/^scontent(?:[.-])/i.test(host) || host.endsWith(".fbcdn.net")) &&
      (imagePath || videoPath)
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

function mediaQualityScore(value: string) {
  try {
    const url = new URL(value);
    const source = `${url.pathname}${url.search}`;
    const sizedCandidates = [
      ...source.matchAll(/(?:^|[_=&])s(\d{2,5})x(\d{2,5})(?:_|&|$)/gi),
    ];
    const oneDimensionalCandidates = [
      ...source.matchAll(/(?:^|[_=&])(?:w|h)(\d{2,5})(?:_|&|$)/gi),
    ];

    if (!sizedCandidates.length && !oneDimensionalCandidates.length) {
      // Instagram's original rendition usually has no resize marker. Keep it
      // ahead of transformed s640/s1080 variants when both are available.
      return 1_000_000_000;
    }

    return Math.max(
      ...sizedCandidates.map((match) => {
        const width = Number(match[1]);
        const height = Number(match[2]);
        return Math.max(width, height) * 1_000 + width * height;
      }),
      ...oneDimensionalCandidates.map((match) => Number(match[1]) * 1_000),
    );
  } catch {
    return 0;
  }
}

function addMediaCandidate(
  rawValue: string,
  media: MediaItem[],
  seen: Map<string, number>,
  fallbackType: MediaItem["type"],
  thumbnailUrl?: string,
) {
  const url = cleanValue(rawValue);
  if (!isPostMediaUrl(url)) return;

  const key = mediaKey(url);
  const score = mediaQualityScore(url);
  const existingScore = seen.get(key);
  const existingIndex = media.findIndex((item) => mediaKey(item.url) === key);
  const cleanThumbnail = thumbnailUrl && isPostMediaUrl(thumbnailUrl)
    ? cleanValue(thumbnailUrl)
    : undefined;

  if (existingIndex >= 0) {
    if (existingScore !== undefined && score <= existingScore) return;
    const previousThumbnail = media[existingIndex].thumbnailUrl;
    const type = inferMediaType(url, fallbackType);
    media[existingIndex] = {
      type,
      url,
      ...(type === "video" && (cleanThumbnail || previousThumbnail)
        ? { thumbnailUrl: cleanThumbnail ?? previousThumbnail }
        : {}),
    };
    seen.set(key, score);
    return;
  }

  const type = inferMediaType(url, fallbackType);
  seen.set(key, score);
  media.push({
    type,
    url,
    ...(type === "video" && cleanThumbnail ? { thumbnailUrl: cleanThumbnail } : {}),
  });
}

function extractHighestQualityVideoUrls(html: string) {
  const normalizedHtml = cleanValue(html);
  const matches = normalizedHtml.matchAll(
    /FBQualityLabel\s*=\s*["']?(\d+)p["']?[\s\S]{0,1800}?<BaseURL>\s*(https:\/\/[^<>"'\s]+?\.mp4[^<>"'\s]*)\s*<\/BaseURL>/gi,
  );
  const selectedUrls: string[] = [];
  let currentUrl: string | undefined;
  let currentQuality = 0;
  let previousQuality = 0;

  for (const match of matches) {
    const quality = Number(match[1]);
    const url = cleanValue(match[2]);
    if (!isPostMediaUrl(url)) continue;

    // Instagram lists one video's representations in ascending quality. A
    // quality reset marks the next carousel item, so retain only its largest
    // representation instead of exposing every low-resolution variant.
    if (currentUrl && quality <= previousQuality) {
      selectedUrls.push(currentUrl);
      currentUrl = undefined;
      currentQuality = 0;
    }

    if (!currentUrl || quality >= currentQuality) {
      currentUrl = url;
      currentQuality = quality;
    }
    previousQuality = quality;
  }

  if (currentUrl) selectedUrls.push(currentUrl);
  return selectedUrls.slice(0, MAX_CAROUSEL_ITEMS);
}

function isVideoCoverUrl(value: string) {
  try {
    const url = new URL(value);
    const query = decodeURIComponent(url.search);
    if (/video[_-]?default[_-]?cover[_-]?frame|video[_-]?cover[_-]?frame/i.test(query)) {
      return true;
    }

    const encodedMetadata = url.searchParams.get("efg");
    if (encodedMetadata && typeof atob === "function") {
      const padded = encodedMetadata.replace(/-/g, "+").replace(/_/g, "/");
      const decodedMetadata = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, "="));
      return /video[_-]?default[_-]?cover[_-]?frame|video[_-]?cover[_-]?frame/i.test(
        decodedMetadata,
      );
    }
  } catch {
    return /video[_-]?default[_-]?cover[_-]?frame|video[_-]?cover[_-]?frame/i.test(value);
  }

  return false;
}

function collectMedia(
  value: unknown,
  media: MediaItem[],
  seen: Map<string, number>,
  fallbackType: MediaItem["type"] = "image",
  skipBranches = false,
  thumbnailUrl?: string,
) {
  if (typeof value === "string") {
    addMediaCandidate(value, media, seen, fallbackType, thumbnailUrl);
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectMedia(item, media, seen, fallbackType, skipBranches, thumbnailUrl);
    }
    return;
  }

  if (!value || typeof value !== "object") return;

  const record = value as Record<string, unknown>;
  const isVideoRecord =
    record.media_type === 2 ||
    Object.keys(record).some((key) =>
      /video_versions|video_url|playable_url|video_dash_manifest|video_duration/i.test(key),
    ) ||
    /video/i.test(String(record.__typename ?? record.__isXIGPolarisMedia ?? ""));
  const recordThumbnail = isVideoRecord
    ? Object.entries(record).find(
        ([key, child]) =>
          typeof child === "string" &&
          /display_uri|display_url|thumbnail/i.test(key) &&
          isPostMediaUrl(child),
      )?.[1] as string | undefined
    : thumbnailUrl;

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
      if (isVideoRecord && /display_uri|display_url|thumbnail/i.test(key)) continue;
      if (/url|uri|src|candidate/i.test(key)) {
        addMediaCandidate(child, media, seen, childType, recordThumbnail);
      }
      continue;
    }

    collectMedia(child, media, seen, childType, skipBranches, recordThumbnail);
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

function removeVideoThumbnails(media: MediaItem[]) {
  const thumbnailKeys = new Set(
    media
      .filter((item) => item.type === "video" && item.thumbnailUrl)
      .map((item) => mediaKey(item.thumbnailUrl as string)),
  );

  return media.filter(
    (item) =>
      item.type === "video" ||
      (!thumbnailKeys.has(mediaKey(item.url)) && !isVideoCoverUrl(item.url)),
  );
}

function extractMedia(html: string, shortcode?: string) {
  const media: MediaItem[] = [];
  const seen = new Map<string, number>();

  const add = (rawUrl: string | undefined, fallbackType: MediaItem["type"]) => {
    if (!rawUrl) return;
    addMediaCandidate(rawUrl, media, seen, fallbackType);
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
      if (media.length >= MAX_CAROUSEL_ITEMS) break;
    }
  }

  const highestQualityVideoUrls = extractHighestQualityVideoUrls(html);
  if (highestQualityVideoUrls.length) {
    const selectedVideoUrls = new Set(highestQualityVideoUrls);
    for (let index = media.length - 1; index >= 0; index -= 1) {
      if (media[index].type === "video" && !selectedVideoUrls.has(media[index].url)) {
        media.splice(index, 1);
      }
    }
  }
  for (const url of highestQualityVideoUrls) add(url, "video");

  const restrictFallback = media.length > 0;
  const knownMediaKeys = new Set(media.map((item) => mediaKey(item.url)));
  const addFallback = (rawUrl: string | undefined, fallbackType: MediaItem["type"]) => {
    if (!rawUrl) return;
    const cleanedUrl = cleanValue(rawUrl);
    if (
      restrictFallback &&
      fallbackType !== "video" &&
      !knownMediaKeys.has(mediaKey(cleanedUrl))
    ) {
      return;
    }
    add(cleanedUrl, fallbackType);
  };

  {
    const directMatches = html.matchAll(
      /https?:\\?\/\\?\/[^"'\\\s<>]+?\.(?:jpe?g|png|webp|mp4)(?:\?[^"'\\\s<>]*)?/gi,
    );
    for (const match of directMatches) {
      const url = cleanValue(match[0]);
      if (highestQualityVideoUrls.length && inferMediaType(url) === "video") continue;
      if (isPostMediaUrl(url)) addFallback(url, inferMediaType(url));
    }

    if (!highestQualityVideoUrls.length) {
      const videoMatches = html.matchAll(
        /["'](?:video_url|playable_url|video_versions)["']\s*:\s*["']([^"']+)["']/gi,
      );
      for (const match of videoMatches) addFallback(match[1], "video");
    }

    const displayMatches = html.matchAll(
      /["'](?:display_url|display_uri)["']\s*:\s*["']([^"']+)["']/gi,
    );
    for (const match of displayMatches) addFallback(match[1], "image");
  }

  return removeVideoThumbnails(media).slice(0, MAX_CAROUSEL_ITEMS);
}

function getPostKind(pathname: string) {
  const segments = pathname.replace(/^\/+|\/+$/g, "").split("/");
  const marker = segments.find((segment) => ["p", "reel", "tv", "stories"].includes(segment));
  if (marker === "reel") return "reel";
  if (marker === "tv") return "video";
  if (marker === "stories") return "story";
  if (marker === "p") return "post";
  return "link";
}

function getSourceIdentity(value: string, fallbackUsername?: string, fallbackId?: string) {
  try {
    const segments = new URL(value).pathname
      .replace(/^\/+|\/+$/g, "")
      .split("/")
      .filter(Boolean);
    const markerIndex = segments.findIndex((segment) =>
      ["p", "reel", "tv", "stories"].includes(segment),
    );
    const marker = segments[markerIndex];
    const pathUsername =
      marker === "stories"
        ? segments[markerIndex + 1]
        : markerIndex > 0
          ? segments[markerIndex - 1]
          : undefined;
    const username = pathUsername ?? fallbackUsername ?? "instagram";
    const postId =
      fallbackId ?? segments[markerIndex + 1] ?? segments[segments.length - 1] ?? "media";

    return {
      sourceUsername: username || "instagram",
      sourceId: postId || "media",
    };
  } catch {
    return {
      sourceUsername: fallbackUsername ?? "instagram",
      sourceId: fallbackId ?? "media",
    };
  }
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
    const kind = getPostKind(sourceUrl.pathname);
    const shortcode = sourceUrl.pathname.split("/").filter(Boolean).pop();
    const pageHtml = await fetchHtml(getPageFetchUrl(sourceUrl));
    let html = pageHtml;
    let extractedMedia = extractMedia(pageHtml, shortcode);

    if (
      !extractedMedia.length ||
      (["reel", "video"].includes(kind) && !extractedMedia.some((item) => item.type === "video"))
    ) {
      const embedHtml = await fetchHtml(embedUrl);
      html = `${pageHtml}\n${embedHtml}`;
      extractedMedia = extractMedia(html, shortcode);
    }

    const caption = extractMeta(html, "og:description");
    const title = extractMeta(html, "og:title");
    const discoveredCanonical = extractCanonical(html);
    const resolvedCanonical = discoveredCanonical ?? canonicalUrl;
    let resolvedKind = kind;

    try {
      resolvedKind = getPostKind(new URL(resolvedCanonical, sourceUrl).pathname);
    } catch {
      // Keep the kind inferred from the submitted URL when canonical parsing fails.
    }

    const resolvedEmbedUrl = getEmbedUrl(new URL(resolvedCanonical, sourceUrl));
    const identity = getSourceIdentity(
      resolvedCanonical,
      extractUsername(html, caption),
      shortcode,
    );
    const endpointMedia = extractedMedia.length ? [] : await fetchCarouselMedia(sourceUrl);
    const media = extractedMedia.length
      ? ["reel", "video"].includes(resolvedKind)
        ? extractedMedia.filter((item) => item.type === "video")
        : extractedMedia
      : endpointMedia;

    if (!media.length) {
      return NextResponse.json({
        ok: true,
        status: "embed-only",
        kind: resolvedKind,
        canonicalUrl: resolvedCanonical,
        embedUrl: resolvedEmbedUrl,
        ...identity,
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
      kind: resolvedKind,
      canonicalUrl: resolvedCanonical,
      embedUrl: resolvedEmbedUrl,
      ...identity,
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
