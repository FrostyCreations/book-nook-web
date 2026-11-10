// Keeps the app itself available offline, so books already on the shelf can be read without internet.
// Fresh copies are always preferred when online; the saved copy is only used when the network fails.

const CACHE = 'booknook-v1';
const SHELL = ['./', 'index.html', 'styles.css', 'app.js', 'manifest.webmanifest',
  'core/store.js', 'core/sources.js', 'core/epub.js', 'core/scantext.js', 'core/ocr.js', 'core/links.js',
  'vendor/jszip.min.js', 'icons/icon-192.png', 'icons/apple-touch-icon.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys()
    .then((names) => Promise.all(names.filter((name) => name !== CACHE).map((name) => caches.delete(name))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.includes('/api/')) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const fresh = await fetch(request);
      if (fresh.ok) cache.put(request, fresh.clone());
      return fresh;
    } catch (error) {
      const saved = await cache.match(request, { ignoreSearch: true });
      if (saved) return saved;
      throw error;
    }
  })());
});
