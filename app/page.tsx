"use client";

import {
  ArrowUpRight,
  ClipboardText,
  DownloadSimple,
  LinkSimple,
  Play,
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

async function fetchMediaBlob(media: MediaItem, baseName: string) {
  try {
    const directResponse = await fetch(media.url, {
      cache: "no-store",
      redirect: "follow",
    });
    const contentType = directResponse.headers.get("content-type") ?? "";
    const expectedType = media.type === "video" ? "video/" : "image/";

    if (directResponse.ok && contentType.startsWith(expectedType)) {
      return directResponse.blob();
    }
  } catch {
    // Some CDN variants reject browser fetches; use the same-origin fallback below.
  }

  const fallbackResponse = await fetch(getDownloadUrl(media, baseName), {
    cache: "no-store",
  });
  if (!fallbackResponse.ok) throw new Error("Download proxy unavailable");
  return fallbackResponse.blob();
}

async function prepareDownloadBlob(media: MediaItem, baseName: string) {
  const sourceBlob = await fetchMediaBlob(media, baseName);
  if (media.type === "video") return sourceBlob;

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
  const [pasteState, setPasteState] = useState<"idle" | "pasting">("idle");
  const autoDownloadRef = useRef("");
  const debounceRef = useRef<number | null>(null);
  const requestRef = useRef<AbortController | null>(null);
  const lastLookupRef = useRef("");
  const inputRef = useRef<HTMLInputElement>(null);
  const pendingDownloadsRef = useRef<number[]>([]);
  const downloadSequenceRef = useRef(0);

  useEffect(() => {
    return () => {
      downloadSequenceRef.current += 1;
      if (debounceRef.current) window.clearTimeout(debounceRef.current);
      requestRef.current?.abort();
      pendingDownloadsRef.current.forEach((timeoutId) => window.clearTimeout(timeoutId));
    };
  }, []);

  const downloadMedia = useCallback(
    async (media: MediaItem, source: DownloadSource) => {
      const baseName = getDownloadBaseName(source);

      try {
        const blob = await prepareDownloadBlob(media, baseName);
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
    },
    [],
  );

  const queueImmediateDownloads = useCallback(
    (media: MediaItem[], source: DownloadSource) => {
      pendingDownloadsRef.current.forEach((timeoutId) => window.clearTimeout(timeoutId));
      pendingDownloadsRef.current = [];
      const sequence = ++downloadSequenceRef.current;

      setDownloadMessage("Downloads starting.");

      const downloadNext = async (index: number) => {
        if (downloadSequenceRef.current !== sequence || !media[index]) return;

        await downloadMedia(media[index], source);
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
      setUrl(normalized);
      setResult(null);
      setErrorMessage("");
      setDownloadMessage("");
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

        if (payload.status === "ready" && payload.media.length && autoDownloadRef.current !== normalized) {
          autoDownloadRef.current = normalized;
          queueImmediateDownloads(payload.media, payload);
        }
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setViewState("error");
        setErrorMessage(error instanceof Error ? error.message : "That link could not be read.");
      }
    },
    [queueImmediateDownloads],
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
      queueImmediateDownloads(media, source);
    },
    [queueImmediateDownloads],
  );

  const clearAll = () => {
    requestRef.current?.abort();
    downloadSequenceRef.current += 1;
    lastLookupRef.current = "";
    autoDownloadRef.current = "";
    pendingDownloadsRef.current.forEach((timeoutId) => window.clearTimeout(timeoutId));
    pendingDownloadsRef.current = [];
    setUrl("");
    setResult(null);
    setErrorMessage("");
    setDownloadMessage("");
    setViewState("idle");
    inputRef.current?.focus();
  };

  return (
    <main className="site-frame">
      <nav className="topbar" aria-label="Primary">
        <a className="brand" href="#top" aria-label="Instagram Downloader home">
          Instagram Downloader
        </a>
        <span className="brand-rule" aria-hidden="true" />
      </nav>

      <section className="hero-grid" id="top">
        <div className="tool-stack">
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
      </section>

      <section className="workspace-section" aria-live="polite">
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
            </button>
          </div>
        ) : null}

        {viewState === "loading" ? <LoadingState /> : null}
        {viewState === "success" && result ? <ResultState result={result} onDownload={downloadMedia} /> : null}
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

function ResultState({
  result,
  onDownload,
}: {
  result: ResolveResult;
  onDownload: (media: MediaItem, source: DownloadSource) => void;
}) {
  return (
    <div className="result-state">
      <div className="media-grid" aria-label={`${result.media.length} Instagram media items`}>
        {result.media.map((media, index) => (
          <article className="media-card" key={`${media.url}-${index}`}>
            <div className="media-frame">
              {media.type === "video" ? (
                <video
                  controls
                  playsInline
                  preload="metadata"
                  poster={media.thumbnailUrl}
                  src={media.url}
                  aria-label={`${labelForKind(result.kind)} video ${index + 1}`}
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
              <div className="media-actions">
                {media.type === "video" ? (
                  <a
                    className="media-player"
                    href={media.url}
                    target="_blank"
                    rel="noreferrer"
                    aria-label="Open video in HTML5 player"
                    title="Open HTML5 player"
                  >
                    <Play size={16} weight="fill" />
                  </a>
                ) : null}
                <button
                  className="media-download"
                  type="button"
                  onClick={() => onDownload(media, result)}
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
