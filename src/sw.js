'use strict';

// Offline support only. The build fills in VERSION and ASSETS.
const VERSION = "__BIP39_VERSION__";
const ASSETS = ["__BIP39_ASSETS__"];
const CACHE = 'bip39-' + VERSION;
const ROOT = new URL('./', self.location.href).pathname;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      // 'no-cache' revalidates with the server, so a stale HTTP-cache copy is never precached.
      .then((cache) => cache.addAll(ASSETS.map((url) => new Request(url, { cache: 'no-cache' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys
        .filter((key) => key.startsWith('bip39-') && key !== CACHE)
        .map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    // Network first, so a new deployment is picked up as soon as it is online.
    event.respondWith(
      fetch(request, { cache: 'no-cache' }).then((response) => {
        // Only the page itself refreshes the offline copy (not e.g. a visit to /sw.js), and never from a URL
        // with a query: the cached response keeps its URL, and inbound links carry ids (utm_*, fbclid, gclid).
        if (response.ok && response.type === 'basic' && url.pathname === ROOT && !url.search) {
          const copy = response.clone();
          event.waitUntil(caches.open(CACHE).then((cache) => cache.put('./', copy)));
        }
        return response;
      }, () => caches.match('./').then((cached) => cached || Response.error()))
    );
    return;
  }

  event.respondWith(caches.match(request).then((cached) => cached || fetch(request)));
});
