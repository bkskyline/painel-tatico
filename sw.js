const CACHE_NAME = "painel-tatico-v3";
const ASSETS = [
  "./",
  "./index.html",
  "./manifest.json",
  "./js/app.js",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;

  // The Cache API only supports GET requests. POST/PUT/etc (like the Lichess import call,
  // or the CORS-proxy-relayed requests) must always go straight to the network, uncached —
  // trying to cache.put() a non-GET response throws and can otherwise break the request.
  if (req.method !== "GET") {
    event.respondWith(fetch(req));
    return;
  }

  // Network-first for CDN scripts (React, chess.js, Stockfish) and any proxied/cross-origin
  // request, cache-first for local same-origin assets.
  if (req.url.includes("unpkg.com") || req.url.includes("jsdelivr.net") || req.url.includes("cdnjs.cloudflare.com") || req.url.includes("corsproxy.io") || req.url.includes("lichess.org")) {
    event.respondWith(
      fetch(req).then((res) => {
        const resClone = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(req, resClone)).catch(() => {});
        return res;
      }).catch(() => caches.match(req))
    );
    return;
  }

  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((res) => {
        const resClone = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(req, resClone)).catch(() => {});
        return res;
      }).catch(() => cached);
    })
  );
});
