"use client";

import {
  ArrowSquareOut,
  ArrowUpRight,
  ClipboardText,
  DownloadSimple,
  LinkSimple,
  SpeakerHigh,
  SpeakerSlash,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import { FormEvent, useCallback, useEffect, useRef, useState } from "react";

type MediaItem = {
  type: "image" | "video";
  url: string;
  thumbnailUrl?: string;
};

type ResolveResult = {
  ok: boolean;
  status: "ready" | "embed-only";
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

type DownloadSource = Pick<ResolveResult, "canonicalUrl" | "sourceUsername" | "sourceId">;
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

const INSTAGRAM_HOSTS = new Set([
  "instagram.com",
  "www.instagram.com",
  "instagr.am",
  "www.instagr.am",
]);

function normalizeInstagramUrl(value: string) {
  try {
    const parsed = new URL(value.trim());
    if (!INSTAGRAM_HOSTS.has(parsed.hostname.toLowerCase())) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function labelForKind(kind: string) {
  if (kind === "reel") return "reel";
  if (kind === "video") return "video";
  if (kind === "story") return "story";
  return "post";
}

function sanitizeFilePart(value: string) {
  return (
    value
      .replace(/[^a-z0-9._-]+/gi, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64) || "instagram"
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
    ["p", "reel", "tv", "stories"].includes(segment),
  );
  const marker = segments[markerIndex];
  const fallbackUsername =
    marker === "stories"
      ? segments[markerIndex + 1]
      : markerIndex > 0
        ? segments[markerIndex - 1]
        : "instagram";
  const fallbackId = segments[markerIndex + 1] ?? segments[segments.length - 1] ?? "media";

  return {
    username: sanitizeFilePart(source.sourceUsername ?? fallbackUsername ?? "instagram"),
    postId: sanitizeFilePart(source.sourceId ?? fallbackId),
  };
}

function getDownloadBaseName(source: DownloadSource) {
  const identity = getSourceIdentity(source);
  return `${identity.username}-${identity.postId}-${randomToken()}`;
}

function getDownloadUrl(media: MediaItem, baseName: string) {
  return `/api/download?url=${encodeURIComponent(media.url)}&name=${encodeURIComponent(baseName)}`;
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

async function fetchMediaBlob(
  media: MediaItem,
  baseName: string,
  onProgress: DownloadProgressCallback,
) {
  try {
    const directResponse = await fetch(media.url, {
      cache: "no-store",
      redirect: "follow",
    });
    const contentType = directResponse.headers.get("content-type") ?? "";
    const expectedType = media.type === "video" ? "video/" : "image/";

    if (directResponse.ok && contentType.startsWith(expectedType)) {
      return readResponseBlob(directResponse, onProgress);
    }
  } catch {
    // Some CDN variants reject browser fetches; use the same-origin fallback below.
  }

  const fallbackResponse = await fetch(getDownloadUrl(media, baseName), {
    cache: "no-store",
  });
  if (!fallbackResponse.ok) throw new Error("Download proxy unavailable");
  return readResponseBlob(fallbackResponse, onProgress);
}

async function prepareDownloadBlob(
  media: MediaItem,
  baseName: string,
  onProgress: DownloadProgressCallback,
  onPreparing: () => void,
) {
  const sourceBlob = await fetchMediaBlob(media, baseName, onProgress);
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
  const [pasteState, setPasteState] = useState<"idle" | "pasting">("idle");
  const debounceRef = useRef<number | null>(null);
  const requestRef = useRef<AbortController | null>(null);
  const lastLookupRef = useRef("");
  const inputRef = useRef<HTMLInputElement>(null);
  const pendingDownloadsRef = useRef<number[]>([]);
  const downloadSequenceRef = useRef(0);
  const progressResetRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      downloadSequenceRef.current += 1;
      if (debounceRef.current) window.clearTimeout(debounceRef.current);
      requestRef.current?.abort();
      pendingDownloadsRef.current.forEach((timeoutId) => window.clearTimeout(timeoutId));
      if (progressResetRef.current) window.clearTimeout(progressResetRef.current);
    };
  }, []);

  const downloadMedia = useCallback(
    async (media: MediaItem, source: DownloadSource, index: number, total: number) => {
      const baseName = getDownloadBaseName(source);
      if (progressResetRef.current) {
        window.clearTimeout(progressResetRef.current);
        progressResetRef.current = null;
      }

      const markComplete = () => {
        setDownloadProgress({
          current: index + 1,
          total,
          percent: ((index + 1) / total) * 100,
          phase: "complete",
          indeterminate: false,
        });

        if (index === total - 1) {
          progressResetRef.current = window.setTimeout(() => {
            setDownloadProgress(null);
            progressResetRef.current = null;
          }, 1400);
        }
      };

      setDownloadProgress({
        current: index + 1,
        total,
        percent: (index / total) * 100,
        phase: "downloading",
        indeterminate: true,
      });

      try {
        const blob = await prepareDownloadBlob(
          media,
          baseName,
          (loaded, bytesTotal) => {
            const fraction = bytesTotal ? Math.min(loaded / bytesTotal, 1) : 0.12;
            setDownloadProgress({
              current: index + 1,
              total,
              percent: Math.min(99, ((index + fraction) / total) * 100),
              phase: "downloading",
              indeterminate: !bytesTotal,
            });
          },
          () => {
            setDownloadProgress((previous) => ({
              current: index + 1,
              total,
              percent: Math.max(previous?.percent ?? 0, ((index + 0.94) / total) * 100),
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
        window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
        setDownloadMessage("Download started.");
      } catch {
        window.open(media.url, "_blank", "noopener,noreferrer");
        setDownloadMessage("The media source was opened.");
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

        await downloadMedia(media[index], source, index, media.length);
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

  const resolveUrl = useCallback(
    async (rawValue: string, force = false) => {
      const normalized = normalizeInstagramUrl(rawValue);
      if (!normalized) {
        if (force) {
          setViewState("error");
          setErrorMessage("Paste a full link from instagram.com.");
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
      setViewState("loading");

      try {
        const response = await fetch("/api/resolve", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: normalized }),
          signal: controller.signal,
        });
        const payload = (await response.json()) as ResolveResult & { error?: string };
        if (!response.ok) throw new Error(payload.error || "Instagram link could not be read.");

        setResult(payload);
        setViewState(payload.status === "ready" ? "success" : "embed-only");
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setViewState("error");
        setErrorMessage(error instanceof Error ? error.message : "That link could not be read.");
      }
    },
    [],
  );

  const queueLookup = (value: string) => {
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
    if (!normalizeInstagramUrl(value)) return;
    debounceRef.current = window.setTimeout(() => resolveUrl(value), 220);
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void resolveUrl(url, true);
  };

  const handlePaste = async () => {
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
  };

  const downloadAllMedia = useCallback(
    (media: MediaItem[], source: DownloadSource) => {
      queueDownloads(media, source);
    },
    [queueDownloads],
  );

  const clearAll = () => {
    requestRef.current?.abort();
    downloadSequenceRef.current += 1;
    lastLookupRef.current = "";
    pendingDownloadsRef.current.forEach((timeoutId) => window.clearTimeout(timeoutId));
    pendingDownloadsRef.current = [];
    if (progressResetRef.current) {
      window.clearTimeout(progressResetRef.current);
      progressResetRef.current = null;
    }
    setUrl("");
    setResult(null);
    setErrorMessage("");
    setDownloadMessage("");
    setDownloadProgress(null);
    setViewState("idle");
    inputRef.current?.focus();
  };

  return (
    <main className="site-frame">
      <nav className="topbar" aria-label="Primary">
        <span className="brand-rule" aria-hidden="true" />
        <a className="brand" href="#top" aria-label="Instagram Downloader home">
          Instagram Downloader
        </a>
        <span className="brand-rule" aria-hidden="true" />
      </nav>

      <section className="hero-grid" id="top">
        <div className="tool-stack">
          <div className="paste-zone">
            <div className="paste-zone-head">
              <span>PASTE / DOWNLOAD</span>
              <span>CTRL / CMD + V</span>
            </div>
            <div className="paste-zone-mark" aria-hidden="true">
              <ClipboardText size={25} weight="regular" />
            </div>
            <form className="input-card" onSubmit={handleSubmit}>
              <label className="sr-only" htmlFor="instagram-url">
                Instagram link
              </label>
              <div className={`url-field ${viewState === "error" ? "has-error" : ""}`}>
                <LinkSimple className="field-icon" size={19} weight="regular" aria-hidden="true" />
                <input
                  id="instagram-url"
                  ref={inputRef}
                  autoFocus
                  value={url}
                  onChange={(event) => {
                    const nextValue = event.target.value;
                    setUrl(nextValue);
                    setErrorMessage("");
                    setViewState("idle");
                    queueLookup(nextValue);
                  }}
                  placeholder="Paste an Instagram link"
                  autoComplete="url"
                  spellCheck={false}
                  aria-invalid={viewState === "error"}
                />
                {url ? (
                  <button className="clear-button" type="button" onClick={clearAll} aria-label="Clear link">
                    <X size={17} weight="bold" />
                  </button>
                ) : null}
                <button
                  className="paste-button"
                  type="button"
                  onClick={handlePaste}
                  disabled={pasteState === "pasting" || viewState === "loading"}
                >
                  <ClipboardText size={17} weight="regular" aria-hidden="true" />
                  {pasteState === "pasting" ? "Pasting" : "Paste Link"}
                </button>
              </div>
              {viewState === "error" ? (
                <p className="error-note" role="alert">
                  <WarningCircle size={15} weight="fill" aria-hidden="true" />
                  {errorMessage}
                </p>
              ) : null}
            </form>
          </div>
        </div>
      </section>

      <section className="workspace-section" aria-live="polite">
        {downloadProgress ? <DownloadProgressBar progress={downloadProgress} /> : null}
        {result?.media.length ? (
          <div className="workspace-tools">
            <span className="workspace-label">{result.media.length} media</span>
            <button
              className="download-all-button"
              type="button"
              onClick={() => downloadAllMedia(result.media, result)}
              aria-label="Download all media"
              title="Download all"
            >
              <DownloadSimple size={17} weight="bold" />
              <span>Download all</span>
            </button>
          </div>
        ) : null}

        {viewState === "loading" ? <LoadingState /> : null}
        {viewState === "success" && result ? (
          <ResultState result={result} onDownload={downloadMedia} />
        ) : null}
        {viewState === "embed-only" && result ? <EmbedOnlyState result={result} /> : null}
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
      <div className="download-progress-meta">
        <span>{label}</span>
        <span>{progress.current} / {progress.total}</span>
      </div>
      <div className="download-progress-track">
        <span
          className={progress.indeterminate ? "is-indeterminate" : ""}
          style={{ width: `${progress.percent}%` }}
        />
      </div>
    </div>
  );
}

function VideoPlayer({ media, label }: { media: MediaItem; label: string }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [muted, setMuted] = useState(true);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);

  const togglePlayback = () => {
    const video = videoRef.current;
    if (!video) return;

    if (video.paused) {
      void video.play().catch(() => undefined);
    } else {
      video.pause();
    }
  };

  const toggleMute = () => {
    const video = videoRef.current;
    if (!video) return;
    video.muted = !video.muted;
    setMuted(video.muted);
  };

  const progress = duration ? Math.min((currentTime / duration) * 100, 100) : 0;

  return (
    <div className="cosmos-video-shell">
      <video
        ref={videoRef}
        autoPlay
        loop
        muted={muted}
        playsInline
        preload="metadata"
        poster={media.thumbnailUrl}
        src={media.url}
        aria-label={label}
        onClick={togglePlayback}
        onLoadedMetadata={(event) => setDuration(event.currentTarget.duration)}
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
        {muted ? <SpeakerSlash size={17} weight="regular" /> : <SpeakerHigh size={17} weight="regular" />}
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
    </div>
  );
}

function ResultState({
  result,
  onDownload,
}: {
  result: ResolveResult;
  onDownload: (media: MediaItem, source: DownloadSource, index: number, total: number) => void;
}) {
  return (
    <div className="result-state">
      <div
        className={`media-grid ${result.media.length === 1 ? "single-media" : "multi-media"}`}
        aria-label={`${result.media.length} Instagram media items`}
      >
        {result.media.map((media, index) => (
          <article className="media-card" key={`${media.url}-${index}`}>
            <div className="media-frame">
              {media.type === "video" ? (
                <VideoPlayer
                  media={media}
                  label={`${labelForKind(result.kind)} video ${index + 1}`}
                />
              ) : (
                <img
                  src={media.url}
                  alt={`${labelForKind(result.kind)} image ${index + 1}`}
                  loading={index === 0 ? "eager" : "lazy"}
                  decoding="async"
                  draggable={false}
                />
              )}
              <div className={`media-actions ${media.type === "video" ? "video-actions" : ""}`}>
                {media.type === "video" ? (
                  <a
                    className="media-player"
                    href={media.url}
                    target="_blank"
                    rel="noreferrer"
                    aria-label="Open video in a new tab"
                    title="Open in new tab"
                  >
                    <ArrowSquareOut size={17} weight="bold" />
                  </a>
                ) : null}
                <button
                  className="media-download"
                  type="button"
                  onClick={() => onDownload(media, result, index, result.media.length)}
                  aria-label={`Download ${media.type} ${index + 1}`}
                  title={`Download ${media.type}`}
                >
                  <DownloadSimple size={17} weight="bold" />
                </button>
              </div>
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}

function EmbedOnlyState({ result }: { result: ResolveResult }) {
  return (
    <div className="embed-state">
      <div className="embed-preview">
        <iframe src={result.embedUrl} title="Instagram public embed preview" loading="lazy" />
        <a
          className="external-link"
          href={result.canonicalUrl}
          target="_blank"
          rel="noreferrer"
          aria-label="Open original Instagram page"
          title="Open Instagram"
        >
          <ArrowUpRight size={17} weight="bold" />
        </a>
      </div>
    </div>
  );
}
