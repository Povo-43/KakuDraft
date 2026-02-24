const CACHE_VERSION = 'v7';
const APP_CACHE = `kakudraft-app-${CACHE_VERSION}`;
const RUNTIME_CACHE = `kakudraft-runtime-${CACHE_VERSION}`;
const FONT_CACHE = `kakudraft-font-${CACHE_VERSION}`;

const APP_SHELL = [
  './',
  './index.html',
  './callback/index.html',
  './help.html',
  './app.css',
  './app-core.js',
  './app-storage.js',
  './app-github.js',
  './app-editor.js',
  './app-ai.js',
  './app-ui.js',
  './manifest.json',
  './icon.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(APP_CACHE);
    await cache.addAll(APP_SHELL);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keep = new Set([APP_CACHE, RUNTIME_CACHE, FONT_CACHE]);
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => !keep.has(k)).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const fetchPromise = fetch(request).then((response) => {
    if (response && response.ok) cache.put(request, response.clone());
    return response;
  }).catch(() => cached);
  return cached || fetchPromise;
}

async function networkFirst(request, cacheName, fallbackRequest) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    if (response && response.ok) cache.put(request, response.clone());
    return response;
  } catch {
    const cached = await cache.match(request);
    if (cached) return cached;
    if (fallbackRequest) {
      const fallback = await caches.match(fallbackRequest);
      if (fallback) return fallback;
    }
    throw new Error('no-response');
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  const isSameOrigin = url.origin === self.location.origin;
  const isFont = url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com';

  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request, RUNTIME_CACHE, './index.html'));
    return;
  }

  if (isSameOrigin) {
    if (url.pathname.endsWith('.js') || url.pathname.endsWith('.css') || url.pathname.endsWith('.html') || url.pathname.endsWith('.png') || url.pathname.endsWith('.json')) {
      event.respondWith(staleWhileRevalidate(request, APP_CACHE));
      return;
    }
    event.respondWith(networkFirst(request, RUNTIME_CACHE));
    return;
  }

  if (isFont) {
    event.respondWith(staleWhileRevalidate(request, FONT_CACHE));
  }
});
