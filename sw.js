// VERSION is set by tools/stamp-version.sh, together with APP_VERSION in
// js/config.js and the ?v= stamps in index.html — tools/check.sh fails if the
// three disagree. Don't edit by hand.
//
// 2026-11-10 — split codebase: the app is now ~30 files, not one. Every CSS/JS
// URL carries ?v=VERSION and each version gets its own cache, so a new
// index.html can never be paired with an old cached script (cache entries are
// keyed by the versioned URL). A file that can't be fetched and isn't cached
// fails the load visibly (see the guard in js/init.js) rather than running a
// mix of versions. A new version means a new cache; activate deletes old ones.
const VERSION = '2026-11-12.1919';
const CACHE_NAME = 'ticket-tracker-' + VERSION;
const V = '?v=' + VERSION;
const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './css/design.css' + V,
  './css/app.css' + V,
  './js/config.js' + V,
  './js/state.js' + V,
  './js/util.js' + V,
  './js/ui-parts.js' + V,
  './js/tickets.js' + V,
  './js/delay-repay.js' + V,
  './js/darwin.js' + V,
  './js/stations.js' + V,
  './js/google.js' + V,
  './js/transport-estimates.js' + V,
  './js/watch-sync.js' + V,
  './js/confirm-train.js' + V,
  './js/journey-share.js' + V,
  './js/emergency-routes.js' + V,
  './js/home-sections.js' + V,
  './js/screen-home.js' + V,
  './js/screen-calendar.js' + V,
  './js/screen-live.js' + V,
  './js/train-status.js' + V,
  './js/train-progress-build.js' + V,
  './js/train-progress.js' + V,
  './js/settings.js' + V,
  './js/settings-trains.js' + V,
  './js/backup-restore.js' + V,
  './js/depboard.js' + V,
  './js/claims-ui.js' + V,
  './js/performance.js' + V,
  './js/buy.js' + V,
  './js/roi.js' + V,
  './js/help.js' + V,
  './js/backlog.js' + V,
  './js/easter-eggs.js' + V,
  './js/init.js' + V
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
