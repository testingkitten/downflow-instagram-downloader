"use client";

import {
  CSSProperties,
  FormEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

type MediaItem = {
  type: "image" | "video";
  url: string;
  previewUrl?: string;
  thumbnailUrl?: string;
};

type ResolveResult = {
  ok: boolean;
  status: "ready" | "embed-only";
  platform: "instagram" | "twitter";
  kind: string;
  canonicalUrl: string;
  embedUrl: string;
  sourceUsername?: string;
  sourceId?: string;
  caption?: string;
  title?: string;
  media: MediaItem[];
  message?: string;
};

type DownloadSource = Pick<
  ResolveResult,
  "canonicalUrl" | "platform" | "sourceUsername" | "sourceId"
>;
type ViewState = "idle" | "loading" | "success" | "embed-only" | "error";
type DownloadPhase = "downloading" | "preparing" | "complete";
type DownloadProgressState = {
  current: number;
  total: number;
  percent: number;
  phase: DownloadPhase;
  indeterminate: boolean;
};
type DownloadProgressCallback = (loaded: number, total?: number) => void;
type ItemDownloadProgress = {
  phase: DownloadPhase;
  percent: number;
  indeterminate: boolean;
};
type MediaDimensions = {
  width: number;
  height: number;
};
type ResolveCacheEntry = {
  url: string;
  savedAt: number;
  result: ResolveResult;
};

const SUPPORTED_HOSTS = new Set([
  "instagram.com",
  "www.instagram.com",
  "instagr.am",
  "www.instagr.am",
  "x.com",
  "www.x.com",
  "twitter.com",
  "www.twitter.com",
  "mobile.twitter.com",
  "m.twitter.com",
]);
const AUTO_DOWNLOAD_STORAGE_KEY = "downflow:auto-download";
const RESOLVE_CACHE_STORAGE_KEY = "downflow:resolve-cache:v2";
const RESOLVE_CACHE_TTL_MS = 5 * 60 * 1000;
const RESOLVE_CACHE_MAX_ENTRIES = 8;
const ICON_PATHS = {
  "arrow-clockwise": "M240,56v48a8,8,0,0,1-8,8H184a8,8,0,0,1,0-16H211.4L184.81,71.64l-.25-.24a80,80,0,1,0-1.67,114.78,8,8,0,0,1,11,11.63A95.44,95.44,0,0,1,128,224h-1.32A96,96,0,1,1,195.75,60L224,85.8V56a8,8,0,1,1,16,0Z",
  "arrow-square-out": "M228,104a12,12,0,0,1-24,0V69l-59.51,59.51a12,12,0,0,1-17-17L187,52H152a12,12,0,0,1,0-24h64a12,12,0,0,1,12,12Zm-44,24a12,12,0,0,0-12,12v64H52V84h64a12,12,0,0,0,0-24H48A20,20,0,0,0,28,80V208a20,20,0,0,0,20,20H176a20,20,0,0,0,20-20V140A12,12,0,0,0,184,128Z",
  "arrow-up-right": "M204,64V168a12,12,0,0,1-24,0V93L72.49,200.49a12,12,0,0,1-17-17L163,76H88a12,12,0,0,1,0-24H192A12,12,0,0,1,204,64Z",
  clipboard: "M168,152a8,8,0,0,1-8,8H96a8,8,0,0,1,0-16h64A8,8,0,0,1,168,152Zm-8-40H96a8,8,0,0,0,0,16h64a8,8,0,0,0,0-16Zm56-64V216a16,16,0,0,1-16,16H56a16,16,0,0,1-16-16V48A16,16,0,0,1,56,32H92.26a47.92,47.92,0,0,1,71.48,0H200A16,16,0,0,1,216,48ZM96,64h64a32,32,0,0,0-64,0ZM200,48H173.25A47.93,47.93,0,0,1,176,64v8a8,8,0,0,1-8,8H88a8,8,0,0,1-8-8V64a47.93,47.93,0,0,1,2.75-16H56V216H200Z",
  check: "M229.66,77.66l-128,128a8,8,0,0,1-11.32,0l-56-56a8,8,0,0,1,11.32-11.32L96,188.69,218.34,66.34a8,8,0,0,1,11.32,11.32Z",
  download: "M228,144v64a12,12,0,0,1-12,12H40a12,12,0,0,1-12-12V144a12,12,0,0,1,24,0v52H204V144a12,12,0,0,1,24,0Zm-108.49,8.49a12,12,0,0,0,17,0l40-40a12,12,0,0,0-17-17L140,115V32a12,12,0,0,0-24,0v83L96.49,95.51a12,12,0,0,0-17,17Z",
  link: "M165.66,90.34a8,8,0,0,1,0,11.32l-64,64a8,8,0,0,1-11.32-11.32l64-64A8,8,0,0,1,165.66,90.34ZM215.6,40.4a56,56,0,0,0-79.2,0L106.34,70.45a8,8,0,0,0,11.32,11.32l30.06-30a40,40,0,0,1,56.57,56.56l-30.07,30.06a8,8,0,0,0,11.31,11.32L215.6,119.6a56,56,0,0,0,0-79.2ZM138.34,174.22l-30.06,30.06a40,40,0,1,1-56.56-56.57l30.05-30.05a8,8,0,0,0-11.32-11.32L40.4,136.4a56,56,0,0,0,79.2,79.2l30.06-30.07a8,8,0,0,0-11.32-11.31Z",
  "speaker-high": "M155.51,24.81a8,8,0,0,0-8.42.88L77.25,80H32A16,16,0,0,0,16,96v64a16,16,0,0,0,16,16H77.25l69.84,54.31A8,8,0,0,0,160,224V32A8,8,0,0,0,155.51,24.81ZM32,96H72v64H32ZM144,207.64,88,164.09V91.91l56-43.55Zm54-106.08a40,40,0,0,1,0,52.88,8,8,0,0,1-12-10.58,24,24,0,0,0,0-31.72,8,8,0,0,1,12-10.58ZM248,128a79.9,79.9,0,0,1-20.37,53.34,8,8,0,0,1-11.92-10.67,64,64,0,0,0,0-85.33,8,8,0,1,1,11.92-10.67A79.83,79.83,0,0,1,248,128Z",
  "speaker-slash": "M53.92,34.62A8,8,0,1,0,42.08,45.38L73.55,80H32A16,16,0,0,0,16,96v64a16,16,0,0,0,16,16H77.25l69.84,54.31A8,8,0,0,0,160,224V175.09l42.08,46.29a8,8,0,1,0,11.84-10.76ZM32,96H72v64H32ZM144,207.64,88,164.09V95.89l56,61.6Zm42-63.77a24,24,0,0,0,0-31.72,8,8,0,1,1,12-10.57,40,40,0,0,1,0,52.88,8,8,0,0,1-12-10.59Zm-80.16-76a8,8,0,0,1,1.4-11.23l39.85-31A8,8,0,0,1,160,32v74.83a8,8,0,0,1-16,0V48.36l-26.94,21A8,8,0,0,1,105.84,67.91ZM248,128a79.9,79.9,0,0,1-20.37,53.34,8,8,0,0,1-11.92-10.67,64,64,0,0,0,0-85.33,8,8,0,1,1,11.92-10.67A79.83,79.83,0,0,1,248,128Z",
  warning: "M128,24A104,104,0,1,0,232,128,104.11,104.11,0,0,0,128,24Zm-8,56a8,8,0,0,1,16,0v56a8,8,0,0,1-16,0Zm8,104a12,12,0,1,1,12-12A12,12,0,0,1,128,184Z",
  x: "M208.49,191.51a12,12,0,0,1-17,17L128,145,64.49,208.49a12,12,0,0,1-17-17L111,128,47.51,64.49a12,12,0,0,1,17-17L128,111l63.51-63.52a12,12,0,0,1,17,17L145,128Z",
} as const;

function Icon({
  name,
  size = 18,
  className,
}: {
  name: keyof typeof ICON_PATHS;
  size?: number;
  className?: string;
}) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      focusable="false"
      height={size}
      viewBox="0 0 256 256"
      width={size}
    >
      <path d={ICON_PATHS[name]} fill="currentColor" />
    </svg>
  );
}

function PlatformMark({ platform }: { platform: ResolveResult["platform"] | null }) {
  if (platform === "instagram") {
    return (
      <svg aria-hidden="true" className="platform-mark" focusable="false" viewBox="0 0 24 24">
        <rect x="3.25" y="3.25" width="17.5" height="17.5" rx="5.25" />
        <circle cx="12" cy="12" r="4.15" />
        <circle className="platform-mark-dot" cx="17.5" cy="6.7" r="1.05" />
      </svg>
    );
  }

  if (platform === "twitter") {
    return (
      <svg aria-hidden="true" className="platform-mark platform-mark-x" focusable="false" viewBox="0 0 24 24">
        <path d="M5 4.5h3.85l3.75 5.02 4.54-5.02H19l-5.56 6.16L19.5 19.5h-3.86l-4.08-5.58-5.03 5.58H4.68l6.03-6.72L5 4.5Zm3.02 1.35H6.96l9.36 12.3h1.08L8.02 5.85Z" />
      </svg>
    );
  }

  return <Icon className="field-icon" name="link" size={18} />;
}

function detectPlatform(value: string): ResolveResult["platform"] | null {
  const normalized = normalizeSharedMediaUrl(value);
  if (!normalized) return null;

  try {
    const hostname = new URL(normalized).hostname.toLowerCase();
    return hostname.includes("instagram") || hostname.includes("instagr.am")
      ? "instagram"
      : "twitter";
  } catch {
    return null;
  }
}

function normalizeMediaUrl(value: string) {
  try {
    const parsed = new URL(value.trim());
    const hostname = parsed.hostname.toLowerCase();
    if (!SUPPORTED_HOSTS.has(hostname)) return null;
    if (!["http:", "https:"].includes(parsed.protocol)) return null;
    parsed.protocol = "https:";
    parsed.hostname = hostname.includes("instagram") || hostname.includes("instagr.am")
      ? "www.instagram.com"
      : "x.com";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return null;
  }
}

function isStoryUrl(value: string) {
  try {
    return new URL(value).pathname.toLowerCase().includes("/stories/");
  } catch {
    return false;
  }
}

function readResolveCache() {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(RESOLVE_CACHE_STORAGE_KEY) ?? "[]");
    return Array.isArray(parsed) ? (parsed as ResolveCacheEntry[]) : [];
  } catch {
    return [];
  }
}

function getCachedResolveResult(url: string) {
  if (isStoryUrl(url)) return null;

  const now = Date.now();
  const entries = readResolveCache().filter(
    (entry) =>
      typeof entry?.url === "string" &&
      typeof entry?.savedAt === "number" &&
      now - entry.savedAt < RESOLVE_CACHE_TTL_MS &&
      entry.result?.status === "ready" &&
      Array.isArray(entry.result.media),
  );
  const match = entries.find((entry) => entry.url === url);

  try {
    window.localStorage.setItem(RESOLVE_CACHE_STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // Local caching is an optional optimization.
  }

  return match?.result ?? null;
}

function cacheResolveResult(url: string, result: ResolveResult) {
  if (isStoryUrl(url) || result.status !== "ready" || !result.media.length) return;

  const now = Date.now();
  const entries = readResolveCache()
    .filter(
      (entry) =>
        entry.url !== url &&
        typeof entry.savedAt === "number" &&
        now - entry.savedAt < RESOLVE_CACHE_TTL_MS,
    )
    .slice(0, RESOLVE_CACHE_MAX_ENTRIES - 1);

  try {
    window.localStorage.setItem(
      RESOLVE_CACHE_STORAGE_KEY,
      JSON.stringify([{ url, savedAt: now, result }, ...entries]),
    );
  } catch {
    // A full or unavailable localStorage must not block resolving media.
  }
}

function normalizeSharedMediaUrl(value: string | null) {
  if (!value?.trim()) return null;

  try {
    const parsed = new URL(value.trim());
    const redirectedUrl = parsed.searchParams.get("u");
    if (redirectedUrl) return normalizeSharedMediaUrl(redirectedUrl);
  } catch {
    // Shared text often contains a URL alongside other words.
  }

  const match = value.match(
    /https?:\/\/(?:www\.|mobile\.|m\.)?(?:instagram\.com|instagr\.am|x\.com|twitter\.com)\/[^\s<>"']+/i,
  );
  const candidate = (match?.[0] ?? value).replace(/[),.;!?]+$/g, "");
  return normalizeMediaUrl(candidate);
}

function getSharedMediaUrl() {
  const params = new URLSearchParams(window.location.search);
  for (const value of [params.get("url"), params.get("text"), params.get("title")]) {
    const normalized = normalizeSharedMediaUrl(value);
    if (normalized) return normalized;
  }
  return null;
}

function labelForKind(kind: string) {
  if (kind === "reel") return "reel";
  if (kind === "video") return "video";
  if (kind === "story") return "story";
  return "post";
}

function getGridShape(count: number, mobile = false) {
  if (count <= 1) return { columns: 1, rows: 1 };

  const columns = mobile
    ? count <= 12
      ? 2
      : count <= 18
        ? 3
        : 4
    : count === 4
      ? 2
      : count <= 3
        ? count
        : count <= 6
          ? 3
          : count <= 12
            ? 4
            : 5;

  return { columns, rows: Math.ceil(count / columns) };
}

function getQualityLabel(media: MediaItem, dimensions?: MediaDimensions) {
  const format = media.type === "video" ? "MP4" : "PNG";
  const encodedDimensions = media.type === "video"
    ? media.url.match(/\/vid\/(?:[^/]+\/)?(\d{2,5})x(\d{2,5})\//i)
    : null;
  const sourceDimensions = encodedDimensions
    ? { width: Number(encodedDimensions[1]), height: Number(encodedDimensions[2]) }
    : dimensions;

  if (!sourceDimensions?.width || !sourceDimensions.height) {
    return media.type === "video" ? `Highest · ${format}` : `Original · ${format}`;
  }

  return `${sourceDimensions.width}×${sourceDimensions.height} · ${format}`;
}

function getDownloadLabel(progress: DownloadProgressState | null) {
  if (!progress) return "Download all";
  if (progress.phase === "complete") return `Saved ${progress.total} / ${progress.total}`;
  if (progress.phase === "preparing") return `Preparing ${progress.current} / ${progress.total}`;
  return `Downloading ${progress.current} / ${progress.total}`;
}

function sanitizeFilePart(value: string) {
  return (
    value
      .replace(/[^a-z0-9._-]+/gi, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64) || "media"
  );
}

function randomToken() {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const values = new Uint32Array(6);

  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(values);
    return Array.from(values, (value) => alphabet[value % alphabet.length]).join("");
  }

  return Array.from({ length: 6 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");
}

function getSourceIdentity(source: DownloadSource) {
  let segments: string[] = [];
  try {
    segments = new URL(source.canonicalUrl).pathname
      .replace(/^\/+|\/+$/g, "")
      .split("/")
      .filter(Boolean);
  } catch {
    // Use the API-provided identity when the canonical URL cannot be parsed.
  }

  const markerIndex = segments.findIndex((segment) =>
    ["p", "reel", "tv", "stories", "status", "statuses"].includes(segment),
  );
  const marker = segments[markerIndex];
  const fallbackSource = source.platform === "twitter" ? "x" : "instagram";
  const fallbackUsername =
    marker === "stories"
      ? segments[markerIndex + 1]
      : ["status", "statuses"].includes(marker)
        ? ["i", "web"].includes((segments[markerIndex - 1] ?? "").toLowerCase())
          ? fallbackSource
          : segments[markerIndex - 1]
      : markerIndex > 0
        ? segments[markerIndex - 1]
        : fallbackSource;
  const fallbackId = segments[markerIndex + 1] ?? segments[segments.length - 1] ?? "media";

  return {
    username: sanitizeFilePart(source.sourceUsername ?? fallbackUsername ?? fallbackSource),
    postId: sanitizeFilePart(source.sourceId ?? fallbackId),
  };
}

function getDownloadBaseName(source: DownloadSource) {
  const identity = getSourceIdentity(source);
  return `${identity.username}-${identity.postId}-${randomToken()}`;
}

function getDownloadFileName(media: MediaItem, baseName: string) {
  return `${baseName}.${media.type === "video" ? "mp4" : "png"}`;
}

async function readResponseBlob(response: Response, onProgress: DownloadProgressCallback) {
  const contentType = response.headers.get("content-type") ?? undefined;
  const contentLength = Number(response.headers.get("content-length"));
  const total = Number.isFinite(contentLength) && contentLength > 0 ? contentLength : undefined;

  if (!response.body) {
    const blob = await response.blob();
    onProgress(blob.size, total ?? blob.size);
    return blob;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    chunks.push(value);
    loaded += value.byteLength;
    onProgress(loaded, total);
  }

  return new Blob(chunks as BlobPart[], { type: contentType });
}

async function fetchMediaBlob(media: MediaItem, onProgress: DownloadProgressCallback) {
  const directResponse = await fetch(media.url, {
    cache: "force-cache",
    credentials: "omit",
    mode: "cors",
    redirect: "follow",
  });
  const contentType = directResponse.headers.get("content-type") ?? "";
  const expectedType = media.type === "video" ? "video/" : "image/";

  if (!directResponse.ok || !contentType.startsWith(expectedType)) {
    throw new Error("The source blocked a direct browser download.");
  }

  return readResponseBlob(directResponse, onProgress);
}

async function prepareDownloadBlob(
  media: MediaItem,
  onProgress: DownloadProgressCallback,
  onPreparing: () => void,
) {
  const sourceBlob = await fetchMediaBlob(media, onProgress);
  if (media.type === "video") return sourceBlob;

  onPreparing();
  const sourceUrl = URL.createObjectURL(sourceBlob);
  try {
    const image = new Image();
    image.decoding = "async";
    image.src = sourceUrl;
    await image.decode();

    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d");
    if (!context || !canvas.width || !canvas.height) {
      throw new Error("Image could not be prepared as PNG");
    }

    context.drawImage(image, 0, 0);
    const png = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/png"),
    );
    if (!png) throw new Error("Image could not be prepared as PNG");
    return png;
  } finally {
    URL.revokeObjectURL(sourceUrl);
  }
}

export default function Home() {
  const [url, setUrl] = useState("");
  const [viewState, setViewState] = useState<ViewState>("idle");
  const [result, setResult] = useState<ResolveResult | null>(null);
  const [errorMessage, setErrorMessage] = useState("");
  const [downloadMessage, setDownloadMessage] = useState("");
  const [downloadProgress, setDownloadProgress] = useState<DownloadProgressState | null>(null);
  const [itemDownloadProgress, setItemDownloadProgress] = useState<
    Record<number, ItemDownloadProgress>
  >({});
  const [pasteState, setPasteState] = useState<"idle" | "pasting">("idle");
  const [autoDownloadEnabled, setAutoDownloadEnabled] = useState(false);
  const [autoDownloadPreferenceReady, setAutoDownloadPreferenceReady] = useState(false);
  const [shareDownloadComplete, setShareDownloadComplete] = useState(false);
  const [isShareLaunch, setIsShareLaunch] = useState(false);
  const debounceRef = useRef<number | null>(null);
  const requestRef = useRef<AbortController | null>(null);
  const lastLookupRef = useRef("");
  const inputRef = useRef<HTMLInputElement>(null);
  const pendingDownloadsRef = useRef<number[]>([]);
  const downloadSequenceRef = useRef(0);
  const progressResetRef = useRef<number | null>(null);
  const shareCloseRef = useRef<number | null>(null);
  const shareWakeLockRef = useRef<WakeLockSentinel | null>(null);
  const sharedLookupRef = useRef("");

  const releaseShareWakeLock = useCallback(() => {
    const wakeLock = shareWakeLockRef.current;
    shareWakeLockRef.current = null;
    if (wakeLock) void wakeLock.release().catch(() => undefined);
  }, []);

  const acquireShareWakeLock = useCallback(async () => {
    if (document.visibilityState !== "visible" || !navigator.wakeLock) return;
    if (shareWakeLockRef.current && !shareWakeLockRef.current.released) return;

    try {
      shareWakeLockRef.current = await navigator.wakeLock.request("screen");
    } catch {
      // Wake Lock is optional; the active fetch queue still keeps the PWA open.
    }
  }, []);

  useEffect(() => {
    try {
      setAutoDownloadEnabled(window.localStorage.getItem(AUTO_DOWNLOAD_STORAGE_KEY) === "true");
    } catch {
      setAutoDownloadEnabled(false);
    } finally {
      setAutoDownloadPreferenceReady(true);
    }
  }, []);

  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;

    const timeoutId = window.setTimeout(() => {
      void navigator.serviceWorker.register("/sw.js", { scope: "/" });
    }, 1500);

    return () => window.clearTimeout(timeoutId);
  }, []);

  useEffect(() => {
    document.documentElement.classList.toggle("share-handoff", isShareLaunch);
    return () => document.documentElement.classList.remove("share-handoff");
  }, [isShareLaunch]);

  useEffect(() => {
    return () => {
      downloadSequenceRef.current += 1;
      if (debounceRef.current) window.clearTimeout(debounceRef.current);
      requestRef.current?.abort();
      pendingDownloadsRef.current.forEach((timeoutId) => window.clearTimeout(timeoutId));
      if (progressResetRef.current) window.clearTimeout(progressResetRef.current);
      if (shareCloseRef.current) window.clearTimeout(shareCloseRef.current);
      releaseShareWakeLock();
    };
  }, [releaseShareWakeLock]);

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible" && isShareLaunch && !shareDownloadComplete) {
        void acquireShareWakeLock();
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, [acquireShareWakeLock, isShareLaunch, shareDownloadComplete]);

  const downloadMedia = useCallback(
    async (
      media: MediaItem,
      source: DownloadSource,
      index: number,
      total: number,
      isBatch = false,
    ) => {
      const baseName = getDownloadBaseName(source);
      const progressIndex = isBatch ? index : 0;
      const progressTotal = isBatch ? total : 1;
      if (progressResetRef.current) {
        window.clearTimeout(progressResetRef.current);
        progressResetRef.current = null;
      }

      const markComplete = () => {
        setItemDownloadProgress((previous) => ({
          ...previous,
          [index]: { phase: "complete", percent: 100, indeterminate: false },
        }));
        setDownloadProgress({
          current: progressIndex + 1,
          total: progressTotal,
          percent: ((progressIndex + 1) / progressTotal) * 100,
          phase: isBatch && index < total - 1 ? "downloading" : "complete",
          indeterminate: false,
        });

        if (!isBatch || index === total - 1) {
          progressResetRef.current = window.setTimeout(() => {
            setDownloadProgress(null);
            progressResetRef.current = null;
          }, 1400);
        }
      };

      setItemDownloadProgress((previous) => ({
        ...previous,
        [index]: { phase: "downloading", percent: 0, indeterminate: true },
      }));
      setDownloadProgress({
        current: progressIndex + 1,
        total: progressTotal,
        percent: (progressIndex / progressTotal) * 100,
        phase: "downloading",
        indeterminate: true,
      });

      try {
        const blob = await prepareDownloadBlob(
          media,
          (loaded, bytesTotal) => {
            const fraction = bytesTotal ? Math.min(loaded / bytesTotal, 1) : 0.12;
            setItemDownloadProgress((previous) => ({
              ...previous,
              [index]: {
                phase: "downloading",
                percent: Math.min(99, fraction * 100),
                indeterminate: !bytesTotal,
              },
            }));
            setDownloadProgress({
              current: progressIndex + 1,
              total: progressTotal,
              percent: Math.min(99, ((progressIndex + fraction) / progressTotal) * 100),
              phase: "downloading",
              indeterminate: !bytesTotal,
            });
          },
          () => {
            setItemDownloadProgress((previous) => ({
              ...previous,
              [index]: { phase: "preparing", percent: 94, indeterminate: false },
            }));
            setDownloadProgress((previous) => ({
              current: progressIndex + 1,
              total: progressTotal,
              percent: Math.max(
                previous?.percent ?? 0,
                ((progressIndex + 0.94) / progressTotal) * 100,
              ),
              phase: "preparing",
              indeterminate: false,
            }));
          },
        );
        const objectUrl = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = objectUrl;
        anchor.download = getDownloadFileName(media, baseName);
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        window.setTimeout(() => URL.revokeObjectURL(objectUrl), 10_000);
        setDownloadMessage("Saved from the source on this device.");
      } catch {
        window.open(media.url, "_blank", "noopener,noreferrer");
        setDownloadMessage("The source blocked local saving, so it was opened directly.");
      }

      markComplete();
    },
    [],
  );

  const queueDownloads = useCallback(
    (media: MediaItem[], source: DownloadSource) => {
      pendingDownloadsRef.current.forEach((timeoutId) => window.clearTimeout(timeoutId));
      pendingDownloadsRef.current = [];
      const sequence = ++downloadSequenceRef.current;

      setItemDownloadProgress({});
      setDownloadMessage("Downloads starting.");
      setDownloadProgress({
        current: 1,
        total: media.length,
        percent: 0,
        phase: "downloading",
        indeterminate: true,
      });

      const downloadNext = async (index: number) => {
        if (downloadSequenceRef.current !== sequence || !media[index]) return;

        await downloadMedia(media[index], source, index, media.length, true);
        if (downloadSequenceRef.current !== sequence) return;

        if (index === media.length - 1) {
          setDownloadMessage("Downloads complete.");
          return;
        }

        const timeoutId = window.setTimeout(() => {
          void downloadNext(index + 1);
        }, 650);
        pendingDownloadsRef.current.push(timeoutId);
      };

      void downloadNext(0);
    },
    [downloadMedia],
  );

  const handoffShareDownloads = useCallback(
    (media: MediaItem[], source: DownloadSource) => {
      pendingDownloadsRef.current.forEach((timeoutId) => window.clearTimeout(timeoutId));
      pendingDownloadsRef.current = [];
      const sequence = ++downloadSequenceRef.current;

      setItemDownloadProgress({});
      void acquireShareWakeLock();
      setDownloadMessage("Saving on this device.");
      setDownloadProgress({
        current: 1,
        total: media.length,
        percent: 0,
        phase: "downloading",
        indeterminate: true,
      });

      const handoffNext = async (index: number) => {
        if (downloadSequenceRef.current !== sequence || !media[index]) return;

        await downloadMedia(media[index], source, index, media.length, true);
        if (downloadSequenceRef.current !== sequence) return;

        const completed = index + 1;

        if (completed < media.length) {
          const timeoutId = window.setTimeout(() => void handoffNext(completed), 650);
          pendingDownloadsRef.current.push(timeoutId);
          return;
        }

        setDownloadMessage("Downloads saved on this device.");
        setShareDownloadComplete(true);

        if (shareCloseRef.current) window.clearTimeout(shareCloseRef.current);
        shareCloseRef.current = window.setTimeout(() => {
          releaseShareWakeLock();
          try {
            window.close();
          } catch {
            // Browsers may refuse to close a PWA window they did not open.
          }
          shareCloseRef.current = null;
        }, 2500);
      };

      void handoffNext(0);
    },
    [acquireShareWakeLock, downloadMedia, releaseShareWakeLock],
  );

  const resolveUrl = useCallback(
    async (rawValue: string, force = false, fromShare = false) => {
      const normalized = normalizeMediaUrl(rawValue);
      if (!normalized) {
        if (force) {
          setViewState("error");
          setErrorMessage("Use an Instagram or X link.");
        }
        return;
      }

      if (!force && lastLookupRef.current === normalized) return;
      lastLookupRef.current = normalized;
      requestRef.current?.abort();
      downloadSequenceRef.current += 1;
      pendingDownloadsRef.current.forEach((timeoutId) => window.clearTimeout(timeoutId));
      pendingDownloadsRef.current = [];
      const controller = new AbortController();
      requestRef.current = controller;
      if (progressResetRef.current) {
        window.clearTimeout(progressResetRef.current);
        progressResetRef.current = null;
      }
      setUrl(normalized);
      setResult(null);
      setErrorMessage("");
      setDownloadMessage("");
      setDownloadProgress(null);
      setItemDownloadProgress({});
      setShareDownloadComplete(false);
      if (!fromShare) setIsShareLaunch(false);
      setViewState("loading");

      try {
        let payload = getCachedResolveResult(normalized) as
          | (ResolveResult & { error?: string })
          | null;

        if (!payload) {
          const query = new URLSearchParams({ url: normalized });
          const response = await fetch(`/api/resolve?${query}`, {
            cache: "default",
            headers: { Accept: "application/json" },
            signal: controller.signal,
          });
          payload = (await response.json()) as ResolveResult & { error?: string };
          if (!response.ok) throw new Error(payload.error || "That link could not be read.");
          cacheResolveResult(normalized, payload);
        }

        setResult(payload);
        setViewState(payload.status === "ready" ? "success" : "embed-only");
        if (payload.status === "ready" && payload.media.length) {
          if (fromShare) {
            handoffShareDownloads(payload.media, payload);
          } else if (autoDownloadPreferenceReady && autoDownloadEnabled) {
            queueDownloads(payload.media, payload);
          }
        } else if (fromShare) {
          setIsShareLaunch(false);
        }
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        if (fromShare) setIsShareLaunch(false);
        setViewState("error");
        setErrorMessage(error instanceof Error ? error.message : "That link could not be read.");
      }
    },
    [autoDownloadEnabled, autoDownloadPreferenceReady, handoffShareDownloads, queueDownloads],
  );

  useEffect(() => {
    if (!autoDownloadPreferenceReady) return;
    const sharedUrl = getSharedMediaUrl();
    if (!sharedUrl || sharedLookupRef.current === sharedUrl) return;

    sharedLookupRef.current = sharedUrl;
    setIsShareLaunch(true);
    window.history.replaceState(null, "", window.location.pathname);
    void resolveUrl(sharedUrl, true, true);
  }, [autoDownloadPreferenceReady, resolveUrl]);

  const queueLookup = (value: string) => {
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
    if (!normalizeMediaUrl(value)) return;
    debounceRef.current = window.setTimeout(() => resolveUrl(value), 220);
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void resolveUrl(url, true);
  };

  const handlePaste = useCallback(async () => {
    setPasteState("pasting");
    setErrorMessage("");
    try {
      const clipboardText = await navigator.clipboard.readText();
      if (!clipboardText.trim()) throw new Error("The clipboard is empty.");
      setUrl(clipboardText);
      await resolveUrl(clipboardText, true);
    } catch (error) {
      setViewState("error");
      setErrorMessage(error instanceof Error ? error.message : "Clipboard access is unavailable.");
    } finally {
      setPasteState("idle");
    }
  }, [resolveUrl]);

  const downloadAllMedia = useCallback(
    (media: MediaItem[], source: DownloadSource) => {
      queueDownloads(media, source);
    },
    [queueDownloads],
  );

  const clearAll = useCallback(() => {
    requestRef.current?.abort();
    downloadSequenceRef.current += 1;
    lastLookupRef.current = "";
    pendingDownloadsRef.current.forEach((timeoutId) => window.clearTimeout(timeoutId));
    pendingDownloadsRef.current = [];
    sharedLookupRef.current = "";
    if (progressResetRef.current) {
      window.clearTimeout(progressResetRef.current);
      progressResetRef.current = null;
    }
    if (shareCloseRef.current) {
      window.clearTimeout(shareCloseRef.current);
      shareCloseRef.current = null;
    }
    releaseShareWakeLock();
    window.history.replaceState(null, "", window.location.pathname);
    setUrl("");
    setResult(null);
    setErrorMessage("");
    setDownloadMessage("");
    setDownloadProgress(null);
    setItemDownloadProgress({});
    setShareDownloadComplete(false);
    setIsShareLaunch(false);
    setViewState("idle");
    inputRef.current?.focus();
  }, [releaseShareWakeLock]);

  const toggleAutoDownload = () => {
    setAutoDownloadEnabled((previous) => {
      const next = !previous;
      try {
        window.localStorage.setItem(AUTO_DOWNLOAD_STORAGE_KEY, String(next));
      } catch {
        // Keep the in-memory toggle usable when storage is blocked.
      }
      return next;
    });
  };

  useEffect(() => {
    const handleKeyboardShortcut = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const isEditing =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        Boolean(target?.isContentEditable);
      const key = event.key.toLowerCase();

      if (event.key === "Escape") {
        if (document.querySelector(".media-lightbox")) {
          event.preventDefault();
          return;
        }
        if (url || viewState !== "idle") clearAll();
        return;
      }

      if ((event.metaKey || event.ctrlKey) && key === "v" && !isEditing) {
        event.preventDefault();
        void handlePaste();
        return;
      }

      if (
        key === "d" &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        !isEditing &&
        downloadProgress?.phase !== "downloading" &&
        downloadProgress?.phase !== "preparing" &&
        result?.status === "ready" &&
        result.media.length
      ) {
        event.preventDefault();
        downloadAllMedia(result.media, result);
      }
    };

    window.addEventListener("keydown", handleKeyboardShortcut);
    return () => window.removeEventListener("keydown", handleKeyboardShortcut);
  }, [clearAll, downloadAllMedia, downloadProgress?.phase, handlePaste, result, url, viewState]);

  const detectedPlatform = result?.platform ?? detectPlatform(url);
  const hasWorkspace = ["loading", "success", "embed-only"].includes(viewState);
  const isDownloading =
    downloadProgress?.phase === "downloading" || downloadProgress?.phase === "preparing";
  const sourceName = result?.sourceUsername
    ? `@${result.sourceUsername.replace(/^@/, "")}`
    : result?.platform === "twitter"
      ? "X"
      : "Instagram";

  return (
    <main
      className={`site-frame is-${viewState} ${hasWorkspace ? "has-workspace" : "is-idle-layout"} ${isShareLaunch ? "is-share-launch" : ""}`}
    >
      <nav className="topbar" aria-label="Primary">
        <button
          className="refresh-button"
          type="button"
          onClick={clearAll}
          aria-label="Clear and refresh"
          title="Clear and refresh"
        >
          <Icon name="arrow-clockwise" size={18} />
        </button>
        <a className="brand" href="#top" aria-label="Instagram Downloader home">
          <span className="brand-label">Instagram Downloader</span>
        </a>
        <div className="auto-download-control">
          <span className="auto-download-label">Auto</span>
          <button
            className={`auto-download-switch ${autoDownloadEnabled ? "is-on" : ""}`}
            type="button"
            role="switch"
            aria-checked={autoDownloadEnabled}
            aria-label="Auto-download"
            title={autoDownloadEnabled ? "Auto-download on" : "Auto-download off"}
            onClick={toggleAutoDownload}
          >
            <span className="auto-download-thumb" aria-hidden="true" />
          </button>
        </div>
      </nav>

      <section className="hero-grid" id="top">
        <div className="tool-stack">
          <div className="paste-zone">
            <form className="input-card" onSubmit={handleSubmit}>
              <label className="sr-only" htmlFor="instagram-url">
                Instagram or X link
              </label>
              <div
                className={`url-field ${viewState === "error" ? "has-error" : ""} ${detectedPlatform ? `is-${detectedPlatform}` : ""}`}
              >
                <span className="field-platform" aria-hidden="true">
                  <PlatformMark platform={detectedPlatform} />
                </span>
                <input
                  id="instagram-url"
                  ref={inputRef}
                  autoFocus
                  value={url}
                  onChange={(event) => {
                    const nextValue = event.target.value;
                    requestRef.current?.abort();
                    downloadSequenceRef.current += 1;
                    pendingDownloadsRef.current.forEach((timeoutId) => window.clearTimeout(timeoutId));
                    pendingDownloadsRef.current = [];
                    setUrl(nextValue);
                    setResult(null);
                    setErrorMessage("");
                    setDownloadProgress(null);
                    setItemDownloadProgress({});
                    setViewState("idle");
                    queueLookup(nextValue);
                  }}
                  placeholder="Paste link"
                  autoComplete="url"
                  spellCheck={false}
                  aria-invalid={viewState === "error"}
                  aria-keyshortcuts="Control+V Meta+V"
                />
                {url ? (
                  <button className="clear-button" type="button" onClick={clearAll} aria-label="Clear link">
                    <Icon name="x" size={17} />
                  </button>
                ) : null}
                <button
                  className="paste-button"
                  type="button"
                  onClick={handlePaste}
                  disabled={pasteState === "pasting" || viewState === "loading"}
                  aria-label={pasteState === "pasting" ? "Pasting link" : "Paste link"}
                  title={pasteState === "pasting" ? "Pasting link" : "Paste link"}
                >
                  <Icon name="clipboard" size={17} />
                </button>
              </div>
              {viewState === "error" ? (
                <p className="error-note" role="alert">
                  <Icon name="warning" size={15} />
                  {errorMessage}
                </p>
              ) : null}
            </form>
          </div>
        </div>
      </section>

      <section
        className={`workspace-section ${hasWorkspace ? "" : "is-empty"}`}
        aria-live="polite"
      >
        {result?.media.length ? (
          <div className="workspace-tools">
            <span className="workspace-label">
              <span>{sourceName}</span>
              <span aria-hidden="true">·</span>
              <span>{result.media.length} {result.media.length === 1 ? "item" : "items"}</span>
            </span>
            <span className="workspace-kind">{labelForKind(result.kind)}</span>
          </div>
        ) : null}

        {viewState === "loading" ? <LoadingState /> : null}
        {viewState === "success" && result ? (
          <ResultState
            result={result}
            onDownload={downloadMedia}
            itemDownloadProgress={itemDownloadProgress}
          />
        ) : null}
        {viewState === "embed-only" && result ? <EmbedOnlyState result={result} /> : null}
        {result?.media.length ? (
          <div className={`download-dock ${downloadProgress ? "is-active" : ""}`}>
            <button
              className="download-all-button"
              type="button"
              onClick={() => downloadAllMedia(result.media, result)}
              aria-label="Download all media"
              aria-keyshortcuts="D"
              title="Download all"
              disabled={isDownloading}
            >
              <Icon name={downloadProgress?.phase === "complete" ? "check" : "download"} size={17} />
              <span>{getDownloadLabel(downloadProgress)}</span>
            </button>
            {downloadProgress ? <DownloadProgressBar progress={downloadProgress} /> : null}
          </div>
        ) : null}
        {shareDownloadComplete ? (
          <p className="share-complete-note" role="status">
            Saved — return to {result?.platform === "twitter" ? "X" : "Instagram"}.
          </p>
        ) : null}
        {downloadMessage ? <p className="sr-only" role="status">{downloadMessage}</p> : null}
      </section>
    </main>
  );
}

function LoadingState() {
  return (
    <div className="loading-state" aria-label="Loading media preview">
      <span className="loading-dot" />
      <span className="loading-dot" />
      <span className="loading-dot" />
    </div>
  );
}

function DownloadProgressBar({ progress }: { progress: DownloadProgressState }) {
  const label =
    progress.phase === "preparing"
      ? "Preparing"
      : progress.phase === "complete"
        ? "Saved"
        : "Downloading";

  return (
    <div
      className="download-progress"
      role="status"
      aria-label={`${label} media ${progress.current} of ${progress.total}`}
    >
      <span className="sr-only">{label} media {progress.current} of {progress.total}</span>
      <div className="download-progress-track">
        <span
          className={progress.indeterminate ? "is-indeterminate" : ""}
          style={{ width: `${progress.percent}%` }}
        />
      </div>
    </div>
  );
}

function VideoPlayer({
  media,
  label,
  autoPlay,
  fallbackEmbedUrl,
  onMetadata,
}: {
  media: MediaItem;
  label: string;
  autoPlay: boolean;
  fallbackEmbedUrl?: string;
  onMetadata?: (dimensions: MediaDimensions) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const directPreviewUrl = media.previewUrl ?? media.url;
  const previewAbortRef = useRef<AbortController | null>(null);
  const previewObjectUrlRef = useRef<string | null>(null);
  const previewPlayAfterPrepareRef = useRef(false);
  const previewPreparingRef = useRef(false);
  const [muted, setMuted] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playbackUrl, setPlaybackUrl] = useState(directPreviewUrl);
  const [previewFailed, setPreviewFailed] = useState(false);

  const prepareLocalPreview = useCallback(async (playAfterPreparing: boolean) => {
    const video = videoRef.current;
    if (!video) return;
    if (playAfterPreparing) previewPlayAfterPrepareRef.current = true;

    if (previewObjectUrlRef.current) {
      if (previewPlayAfterPrepareRef.current) {
        previewPlayAfterPrepareRef.current = false;
        void video.play().catch(() => undefined);
      }
      return;
    }
    if (previewPreparingRef.current) return;

    previewPreparingRef.current = true;
    const controller = new AbortController();
    previewAbortRef.current = controller;

    try {
      const response = await fetch(directPreviewUrl, {
        cache: "force-cache",
        credentials: "omit",
        mode: "cors",
        signal: controller.signal,
      });
      const contentType = response.headers.get("content-type") ?? "";
      if (!response.ok || !contentType.startsWith("video/")) {
        throw new Error("The preview source was unavailable.");
      }

      const blob = await response.blob();
      if (controller.signal.aborted) return;

      const objectUrl = URL.createObjectURL(blob);
      previewObjectUrlRef.current = objectUrl;
      setPlaybackUrl(objectUrl);
      setPreviewFailed(false);
      video.src = objectUrl;
      video.load();
      if (previewPlayAfterPrepareRef.current) {
        previewPlayAfterPrepareRef.current = false;
        void video.play().catch(() => undefined);
      }
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        setPreviewFailed(true);
      }
    } finally {
      if (previewAbortRef.current === controller) previewAbortRef.current = null;
      previewPreparingRef.current = false;
    }
  }, [directPreviewUrl]);

  useEffect(() => {
    previewAbortRef.current?.abort();
    previewAbortRef.current = null;
    previewPlayAfterPrepareRef.current = false;
    previewPreparingRef.current = false;
    if (previewObjectUrlRef.current) URL.revokeObjectURL(previewObjectUrlRef.current);
    previewObjectUrlRef.current = null;
    setPlaybackUrl(directPreviewUrl);
    setPreviewFailed(false);
    setCurrentTime(0);
    setDuration(0);
    setMuted(false);

    const fallbackTimeout = autoPlay
      ? window.setTimeout(() => {
          if (videoRef.current?.readyState === 0) void prepareLocalPreview(true);
        }, 1200)
      : null;

    return () => {
      if (fallbackTimeout) window.clearTimeout(fallbackTimeout);
      previewAbortRef.current?.abort();
      previewAbortRef.current = null;
      previewPlayAfterPrepareRef.current = false;
      previewPreparingRef.current = false;
      if (previewObjectUrlRef.current) URL.revokeObjectURL(previewObjectUrlRef.current);
      previewObjectUrlRef.current = null;
    };
  }, [autoPlay, directPreviewUrl, prepareLocalPreview]);

  const togglePlayback = () => {
    const video = videoRef.current;
    if (!video) return;

    if (previewFailed || (video.readyState === 0 && !previewObjectUrlRef.current)) {
      setPreviewFailed(false);
      void prepareLocalPreview(true);
      return;
    }

    if (video.paused) {
      setPreviewFailed(false);
      void video.play().catch(() => undefined);
    } else {
      video.pause();
    }
  };

  const toggleMute = () => {
    const video = videoRef.current;
    if (!video) return;
    const nextMuted = !video.muted;
    video.muted = nextMuted;
    setMuted(nextMuted);
    if (!nextMuted && video.paused) {
      void video.play().catch(() => undefined);
    }
  };

  const progress = duration ? Math.min((currentTime / duration) * 100, 100) : 0;
  const useSourceEmbed = previewFailed && Boolean(fallbackEmbedUrl);

  return (
    <div className={`cosmos-video-shell ${previewFailed ? "has-preview-error" : ""}`}>
      {useSourceEmbed ? (
        <iframe
          className="source-video-frame"
          src={fallbackEmbedUrl}
          title={`${label} source-hosted player`}
          allow="autoplay; fullscreen; picture-in-picture"
          loading="lazy"
        />
      ) : (
        <>
          <video
        ref={videoRef}
        autoPlay={autoPlay}
        crossOrigin="anonymous"
        loop
        muted={muted}
        playsInline
        preload="metadata"
        poster={media.thumbnailUrl}
        src={playbackUrl}
        aria-label={`${label}. Tap to play or pause`}
        tabIndex={0}
        onClick={togglePlayback}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            togglePlayback();
          }
        }}
        onCanPlay={(event) => {
          if (autoPlay && event.currentTarget.paused) {
            void event.currentTarget.play().catch(() => undefined);
          }
        }}
        onError={() => {
          if (!previewObjectUrlRef.current) {
            void prepareLocalPreview(autoPlay);
            return;
          }
          setPreviewFailed(true);
        }}
        onLoadedMetadata={(event) => {
          setDuration(event.currentTarget.duration);
          if (event.currentTarget.videoWidth && event.currentTarget.videoHeight) {
            onMetadata?.({
              width: event.currentTarget.videoWidth,
              height: event.currentTarget.videoHeight,
            });
          }
        }}
        onPlay={() => setPreviewFailed(false)}
        onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
        onVolumeChange={(event) => setMuted(event.currentTarget.muted)}
          />
          <div className="cosmos-video-gradient" aria-hidden="true" />
          <button
            className="cosmos-mute-button"
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              toggleMute();
            }}
            aria-label={muted ? "Unmute" : "Mute"}
            title={muted ? "Unmute" : "Mute"}
          >
            <Icon name={muted ? "speaker-slash" : "speaker-high"} size={17} />
          </button>
          <div className="cosmos-video-progress">
            <div className="cosmos-video-track">
              <span className="cosmos-video-fill" style={{ width: `${progress}%` }} />
              <input
                className="cosmos-video-range"
                type="range"
                min="0"
                max={duration || 0}
                step="0.1"
                value={Math.min(currentTime, duration || 0)}
                onChange={(event) => {
                  const nextTime = Number(event.target.value);
                  if (videoRef.current) videoRef.current.currentTime = nextTime;
                  setCurrentTime(nextTime);
                }}
                aria-label="Video progress"
                disabled={!duration}
              />
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function ResultState({
  result,
  onDownload,
  itemDownloadProgress,
}: {
  result: ResolveResult;
  onDownload: (
    media: MediaItem,
    source: DownloadSource,
    index: number,
    total: number,
  ) => void | Promise<void>;
  itemDownloadProgress: Record<number, ItemDownloadProgress>;
}) {
  const [dimensions, setDimensions] = useState<Record<number, MediaDimensions>>({});
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  const desktopShape = getGridShape(result.media.length);
  const mobileShape = getGridShape(result.media.length, true);
  const gridStyle = {
    "--media-columns": desktopShape.columns,
    "--media-rows": desktopShape.rows,
    "--media-columns-mobile": mobileShape.columns,
    "--media-rows-mobile": mobileShape.rows,
  } as CSSProperties;

  const recordDimensions = (index: number, nextDimensions: MediaDimensions) => {
    setDimensions((previous) => {
      const current = previous[index];
      if (
        current?.width === nextDimensions.width &&
        current?.height === nextDimensions.height
      ) {
        return previous;
      }
      return { ...previous, [index]: nextDimensions };
    });
  };

  return (
    <div className="result-state">
      <div
        className={`media-grid ${result.media.length === 1 ? "single-media" : "multi-media"}`}
        aria-label={`${result.media.length} ${result.platform === "twitter" ? "X" : "Instagram"} media items`}
        data-density={result.media.length > 12 ? "very-dense" : result.media.length > 8 ? "dense" : "standard"}
        style={gridStyle}
      >
        {result.media.map((media, index) => {
          const itemProgress = itemDownloadProgress[index];
          const itemNumber = String(index + 1).padStart(2, "0");
          const itemTotal = String(result.media.length).padStart(2, "0");

          return (
            <article
              className={`media-card ${media.type === "video" ? "is-video" : "is-image"}`}
              data-download-phase={itemProgress?.phase ?? "idle"}
              key={`${media.url}-${index}`}
            >
              <div className="media-frame">
                {media.type === "video" ? (
                  <VideoPlayer
                    media={media}
                    label={`${labelForKind(result.kind)} video ${index + 1}`}
                    autoPlay={result.media.length === 1}
                    fallbackEmbedUrl={
                      result.platform === "twitter" && result.sourceId
                        ? `https://twitter.com/i/videos/tweet/${encodeURIComponent(result.sourceId)}`
                        : undefined
                    }
                    onMetadata={(nextDimensions) => recordDimensions(index, nextDimensions)}
                  />
                ) : (
                  <button
                    className="image-preview-trigger"
                    type="button"
                    onClick={() => setPreviewIndex(index)}
                    aria-label={`View image ${index + 1} full screen`}
                    title="View full screen"
                  >
                    <img
                      src={media.url}
                      alt={`${labelForKind(result.kind)} image ${index + 1}`}
                      loading={index === 0 ? "eager" : "lazy"}
                      decoding="async"
                      draggable={false}
                      onLoad={(event) =>
                        recordDimensions(index, {
                          width: event.currentTarget.naturalWidth,
                          height: event.currentTarget.naturalHeight,
                        })
                      }
                    />
                  </button>
                )}

                <span className="media-index" aria-hidden="true">
                  {itemNumber} / {itemTotal}
                </span>
                <span className="media-quality">
                  {getQualityLabel(media, dimensions[index])}
                </span>

                {itemProgress ? (
                  <span
                    className={`item-download-state is-${itemProgress.phase} ${itemProgress.indeterminate ? "is-indeterminate" : ""}`}
                    style={{ "--item-progress": `${itemProgress.percent}%` } as CSSProperties}
                    role="status"
                    aria-label={`${itemProgress.phase} ${media.type} ${index + 1}`}
                  >
                    <span className="item-download-core">
                      {itemProgress.phase === "complete" ? <Icon name="check" size={13} /> : null}
                    </span>
                  </span>
                ) : null}

                <div className="media-actions">
                  {media.type === "video" ? (
                    <a
                      className="media-player"
                      href={media.url}
                      target="_blank"
                      rel="noreferrer"
                      aria-label="Open video in a new tab"
                      title="Open in new tab"
                    >
                      <Icon name="arrow-square-out" size={16} />
                    </a>
                  ) : null}
                  <button
                    className="media-download"
                    type="button"
                    onClick={() => void onDownload(media, result, index, result.media.length)}
                    aria-label={`Download ${media.type} ${index + 1}`}
                    title={`Download ${media.type}`}
                    disabled={itemProgress?.phase === "downloading" || itemProgress?.phase === "preparing"}
                  >
                    <Icon name={itemProgress?.phase === "complete" ? "check" : "download"} size={16} />
                  </button>
                </div>
              </div>
            </article>
          );
        })}
      </div>
      {previewIndex !== null && result.media[previewIndex]?.type === "image" ? (
        <MediaLightbox
          media={result.media[previewIndex]}
          label={`${labelForKind(result.kind)} image ${previewIndex + 1}`}
          onClose={() => setPreviewIndex(null)}
        />
      ) : null}
    </div>
  );
}

function MediaLightbox({
  media,
  label,
  onClose,
}: {
  media: MediaItem;
  label: string;
  onClose: () => void;
}) {
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeButtonRef.current?.focus();
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      onClose();
    };

    window.addEventListener("keydown", handleEscape, { capture: true });
    return () => window.removeEventListener("keydown", handleEscape, { capture: true });
  }, [onClose]);

  return (
    <div
      className="media-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={label}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="lightbox-surface">
        <img src={media.url} alt={label} decoding="async" />
        <button
          ref={closeButtonRef}
          className="lightbox-close"
          type="button"
          onClick={onClose}
          aria-label="Close full screen preview"
          title="Close"
        >
          <Icon name="x" size={18} />
        </button>
      </div>
    </div>
  );
}

function EmbedOnlyState({ result }: { result: ResolveResult }) {
  const isStory = result.kind === "story";
  const sourceLabel = result.platform === "twitter" ? "X" : "Instagram";

  return (
    <div className="embed-state">
      <div className={`embed-preview ${isStory ? "is-story" : ""}`}>
        {isStory ? (
          <div className="embed-message" role="status">
            <span className="embed-message-mark" aria-hidden="true" />
            <p>{result.message ?? "No active public story is available."}</p>
          </div>
        ) : (
          <iframe src={result.embedUrl} title={`${sourceLabel} public embed preview`} loading="lazy" />
        )}
        <a
          className="external-link"
          href={result.canonicalUrl}
          target="_blank"
          rel="noreferrer"
          aria-label={`Open original ${sourceLabel} page`}
          title={`Open ${sourceLabel}`}
        >
          <Icon name="arrow-up-right" size={17} />
        </a>
      </div>
    </div>
  );
}
