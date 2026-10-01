// Service worker for the hosted (GitHub Pages) version.
// The build script stamps VERSION / VENDOR_ID / SHELL; any change produces a new SW → update prompt.
const VERSION = 'dev';
const VENDOR_ID = 'dev';
const SHELL = [
  './', './index.html', './app.css', './manifest.webmanifest',
  './js/app.js', './js/config.js', './js/platform.js', './js/updater.js', './js/convert-image.js',
  './js/convert-av.js', './js/ffmpeg-args.js', './js/gif-encoder.js', './js/gif-worker.js', './js/formats.js',
  './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png',
];

const SHELL_CACHE = `shell-${VERSION}`;
const VENDOR_CACHE = `vendor-${VENDOR_ID}`;

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL_CACHE).then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' })))));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key !== SHELL_CACHE && key !== VENDOR_CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  const path = url.pathname;
  // Never cache update metadata or bundles
  if (/\/(update|version)\.json$/.test(path) || path.includes('/updates/')) return;

  // Big engine files: cache on first use, then serve offline
  if (path.includes('/vendor/')) {
    event.respondWith((async () => {
      const cache = await caches.open(VENDOR_CACHE);
      const hit = await cache.match(req, { ignoreSearch: true });
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) cache.put(req, res.clone());
      return res;
    })());
    return;
  }

  // App shell: cache first, fall back to network, then to index.html for navigations
  event.respondWith((async () => {
    const cache = await caches.open(SHELL_CACHE);
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    try {
      return await fetch(req);
    } catch (e) {
      if (req.mode === 'navigate') return (await cache.match('./index.html')) || Response.error();
      throw e;
    }
  })());
});
