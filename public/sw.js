const SHELL_CACHE = "download-images-shell-v5";
const DEVICE_DOWNLOAD_PATH = "/__device-download";
const DEVICE_DOWNLOAD_CAPABILITY = "downflow-device-download-v1";
const APP_SHELL = [
  "/",
  "/manifest.webmanifest",
  "/instagram-mark.svg",
  "/icon-192.png",
  "/icon-512.png",
  "/apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith("download-images-shell-") && key !== SHELL_CACHE)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("message", (event) => {
  if (event.data?.type !== "device-download-capability") return;
  event.ports[0]?.postMessage({ capability: DEVICE_DOWNLOAD_CAPABILITY });
});

function sanitizeDownloadFileName(value) {
  const sanitized = (value || "video.mp4")
    .replace(/[^a-z0-9._-]+/gi, "_")
    .replace(/^\.+/, "")
    .slice(0, 140);
  return sanitized || "video.mp4";
}

async function fetchDownloadSource(sourceUrl, range) {
  let lastError;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const headers = new Headers();
      if (range) headers.set("Range", range);

      const response = await fetch(sourceUrl, {
        cache: "no-store",
        credentials: "omit",
        headers,
        mode: "cors",
        redirect: "follow",
        referrerPolicy: "no-referrer",
      });

      if (response.ok || response.status === 206) return response;
      lastError = new Error(`Source returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }

    if (attempt < 2) {
      await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
    }
  }

  throw lastError ?? new Error("Source download failed");
}

async function streamDeviceDownload(request, requestUrl) {
  try {
    const rawSource = requestUrl.searchParams.get("source");
    const sourceUrl = new URL(rawSource ?? "");
    if (sourceUrl.protocol !== "https:" || sourceUrl.hostname !== "video.twimg.com") {
      return new Response("Unsupported download source.", { status: 400 });
    }

    const fileName = sanitizeDownloadFileName(requestUrl.searchParams.get("filename"));
    const upstream = await fetchDownloadSource(
      sourceUrl.toString(),
      request.headers.get("Range"),
    );
    const headers = new Headers({
      "Cache-Control": "private, no-store",
      "Content-Disposition": `attachment; filename="${fileName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
      "Content-Security-Policy": "default-src 'none'",
      "Content-Type": "application/octet-stream",
      "X-Content-Type-Options": "nosniff",
    });

    for (const name of ["Accept-Ranges", "Content-Length", "Content-Range"]) {
      const value = upstream.headers.get(name);
      if (value) headers.set(name, value);
    }

    return new Response(upstream.body, {
      headers,
      status: upstream.status,
      statusText: upstream.statusText,
    });
  } catch {
    return new Response("The source download failed.", {
      headers: { "Cache-Control": "no-store", "Content-Type": "text/plain" },
      status: 502,
    });
  }
}

async function cacheFirst(request, cacheKey = request, maxAgeMs = Number.POSITIVE_INFINITY) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(cacheKey);
  const cachedAt = cached?.headers.get("date");
  const cacheAge = cachedAt ? Date.now() - Date.parse(cachedAt) : Number.POSITIVE_INFINITY;
  if (cached && cacheAge < maxAgeMs) return cached;

  try {
    const response = await fetch(request);
    if (response.ok && response.type === "basic") {
      await cache.put(cacheKey, response.clone());
    }
    return response;
  } catch (error) {
    if (cached) return cached;
    throw error;
  }
}

async function networkFirst(request, cacheKey = request) {
  const cache = await caches.open(SHELL_CACHE);

  try {
    const response = await fetch(request);
    if (response.ok && response.type === "basic") {
      await cache.put(cacheKey, response.clone());
    }
    return response;
  } catch (error) {
    const cached = await cache.match(cacheKey);
    if (cached) return cached;
    throw error;
  }
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname === DEVICE_DOWNLOAD_PATH) {
    event.respondWith(streamDeviceDownload(request, url));
    return;
  }

  if (url.pathname.startsWith("/api/")) return;

  if (request.mode === "navigate") {
    event.respondWith(networkFirst(request, "/"));
    return;
  }

  if (
    url.pathname.startsWith("/_next/static/") ||
    ["font", "image", "script", "style"].includes(request.destination) ||
    APP_SHELL.includes(url.pathname)
  ) {
    event.respondWith(cacheFirst(request));
  }
});
