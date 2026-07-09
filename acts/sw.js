// /acts/sw.js
// Отдельный service worker только для внутреннего PWA "Акты Docke".
// Клиентская форма /act-client.html НЕ входит в это приложение.

const CACHE_NAME = "akt-pwa-v23-internal-only";

const APP_SHELL = [
  "/acts/",
  "/acts/index.html",
  "/acts/akt-create.html",
  "/acts/akt-journal.html",
  "/acts/akt-settings.html",
  "/acts/akt-admin.html",
  "/acts/manifest.webmanifest",
  "/acts/icons/icon-192.png",
  "/acts/icons/icon-512.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("akt-pwa-") && k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Клиентская форма не часть PWA. Старый путь только редиректит, не кэшируем.
  if (url.pathname === "/acts/akt-client.html") return;

  // API/Firebase/Cloudinary не трогаем.
  if (url.pathname.startsWith("/api/")) return;

  if (req.headers.get("accept")?.includes("text/html")) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
          return res;
        })
        .catch(() => caches.match(req).then((r) => r || caches.match("/acts/index.html")))
    );
    return;
  }

  event.respondWith(caches.match(req).then((cached) => cached || fetch(req)));
});
