/*
 * Keeps the display working through a network outage. The shell is served from
 * cache first (it changes only on deploy), while prayer data is fetched fresh
 * and falls back to cache - so a dropped connection costs nothing, but a
 * monthly data refresh is picked up on the next load.
 */

// Bump on every change to a shell file. The shell is served cache-first, so an
// unchanged version means a display that is already running keeps the app.js it
// cached on its first visit and never sees a fix.
const VERSION = 'azaming-v3';

const SHELL = [
  './',
  'index.html',
  'styles.css',
  'app.js',
  'manifest.webmanifest',
  'audio/adhan.mp3',
  'audio/adhan-fajr.mp3',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSION).then((cache) =>
      // Individually, so a missing audio file does not fail the whole install.
      Promise.allSettled(SHELL.map((url) => cache.add(url))),
    ),
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname.includes('/data/')) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(VERSION).then((cache) => cache.put(request, copy));
          return response;
        })
        .catch(() => caches.match(request)),
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((hit) => hit ?? fetch(request)),
  );
});
