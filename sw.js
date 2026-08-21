const CACHE_NAME = 'ticket-tracker-v4';
const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Network-first for the app's own files: always try to fetch the latest
// version first, so updates show up the moment you reopen the app with a
// connection. Only falls back to the last cached copy if the network
// request fails (i.e. genuinely offline). Cross-origin requests (e.g. the
// bank holidays API) are left alone below so the app's own fetch logic
// handles them directly.
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return; // let the browser handle it normally

  // 'no-store' bypasses the browser's own HTTP disk cache too, not just the
  // service worker's Cache API — GitHub Pages/its CDN can otherwise serve a
  // cached response for a short window after a deploy, which looked
  // identical to a stuck service worker but was actually a separate cache.
  event.respondWith(
    fetch(event.request, { cache: 'no-store' })
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
