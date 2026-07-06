// sw.js
// PWA cache for "Складская доска".
// Кэшируем только оболочку сайта. Firebase/Google/API/внешние домены НЕ кэшируем.

const CACHE_VERSION = "warehouse-board-pwa-v1-2026-07-06";

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

  // Внешние сервисы не кэшируем:
  // Firebase, Google SDK, Cloudinary, notify, любые другие домены.
  if (url.origin !== self.location.origin) {
    return;
  }

  // API не кэшируем вообще.
  if (url.pathname.startsWith("/api/")) {
    return;
  }

  // Открытие страницы: сначала сеть, если сеть не отвечает — кэш.
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

  // Локальная статика: кэш, потом сеть.
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
