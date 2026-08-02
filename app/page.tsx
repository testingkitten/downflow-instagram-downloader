"use client";

import {
  ArrowUpRight,
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
  caption?: string;
  title?: string;
  media: MediaItem[];
  message?: string;
};

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

function getDownloadUrl(media: MediaItem, index: number) {
  const name = `downflow-${index + 1}`;
  return `/api/download?url=${encodeURIComponent(media.url)}&name=${name}`;
}

function getDownloadFileName(media: MediaItem, index: number) {
  return `downflow-${index + 1}.${media.type === "video" ? "mp4" : "png"}`;
}

async function fetchMediaBlob(media: MediaItem, index: number) {
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

  const fallbackResponse = await fetch(getDownloadUrl(media, index), {
    cache: "no-store",
  });
  if (!fallbackResponse.ok) throw new Error("Download proxy unavailable");
  return fallbackResponse.blob();
}

async function prepareDownloadBlob(media: MediaItem, index: number) {
  const sourceBlob = await fetchMediaBlob(media, index);
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
    async (media: MediaItem, index = 0) => {
      try {
        const blob = await prepareDownloadBlob(media, index);
        const objectUrl = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = objectUrl;
        anchor.download = getDownloadFileName(media, index);
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
    (media: MediaItem[]) => {
      pendingDownloadsRef.current.forEach((timeoutId) => window.clearTimeout(timeoutId));
      pendingDownloadsRef.current = [];
      const sequence = ++downloadSequenceRef.current;

      setDownloadMessage("Downloads starting.");

      const downloadNext = async (index: number) => {
        if (downloadSequenceRef.current !== sequence || !media[index]) return;

        await downloadMedia(media[index], index);
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
          queueImmediateDownloads(payload.media);
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

  const downloadAllMedia = useCallback(
    (media: MediaItem[]) => {
      queueImmediateDownloads(media);
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
        <a className="brand" href="#top" aria-label="insta download home">
          insta download
        </a>
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
                className="submit-button"
                type="submit"
                disabled={viewState === "loading"}
                aria-label={viewState === "loading" ? "Loading" : "Download media"}
              >
                {viewState === "loading" ? (
                  <span className="button-spinner" aria-hidden="true" />
                ) : (
                  <ArrowUpRight size={18} weight="bold" />
                )}
              </button>
            </div>
            {viewState === "error" ? (
              <span className="error-state" role="alert">
                <WarningCircle size={15} weight="fill" aria-hidden="true" />
                <span className="sr-only">{errorMessage}</span>
              </span>
            ) : null}
          </form>
        </div>
      </section>

      <section className="workspace-section" aria-live="polite">
        {result?.media.length ? (
          <div className="workspace-tools">
            <button
              className="download-all-button"
              type="button"
              onClick={() => downloadAllMedia(result.media)}
              aria-label="Download all media"
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
  onDownload: (media: MediaItem, index?: number) => void;
}) {
  return (
    <div className="result-state">
      <div className="media-grid" aria-label={`${result.media.length} downloaded media items`}>
        {result.media.map((media, index) => (
          <article className="media-card" key={`${media.url}-${index}`}>
            <div className="media-frame">
              {media.type === "video" ? (
                <video
                  autoPlay
                  muted
                  loop
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
              {media.type === "video" ? (
                <span className="media-play" aria-hidden="true">
                  <Play size={14} weight="fill" />
                </span>
              ) : null}
              <button
                className="media-download"
                type="button"
                onClick={() => onDownload(media, index)}
                aria-label={`Download ${media.type} ${index + 1}`}
              >
                <DownloadSimple size={17} weight="bold" />
              </button>
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
        >
          <ArrowUpRight size={17} weight="bold" />
        </a>
      </div>
    </div>
  );
}
