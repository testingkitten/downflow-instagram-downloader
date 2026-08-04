import { NextResponse } from "next/server";

export const maxDuration = 20;

const INSTAGRAM_SOURCE_HOSTS = new Set([
  "instagram.com",
  "www.instagram.com",
  "instagr.am",
  "www.instagr.am",
]);

const TWITTER_SOURCE_HOSTS = new Set([
  "x.com",
  "www.x.com",
  "twitter.com",
  "www.twitter.com",
  "mobile.twitter.com",
  "m.twitter.com",
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

const API_REQUEST_HEADERS = {
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  "User-Agent": REQUEST_HEADERS["User-Agent"],
  "X-IG-App-ID": "936619743392459",
  "X-ASBD-ID": "129477",
  "X-IG-WWW-Claim": "0",
  "X-Requested-With": "XMLHttpRequest",
};

const UPSTREAM_TIMEOUT_MS = 6500;
const MAX_CAROUSEL_ITEMS = 20;

function jsonResponse(
  payload: unknown,
  options: { status?: number; browserTtl?: number; cdnTtl?: number } = {},
) {
  const { status = 200, browserTtl = 0, cdnTtl = 0 } = options;
  const headers = new Headers({
    "Cache-Control": cdnTtl > 0
      ? `public, max-age=${browserTtl}`
      : "private, no-store",
    // The resolver exposes public metadata and public CDN URLs so an installed
    // editor PWA on a different origin can import a shared social link.
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Accept, Content-Type",
  });

  if (cdnTtl > 0) {
    headers.set(
      "Vercel-CDN-Cache-Control",
      `public, max-age=${cdnTtl}, stale-while-revalidate=60`,
    );
  }

  return NextResponse.json(payload, { status, headers });
}

export function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Accept, Content-Type",
      "Access-Control-Max-Age": "86400",
    },
  });
}

function createTimedSignal(parentSignal?: AbortSignal) {
  const controller = new AbortController();
  const abortFromParent = () => controller.abort();
  const timeoutId = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

  if (parentSignal?.aborted) {
    controller.abort();
  } else {
    parentSignal?.addEventListener("abort", abortFromParent, { once: true });
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timeoutId);
      parentSignal?.removeEventListener("abort", abortFromParent);
    },
  };
}

type MediaItem = {
  type: "image" | "video";
  url: string;
  previewUrl?: string;
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

function extractInstagramUserId(html: string, username?: string) {
  const normalizedHtml = cleanValue(html);
  const userMatches = normalizedHtml.matchAll(
    /"xig_user_by_username"\s*:\s*\{\s*"pk"\s*:\s*"?(\d+)"?\s*,\s*"username"\s*:\s*"([^"]+)"/gi,
  );

  for (const match of userMatches) {
    if (!username || match[2].toLowerCase() === username.toLowerCase()) {
      return match[1];
    }
  }

  return (
    normalizedHtml.match(/"profile_id"\s*:\s*"(\d+)"/i)?.[1] ??
    normalizedHtml.match(/profilePage_(\d+)/i)?.[1]
  );
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
      /\/v\/t\d+\//i.test(url.pathname) && /\.(mp4|mov|m4v)(?:$|[?#])/i.test(value);
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

function decodeVideoMetadata(value: string) {
  try {
    const url = new URL(value);
    let encoded = url.searchParams.get("efg");
    if (!encoded) return "";

    for (let index = 0; index < 2; index += 1) {
      try {
        encoded = decodeURIComponent(encoded);
      } catch {
        break;
      }
    }

    const normalized = encoded.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    return atob(padded);
  } catch {
    return "";
  }
}

function isAudioBearingProgressiveVideoUrl(value: string) {
  const metadata = decodeVideoMetadata(value);
  return /xpv_progressive|dash_baseline/i.test(metadata);
}

function progressiveVideoItemKey(value: string) {
  const metadata = decodeVideoMetadata(value);
  const assetMatch = metadata.match(/"xpv_asset_id"\s*:\s*(\d+)/i);
  return assetMatch?.[1] ? `asset:${assetMatch[1]}` : mediaKey(value);
}

function progressiveVideoQualityScore(value: string) {
  const metadata = decodeVideoMetadata(value);
  const bitrateMatch = metadata.match(/"bitrate"\s*:\s*(\d+)/i);
  const resolutionMatch = metadata.match(/(?:^|[._-])(\d{3,4})(?:[._-]|$)/);
  const bitrate = bitrateMatch ? Number(bitrateMatch[1]) : 0;
  const resolution = resolutionMatch ? Number(resolutionMatch[1]) : 0;
  return resolution * 1_000_000 + bitrate;
}

function extractAudioBearingProgressiveVideoUrls(html: string) {
  const normalizedHtml = cleanValue(html);
  const candidates = new Map<string, { url: string; score: number; order: number }>();

  const urlMatches = normalizedHtml.matchAll(
    /https?:\/\/[^"'\\\s<>]+?\.(?:mp4|mov|m4v)(?:\?[^"'\\\s<>]*)?/gi,
  );

  let order = 0;
  for (const match of urlMatches) {
    const url = cleanValue(match[0]);
    const itemKey = progressiveVideoItemKey(url);
    if (!isPostMediaUrl(url) || !isAudioBearingProgressiveVideoUrl(url)) {
      continue;
    }

    const score = progressiveVideoQualityScore(url);
    const existing = candidates.get(itemKey);
    if (!existing || score > existing.score) {
      candidates.set(itemKey, { url, score, order });
    }
    order += 1;
  }

  return [...candidates.values()]
    .sort((left, right) => left.order - right.order)
    .slice(0, MAX_CAROUSEL_ITEMS)
    .map((candidate) => candidate.url);
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

type StoryVariant = {
  url: string;
  width: number;
  height: number;
  bitrate: number;
};

function readStoryVariants(value: unknown): StoryVariant[] {
  if (typeof value === "string") {
    return [{ url: cleanValue(value), width: 0, height: 0, bitrate: 0 }];
  }

  if (!Array.isArray(value)) return [];

  return value.flatMap((candidate) => {
    if (typeof candidate === "string") {
      return [{ url: cleanValue(candidate), width: 0, height: 0, bitrate: 0 }];
    }

    if (!candidate || typeof candidate !== "object") return [];
    const record = candidate as Record<string, unknown>;
    if (typeof record.url !== "string") return [];

    const width = Number(record.width);
    const height = Number(record.height);
    const bitrate = Number(record.bitrate);
    return [
      {
        url: cleanValue(record.url),
        width: Number.isFinite(width) ? width : 0,
        height: Number.isFinite(height) ? height : 0,
        bitrate: Number.isFinite(bitrate) ? bitrate : 0,
      },
    ];
  });
}

function storyVariantScore(variant: StoryVariant) {
  return (
    Math.max(variant.width, variant.height) * 1_000_000 +
    variant.width * variant.height +
    variant.bitrate +
    mediaQualityScore(variant.url)
  );
}

function chooseStoryVariant(value: unknown, preferAudio = false) {
  const variants = readStoryVariants(value).filter((variant) => isPostMediaUrl(variant.url));
  if (!variants.length) return undefined;

  const audioVariants = preferAudio
    ? variants.filter((variant) => isAudioBearingProgressiveVideoUrl(variant.url))
    : [];
  const pool = audioVariants.length ? audioVariants : variants;
  return [...pool].sort((left, right) => storyVariantScore(right) - storyVariantScore(left))[0];
}

function extractStoryItemRecords(payload: unknown) {
  const items: Record<string, unknown>[] = [];

  const visit = (value: unknown) => {
    if (Array.isArray(value)) {
      for (const child of value) visit(child);
      return;
    }

    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    if (Array.isArray(record.items)) {
      for (const item of record.items) {
        if (item && typeof item === "object") items.push(item as Record<string, unknown>);
      }
    }

    for (const child of Object.values(record)) visit(child);
  };

  visit(payload);
  return items;
}

function extractStoryMedia(payload: unknown) {
  const media: MediaItem[] = [];
  const seen = new Map<string, number>();
  const itemKeys = new Set<string>();

  for (const item of extractStoryItemRecords(payload)) {
    const carouselMedia = Array.isArray(item.carousel_media)
      ? item.carousel_media.filter(
          (child): child is Record<string, unknown> =>
            Boolean(child) && typeof child === "object",
        )
      : [];
    const records = carouselMedia.length ? carouselMedia : [item];

    for (const record of records) {
      const itemKey = String(record.id ?? record.pk ?? record.code ?? "");
      if (itemKey && itemKeys.has(itemKey)) continue;
      if (itemKey) itemKeys.add(itemKey);

      const imageVersions =
        record.image_versions2 && typeof record.image_versions2 === "object"
          ? (record.image_versions2 as Record<string, unknown>).candidates
          : undefined;
      const imageVariant = chooseStoryVariant(imageVersions);
      const videoVariant = chooseStoryVariant(
        record.video_versions ?? record.video_url,
        true,
      );
      const isVideo =
        Number(record.media_type) === 2 ||
        Boolean(videoVariant) ||
        typeof record.video_url === "string";

      if (isVideo && videoVariant) {
        addMediaCandidate(
          videoVariant.url,
          media,
          seen,
          "video",
          imageVariant?.url,
        );
      } else if (!isVideo && imageVariant) {
        addMediaCandidate(imageVariant.url, media, seen, "image");
      }

      if (media.length >= MAX_CAROUSEL_ITEMS) return media;
    }
  }

  return removeVideoThumbnails(media).slice(0, MAX_CAROUSEL_ITEMS);
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

  const progressiveVideoUrls = extractAudioBearingProgressiveVideoUrls(html);
  const highestQualityVideoUrls = extractHighestQualityVideoUrls(html);
  const preferredVideoUrls = progressiveVideoUrls.length
    ? progressiveVideoUrls
    : highestQualityVideoUrls;

  if (preferredVideoUrls.length) {
    const selectedVideoKeys = new Set(preferredVideoUrls.map((url) => mediaKey(url)));
    for (let index = media.length - 1; index >= 0; index -= 1) {
      if (
        media[index].type === "video" &&
        !selectedVideoKeys.has(mediaKey(media[index].url))
      ) {
        media.splice(index, 1);
      }
    }
  }
  for (const url of preferredVideoUrls) add(url, "video");

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

function getStoryUsername(url: URL) {
  const segments = url.pathname.replace(/^\/+|\/+$/g, "").split("/").filter(Boolean);
  const markerIndex = segments.findIndex((segment) => segment === "stories");
  const username = segments[markerIndex + 1];
  return markerIndex >= 0 && username && username !== "highlights" ? username : undefined;
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
        ? segments[markerIndex + 1] === "highlights"
          ? undefined
          : segments[markerIndex + 1]
        : markerIndex > 0
          ? segments[markerIndex - 1]
          : undefined;
    const username = pathUsername ?? fallbackUsername ?? "instagram";
    const storyId =
      marker === "stories" && segments[markerIndex + 1] === "highlights"
        ? segments[markerIndex + 2]
        : segments[markerIndex + 1];
    const postId =
      fallbackId ?? storyId ?? segments[segments.length - 1] ?? "media";

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

function getStoryProfileFetchUrl(url: URL) {
  const username = getStoryUsername(url);
  if (!username) return undefined;

  const profileUrl = new URL(`https://www.instagram.com/${username}/`);
  profileUrl.searchParams.set("hl", url.searchParams.get("hl") ?? "en");
  return profileUrl.toString();
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

async function fetchHtml(target: string, parentSignal?: AbortSignal) {
  const timedSignal = createTimedSignal(parentSignal);

  try {
    const response = await fetch(target, {
      headers: REQUEST_HEADERS,
      redirect: "follow",
      cache: "no-store",
      signal: timedSignal.signal,
    });
    return response.ok ? await response.text() : "";
  } catch {
    return "";
  } finally {
    timedSignal.cleanup();
  }
}

async function fetchJson(target: string, referer: string, parentSignal?: AbortSignal) {
  const timedSignal = createTimedSignal(parentSignal);

  try {
    const response = await fetch(target, {
      headers: { ...API_REQUEST_HEADERS, Referer: referer },
      redirect: "follow",
      cache: "no-store",
      signal: timedSignal.signal,
    });
    if (!response.ok) return undefined;
    return (await response.json()) as unknown;
  } catch {
    return undefined;
  } finally {
    timedSignal.cleanup();
  }
}

async function fetchStoryMedia(url: URL, pageHtml: string, parentSignal?: AbortSignal) {
  const username = getStoryUsername(url);
  const profileUrl = getStoryProfileFetchUrl(url);
  if (!username || !profileUrl) return [];

  let userId = extractInstagramUserId(pageHtml, username);
  let profileHtml = pageHtml;
  if (!userId) {
    profileHtml = await fetchHtml(profileUrl, parentSignal);
    userId = extractInstagramUserId(profileHtml, username);
  }
  if (!userId) return [];

  const endpoint =
    `https://www.instagram.com/api/v1/feed/reels_media/?reel_ids=${encodeURIComponent(userId)}`;
  const payload = await fetchJson(endpoint, profileUrl, parentSignal);
  return extractStoryMedia(payload);
}

async function fetchMediaEndpoint(
  target: string,
  parentSignal?: AbortSignal,
): Promise<MediaItem | undefined> {
  const timedSignal = createTimedSignal(parentSignal);

  try {
    const response = await fetch(target, {
      headers: REQUEST_HEADERS,
      redirect: "follow",
      cache: "no-store",
      signal: timedSignal.signal,
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
    timedSignal.cleanup();
  }
}

async function fetchCarouselMedia(url: URL, parentSignal?: AbortSignal) {
  if (getPostKind(url.pathname) === "story") return [];

  const firstMedia = await fetchMediaEndpoint(getMediaEndpointUrl(url, 0), parentSignal);
  return firstMedia ? [firstMedia] : [];
}

type TwitterPostIdentity = {
  id: string;
  username?: string;
};

function getTwitterPostIdentity(url: URL): TwitterPostIdentity | undefined {
  const segments = url.pathname.replace(/^\/+|\/+$/g, "").split("/").filter(Boolean);
  const statusIndex = segments.findIndex((segment) =>
    ["status", "statuses"].includes(segment.toLowerCase()),
  );
  const id = segments[statusIndex + 1];
  if (statusIndex < 0 || !/^\d{5,25}$/.test(id ?? "")) return undefined;

  const candidate = segments[statusIndex - 1];
  const username =
    candidate && !["i", "web"].includes(candidate.toLowerCase())
      ? candidate.replace(/^@/, "")
      : undefined;

  return { id, username };
}

function isTwitterMediaUrl(value: string) {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      ["pbs.twimg.com", "video.twimg.com"].includes(url.hostname.toLowerCase())
    );
  } catch {
    return false;
  }
}

function normalizeTwitterImageUrl(value: string) {
  const cleaned = cleanValue(value);
  try {
    const url = new URL(cleaned);
    if (url.hostname.toLowerCase() !== "pbs.twimg.com") return cleaned;

    const match = url.pathname.match(
      /^\/media\/([^/. :]+)(?:\.([a-z0-9]+))?(?::(?:small|medium|large|orig))?$/i,
    );
    if (!match) return cleaned;

    const format = (url.searchParams.get("format") ?? match[2] ?? "jpg").toLowerCase();
    url.pathname = `/media/${match[1]}`;
    url.search = "";
    url.searchParams.set("format", format);
    url.searchParams.set("name", "orig");
    return url.toString();
  } catch {
    return cleaned;
  }
}

function readTwitterStreamRecord(html: string, key: string) {
  const marker = `"${key}":$R[`;
  const markerIndex = html.indexOf(marker);
  if (markerIndex < 0) return undefined;

  const objectStart = html.indexOf("={", markerIndex + marker.length);
  if (objectStart < 0) return undefined;

  const objectEnd = html.indexOf("},\"", objectStart + 2);
  if (objectEnd < 0) return undefined;
  return html.slice(objectStart + 2, objectEnd + 1);
}

function readTwitterStringField(record: string, field: string) {
  const match = record.match(new RegExp(`(?:^|,)${field}:"([^"\\r\\n]+)"`, "i"));
  return match?.[1] ? cleanValue(match[1]) : undefined;
}

function readTwitterNumberField(record: string, field: string) {
  const match = record.match(new RegExp(`(?:^|,)${field}:(\\d+)`, "i"));
  return match?.[1] ? Number(match[1]) : 0;
}

function twitterVideoDimensions(value: string) {
  const resolution = value.match(/\/vid\/(?:[^/]+\/)?(\d{2,5})x(\d{2,5})\//i);
  if (!resolution) return undefined;
  return { width: Number(resolution[1]), height: Number(resolution[2]) };
}

function twitterVideoQualityScore(value: string, bitrate: number) {
  const dimensions = twitterVideoDimensions(value);
  const area = dimensions ? dimensions.width * dimensions.height : 0;
  return area * 10_000_000 + bitrate;
}

function extractTwitterMedia(html: string, postId: string) {
  const media: MediaItem[] = [];
  const tweetToken = Buffer.from(`Tweet:${postId}`).toString("base64");
  const mediaPrefix = `client:${tweetToken}:media_entities2:`;

  for (let index = 0; index < MAX_CAROUSEL_ITEMS; index += 1) {
    const record = readTwitterStreamRecord(html, `${mediaPrefix}${index}`);
    if (!record) continue;

    const sourceType = readTwitterStringField(record, "type")?.toLowerCase();
    const rawThumbnail = readTwitterStringField(record, "media_url_https");
    const thumbnailUrl = rawThumbnail && isTwitterMediaUrl(rawThumbnail)
      ? normalizeTwitterImageUrl(rawThumbnail)
      : undefined;

    if (sourceType === "photo" && thumbnailUrl) {
      media.push({ type: "image", url: thumbnailUrl });
      continue;
    }

    if (sourceType !== "video" && sourceType !== "animated_gif") continue;

    let bestVideo: { url: string; score: number } | undefined;
    let bestPreview: { url: string; score: number } | undefined;
    for (let variantIndex = 0; variantIndex < 24; variantIndex += 1) {
      const variant = readTwitterStreamRecord(
        html,
        `${mediaPrefix}${index}:video_info:variants:${variantIndex}`,
      );
      if (!variant) continue;

      const contentType = readTwitterStringField(variant, "content_type");
      const rawUrl = readTwitterStringField(variant, "url");
      if (contentType !== "video/mp4" || !rawUrl || !isTwitterMediaUrl(rawUrl)) continue;

      const bitrate = readTwitterNumberField(variant, "bitrate");
      const score = twitterVideoQualityScore(rawUrl, bitrate);
      if (!bestVideo || score > bestVideo.score) bestVideo = { url: rawUrl, score };

      const dimensions = twitterVideoDimensions(rawUrl);
      if (
        dimensions &&
        Math.max(dimensions.width, dimensions.height) <= 960 &&
        (!bestPreview || score > bestPreview.score)
      ) {
        bestPreview = { url: rawUrl, score };
      }
    }

    if (bestVideo) {
      const previewUrl = bestPreview?.url ?? bestVideo.url;
      media.push({
        type: "video",
        url: bestVideo.url,
        ...(previewUrl !== bestVideo.url ? { previewUrl } : {}),
        ...(thumbnailUrl ? { thumbnailUrl } : {}),
      });
    }
  }

  if (!media.length) {
    const fallbackImage = extractMeta(html, "og:image");
    if (fallbackImage && /pbs\.twimg\.com\/media\//i.test(fallbackImage)) {
      const normalized = normalizeTwitterImageUrl(fallbackImage);
      if (isTwitterMediaUrl(normalized)) media.push({ type: "image", url: normalized });
    }
  }

  return media;
}

function getQuotedTwitterPostId(html: string, postId: string) {
  const tweetToken = Buffer.from(`Tweet:${postId}`).toString("base64");
  const record = readTwitterStreamRecord(html, tweetToken);
  return record?.match(
    /quoted_tweet_results:[\s\S]{0,160}?__ref:"TweetResults:(\d{5,25})"/i,
  )?.[1];
}

function getTwitterUsername(html: string, fallback?: string) {
  const canonical = extractMeta(html, "og:url") ?? extractCanonical(html);
  if (canonical) {
    try {
      const identity = getTwitterPostIdentity(new URL(canonical));
      if (identity?.username) return identity.username;
    } catch {
      // Fall through to the title or submitted path.
    }
  }

  const title = extractMeta(html, "og:title");
  return title?.match(/\(@([a-z0-9_]{1,50})\)\s+on\s+X/i)?.[1] ?? fallback;
}

function getTwitterCanonicalUrl(html: string, identity: TwitterPostIdentity) {
  const discovered = extractMeta(html, "og:url") ?? extractCanonical(html);
  if (discovered) {
    try {
      const candidate = new URL(discovered);
      const candidateIdentity = getTwitterPostIdentity(candidate);
      if (
        TWITTER_SOURCE_HOSTS.has(candidate.hostname.toLowerCase()) &&
        candidateIdentity?.id === identity.id
      ) {
        const username = candidateIdentity.username ?? identity.username;
        return username
          ? `https://x.com/${username}/status/${identity.id}`
          : `https://x.com/i/web/status/${identity.id}`;
      }
    } catch {
      // Use the normalized submitted URL below.
    }
  }

  return identity.username
    ? `https://x.com/${identity.username}/status/${identity.id}`
    : `https://x.com/i/web/status/${identity.id}`;
}

async function resolveTwitterPost(sourceUrl: URL, requestSignal?: AbortSignal) {
  const submittedIdentity = getTwitterPostIdentity(sourceUrl);
  if (!submittedIdentity) {
    return jsonResponse(
      { error: "Use a full X or Twitter post link." },
      { status: 422 },
    );
  }

  const pageUrl = submittedIdentity.username
    ? `https://x.com/${submittedIdentity.username}/status/${submittedIdentity.id}`
    : `https://x.com/i/web/status/${submittedIdentity.id}`;
  let html = await fetchHtml(pageUrl, requestSignal);

  const targetToken = Buffer.from(`Tweet:${submittedIdentity.id}`).toString("base64");
  if (!html.includes(`client:${targetToken}:`) && submittedIdentity.username) {
    const fallbackHtml = await fetchHtml(
      `https://x.com/i/web/status/${submittedIdentity.id}`,
      requestSignal,
    );
    if (fallbackHtml.length > html.length) html = fallbackHtml;
  }

  let media = extractTwitterMedia(html, submittedIdentity.id);
  const quotedPostId = getQuotedTwitterPostId(html, submittedIdentity.id);
  if (!media.length && quotedPostId) {
    media = extractTwitterMedia(html, quotedPostId);
  }
  const sourceUsername = getTwitterUsername(html, submittedIdentity.username) ?? "x";
  const canonicalUrl = getTwitterCanonicalUrl(html, {
    ...submittedIdentity,
    username: sourceUsername,
  });
  const embedUrl =
    `https://platform.twitter.com/embed/Tweet.html?id=${submittedIdentity.id}&theme=light&dnt=true`;

  if (!media.length) {
    return jsonResponse({
      ok: true,
      status: "embed-only",
      platform: "twitter",
      kind: "post",
      canonicalUrl,
      embedUrl,
      sourceUsername,
      sourceId: submittedIdentity.id,
      media: [],
      message: "X did not expose downloadable media for this public post.",
    }, { browserTtl: 15, cdnTtl: 30 });
  }

  return jsonResponse({
    ok: true,
    status: "ready",
    platform: "twitter",
    kind: "post",
    canonicalUrl,
    embedUrl,
    sourceUsername,
    sourceId: submittedIdentity.id,
    media,
  }, { browserTtl: 60, cdnTtl: 300 });
}

export async function GET(request: Request) {
  try {
    const requestUrl = new URL(request.url);
    const input = requestUrl.searchParams.get("url")?.trim();
    if (!input) {
      return jsonResponse(
        { error: "Paste an Instagram or X link first." },
        { status: 400 },
      );
    }

    const sourceUrl = new URL(input);
    sourceUrl.search = "";
    sourceUrl.hash = "";
    const sourceHost = sourceUrl.hostname.toLowerCase();
    if (TWITTER_SOURCE_HOSTS.has(sourceHost)) {
      return resolveTwitterPost(sourceUrl, request.signal);
    }

    if (!INSTAGRAM_SOURCE_HOSTS.has(sourceHost)) {
      return jsonResponse(
        { error: "Use a link from Instagram, X, or Twitter." },
        { status: 422 },
      );
    }

    const canonicalUrl = `https://www.instagram.com${getPostPath(sourceUrl)}`;
    const embedUrl = getEmbedUrl(sourceUrl);
    const kind = getPostKind(sourceUrl.pathname);
    const shortcode = sourceUrl.pathname.split("/").filter(Boolean).pop();
    const pageHtml = await fetchHtml(getPageFetchUrl(sourceUrl), request.signal);
    let html = pageHtml;
    let extractedMedia = extractMedia(pageHtml, shortcode);

    if (kind === "story") {
      const storyMedia = await fetchStoryMedia(sourceUrl, pageHtml, request.signal);
      if (storyMedia.length) extractedMedia = storyMedia;
    }

    if (
      kind !== "story" &&
      (!extractedMedia.length ||
        (["reel", "video"].includes(kind) &&
          !extractedMedia.some((item) => item.type === "video")))
    ) {
      const embedHtml = await fetchHtml(embedUrl, request.signal);
      html = `${pageHtml}\n${embedHtml}`;
      extractedMedia = extractMedia(html, shortcode);
    }

    const caption = extractMeta(html, "og:description");
    const discoveredCanonical = extractCanonical(html);
    let resolvedCanonical = discoveredCanonical ?? canonicalUrl;

    try {
      const discoveredKind = getPostKind(new URL(resolvedCanonical, sourceUrl).pathname);
      if (kind !== "link" && discoveredKind === "link") resolvedCanonical = canonicalUrl;
    } catch {
      resolvedCanonical = canonicalUrl;
    }

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
    const endpointMedia = extractedMedia.length
      ? []
      : await fetchCarouselMedia(sourceUrl, request.signal);
    const media = extractedMedia.length
      ? ["reel", "video"].includes(resolvedKind)
        ? extractedMedia.filter((item) => item.type === "video")
        : extractedMedia
      : endpointMedia;

    if (!media.length) {
      return jsonResponse({
        ok: true,
        status: "embed-only",
        platform: "instagram",
        kind: resolvedKind,
        canonicalUrl: resolvedCanonical,
        embedUrl: resolvedEmbedUrl,
        ...identity,
        media: [],
        message:
          resolvedKind === "story"
            ? "Instagram did not expose an active public story for this account."
            : "Instagram did not expose a direct media URL to this request. The public embed is still available below.",
      }, resolvedKind === "story"
        ? { browserTtl: 0, cdnTtl: 10 }
        : { browserTtl: 15, cdnTtl: 30 });
    }

    return jsonResponse({
      ok: true,
      status: "ready",
      platform: "instagram",
      kind: resolvedKind,
      canonicalUrl: resolvedCanonical,
      embedUrl: resolvedEmbedUrl,
      ...identity,
      media,
    }, resolvedKind === "story"
      ? { browserTtl: 0, cdnTtl: 10 }
      : { browserTtl: 60, cdnTtl: 300 });
  } catch {
    return jsonResponse(
      { error: "That does not look like a valid Instagram or X link." },
      { status: 422 },
    );
  }
}
