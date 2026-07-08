// sw.js
// PWA cache for СкладСборка.
// Кэшируем только оболочку сайта. API/Firebase/Cloudinary/notify НЕ кэшируем.

const CACHE_VERSION = "sklad-pwa-v3-2026-07-08-block-empty-car";

const APP_SHELL = [
  "/",
  "/index.html",
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png"
];

self.addEventListener("install", event => {
  console.log("[SW] install:", CACHE_VERSION);

  event.waitUntil(
    caches
      .open(CACHE_VERSION)
      .then(cache => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", event => {
  console.log("[SW] activate:", CACHE_VERSION);

  event.waitUntil(
    caches
      .keys()
      .then(keys => {
        return Promise.all(
          keys
            .filter(key => key !== CACHE_VERSION)
            .map(key => caches.delete(key))
        );
      })
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", event => {
  const req = event.request;

  if (req.method !== "GET") {
    return;
  }

  const url = new URL(req.url);

  if (url.origin !== self.location.origin) {
    return;
  }

  if (url.pathname.startsWith("/api/")) {
    return;
  }

  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then(res => {
          const copy = res.clone();

          caches.open(CACHE_VERSION).then(cache => {
            cache.put("/", copy.clone());
            cache.put("/index.html", copy);
          });

          return res;
        })
        .catch(() => caches.match("/index.html"))
    );

    return;
  }

  event.respondWith(
    caches.match(req).then(cached => {
      if (cached) return cached;

      return fetch(req).then(res => {
        if (!res || res.status !== 200) {
          return res;
        }

        const copy = res.clone();

        caches.open(CACHE_VERSION).then(cache => {
          cache.put(req, copy);
        });

        return res;
      });
    })
  );
});
