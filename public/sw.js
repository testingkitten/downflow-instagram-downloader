const SHELL_CACHE = "download-images-shell-v2";
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

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;

  if (request.mode === "navigate") {
    event.respondWith(cacheFirst(request, "/", 60 * 60 * 1000));
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
