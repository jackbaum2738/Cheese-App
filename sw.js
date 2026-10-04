'use strict';

/* Service worker: makes Cheese work offline.
   Bump VERSION whenever you change any app file, so phones fetch the new files. */
const VERSION = 'v4';
const CACHE = `cheese-${VERSION}`;

// All paths are relative to this file, so this works from any GitHub Pages subpath.
const SHELL = [
  './',
  'index.html',
  'styles.css',
  'app.js',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(SHELL.map((url) => new Request(url, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k.startsWith('cheese-') && k !== CACHE).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// Stale-while-revalidate: answer from the cache straight away, refresh it in the background.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  event.respondWith(respond(event));
});

async function respond(event) {
  const req = event.request;
  const cache = await caches.open(CACHE);
  const cached =
    (await cache.match(req.url, { ignoreSearch: true })) ||
    (req.mode === 'navigate' ? await cache.match('index.html') : undefined);

  const refresh = fetch(req.url, { cache: 'no-cache' })
    .then((res) => {
      if (res && res.status === 200) cache.put(req.url, res.clone());
      return res;
    })
    .catch(() => null);

  if (cached) {
    event.waitUntil(refresh);
    return cached;
  }
  return (await refresh) || Response.error();
}
