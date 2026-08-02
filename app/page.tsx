"use client";

import {
  ArrowUpRight,
  ClipboardText,
  DownloadSimple,
  ImageSquare,
  LinkSimple,
  Play,
  Sparkle,
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
  return `downflow-${index + 1}.${media.type === "video" ? "mp4" : "jpg"}`;
}

export default function Home() {
  const [url, setUrl] = useState("");
  const [viewState, setViewState] = useState<ViewState>("idle");
  const [result, setResult] = useState<ResolveResult | null>(null);
  const [errorMessage, setErrorMessage] = useState("");
  const [downloadMessage, setDownloadMessage] = useState("");
  const [copied, setCopied] = useState(false);
  const [clipboardAvailable, setClipboardAvailable] = useState(true);
  const autoDownloadRef = useRef("");
  const debounceRef = useRef<number | null>(null);
  const requestRef = useRef<AbortController | null>(null);
  const lastLookupRef = useRef("");
  const inputRef = useRef<HTMLInputElement>(null);
  const pendingDownloadsRef = useRef<number[]>([]);

  useEffect(() => {
    return () => {
      if (debounceRef.current) window.clearTimeout(debounceRef.current);
      requestRef.current?.abort();
      pendingDownloadsRef.current.forEach((timeoutId) => window.clearTimeout(timeoutId));
    };
  }, []);

  const downloadMedia = useCallback(
    async (media: MediaItem, index = 0) => {
      const proxyUrl = getDownloadUrl(media, index);

      try {
        const response = await fetch(proxyUrl);
        if (!response.ok) throw new Error("Download proxy unavailable");
        const blob = await response.blob();
        const objectUrl = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = objectUrl;
        anchor.download = getDownloadFileName(media, index);
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        URL.revokeObjectURL(objectUrl);
        setDownloadMessage("Download started. Check your browser downloads.");
      } catch {
        window.open(media.url, "_blank", "noopener,noreferrer");
        setDownloadMessage("Opened the media source. Use your browser's save action if needed.");
      }
    },
    [],
  );

  const triggerImmediateDownload = useCallback((media: MediaItem, index: number) => {
    const anchor = document.createElement("a");
    anchor.href = getDownloadUrl(media, index);
    anchor.download = getDownloadFileName(media, index);
    anchor.rel = "noreferrer";
    anchor.style.display = "none";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  }, []);

  const queueImmediateDownloads = useCallback(
    (media: MediaItem[]) => {
      pendingDownloadsRef.current.forEach((timeoutId) => window.clearTimeout(timeoutId));
      pendingDownloadsRef.current = media.map((item, index) =>
        window.setTimeout(() => triggerImmediateDownload(item, index), index * 180),
      );
      setDownloadMessage(
        media.length === 1
          ? "Download started. Check your browser downloads."
          : `${media.length} downloads started. Check your browser downloads.`,
      );
    },
    [triggerImmediateDownload],
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
    [downloadMedia, queueImmediateDownloads],
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
    try {
      const text = await navigator.clipboard.readText();
      setUrl(text);
      void resolveUrl(text, true);
      setClipboardAvailable(true);
    } catch {
      setClipboardAvailable(false);
    }
  };

  const handleCopyLink = async () => {
    if (!result) return;
    await navigator.clipboard.writeText(result.canonicalUrl);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };

  const clearAll = () => {
    requestRef.current?.abort();
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
        <a className="brand" href="#top" aria-label="downflow home">
          <span className="brand-mark" aria-hidden="true">
            <span />
            <span />
          </span>
          downflow<span className="brand-period">.</span>
        </a>
        <div className="topbar-note">
          <span className="live-mark" aria-hidden="true" />
          public links only
        </div>
      </nav>

      <section className="hero-grid" id="top">
        <div className="hero-copy">
          <p className="eyebrow">Instagram media, simplified</p>
          <h1>
            Grab the post.
            <span>Keep the moment.</span>
          </h1>
          <p className="hero-description">
            Paste a public Instagram post, reel, video, or story link. Downflow finds the media exposed by Instagram&apos;s public page.
          </p>
          <div className="trust-row" aria-label="Product details">
            <span>No account</span>
            <span>No upload</span>
            <span>Local download</span>
          </div>
        </div>

        <div className="tool-stack">
          <form className="input-card" onSubmit={handleSubmit}>
            <div className="input-card-topline">
              <label htmlFor="instagram-url">Paste a link to get started</label>
              {url ? (
                <button className="icon-button" type="button" onClick={clearAll} aria-label="Clear link">
                  <X size={17} weight="bold" />
                </button>
              ) : null}
            </div>
            <div className={`url-field ${viewState === "error" ? "has-error" : ""}`}>
              <LinkSimple size={19} weight="regular" aria-hidden="true" />
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
                placeholder="https://www.instagram.com/p/..."
                autoComplete="url"
                spellCheck={false}
                aria-invalid={viewState === "error"}
              />
              <button className="paste-button" type="button" onClick={handlePaste}>
                <ClipboardText size={17} weight="regular" />
                Paste
              </button>
            </div>
            <div className="input-card-footer">
              <span className="input-hint">Public post, reel, video, or story URL</span>
              <button className="find-button" type="submit" disabled={viewState === "loading"}>
                {viewState === "loading" ? "Reading" : "Find media"}
                <ArrowUpRight size={17} weight="bold" />
              </button>
            </div>
            {!clipboardAvailable ? (
              <p className="inline-note">Clipboard access is off. Paste directly into the field instead.</p>
            ) : null}
            {viewState === "error" ? (
              <p className="error-note" role="alert">
                <WarningCircle size={16} weight="fill" />
                {errorMessage}
              </p>
            ) : null}
          </form>

          <div className="small-panel">
            <div className="small-panel-icon" aria-hidden="true">
              <Sparkle size={18} weight="fill" />
            </div>
            <div>
              <strong>Fast by design</strong>
              <p>We only request the public page you give us.</p>
            </div>
          </div>
        </div>
      </section>

      <section className="workspace-section" aria-live="polite">
        <div className="workspace-heading">
          <div>
            <p className="section-kicker">Your download space</p>
            <h2>{viewState === "idle" ? "Nothing here yet." : viewState === "loading" ? "Looking for media." : "Your media is ready."}</h2>
          </div>
          {result?.media.length ? (
            <button className="quiet-button" type="button" onClick={() => result.media.forEach((media, index) => void downloadMedia(media, index))}>
              <DownloadSimple size={17} weight="bold" />
              Download all
            </button>
          ) : null}
        </div>

        {viewState === "idle" ? <EmptyState /> : null}
        {viewState === "loading" ? <LoadingState /> : null}
        {viewState === "success" && result ? (
          <ResultState result={result} onDownload={downloadMedia} onCopy={handleCopyLink} copied={copied} />
        ) : null}
        {viewState === "embed-only" && result ? <EmbedOnlyState result={result} /> : null}
        {downloadMessage ? <p className="download-note">{downloadMessage}</p> : null}
      </section>

      <footer className="footer-note">
        <span>Save what you have permission to use.</span>
        <span>downflow is not affiliated with Instagram.</span>
      </footer>
    </main>
  );
}

function EmptyState() {
  return (
    <div className="empty-state">
      <div className="empty-visual" aria-hidden="true">
        <div className="empty-card empty-card-back" />
        <div className="empty-card empty-card-front">
          <ImageSquare size={32} weight="regular" />
        </div>
      </div>
      <div>
        <h3>Drop in a public link.</h3>
        <p>The preview and download actions will appear here as soon as the page responds.</p>
      </div>
    </div>
  );
}

function LoadingState() {
  return (
    <div className="loading-state" aria-label="Loading media preview">
      <div className="skeleton skeleton-media" />
      <div className="skeleton-copy">
        <div className="skeleton skeleton-title" />
        <div className="skeleton skeleton-line" />
        <div className="skeleton skeleton-line short" />
      </div>
    </div>
  );
}

function ResultState({
  result,
  onDownload,
  onCopy,
  copied,
}: {
  result: ResolveResult;
  onDownload: (media: MediaItem, index?: number) => void;
  onCopy: () => void;
  copied: boolean;
}) {
  return (
    <div className="result-state">
      <div className="result-meta">
        <div className="source-preview">
          <span className="source-icon" aria-hidden="true">
            <Play size={15} weight="fill" />
          </span>
          <div>
            <strong>{result.media.length} {result.media.length === 1 ? "file" : "files"} found</strong>
            <span>{labelForKind(result.kind)} from a public page</span>
          </div>
        </div>
        <button className="quiet-button" type="button" onClick={onCopy}>
          <LinkSimple size={16} weight="bold" />
          {copied ? "Copied" : "Copy link"}
        </button>
      </div>

      <div className="media-grid">
        {result.media.map((media, index) => (
          <article className="media-card" key={`${media.url}-${index}`}>
            <div className="media-frame">
              {media.type === "video" ? (
                <video controls preload="metadata" poster={media.thumbnailUrl} src={media.url} />
              ) : (
                <img src={media.url} alt={`${labelForKind(result.kind)} media ${index + 1}`} />
              )}
              <span className="media-type">
                {media.type === "video" ? <Play size={13} weight="fill" /> : <ImageSquare size={13} weight="regular" />}
                {media.type}
              </span>
            </div>
            <div className="media-card-footer">
              <span>{media.type === "video" ? "Video file" : "Image file"}</span>
              <button type="button" onClick={() => onDownload(media, index)}>
                <DownloadSimple size={16} weight="bold" />
                Save
              </button>
            </div>
          </article>
        ))}
      </div>

      <p className="result-caption">{result.caption || result.title || "Media exposed by the public Instagram page."}</p>
    </div>
  );
}

function EmbedOnlyState({ result }: { result: ResolveResult }) {
  return (
    <div className="embed-state">
      <div className="embed-copy">
        <div className="embed-heading">
          <WarningCircle size={20} weight="fill" />
          <div>
            <h3>Instagram kept the file behind its embed.</h3>
            <p>{result.message}</p>
          </div>
        </div>
        <a className="external-link" href={result.canonicalUrl} target="_blank" rel="noreferrer">
          Open the original on Instagram
          <ArrowUpRight size={16} weight="bold" />
        </a>
      </div>
      <div className="embed-preview">
        <iframe src={result.embedUrl} title="Instagram public embed preview" loading="lazy" />
      </div>
    </div>
  );
}
