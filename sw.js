/* Athena service worker — makes the app installable and usable offline.
   Strategy: stale-while-revalidate for same-origin GETs. The app shell serves
   instantly from cache and refreshes in the background; bump CACHE on release to
   evict old files. All user data lives in localStorage (Phase B: Supabase), not here. */
const CACHE = 'athena-shell-v2';
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './supabase-config.js',
  './vendor/supabase.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  e.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(req);
      const network = fetch(req)
        .then((res) => { if (res && res.ok) cache.put(req, res.clone()); return res; })
        .catch(() => null);
      return cached || (await network) || cache.match('./index.html');
    })
  );
});
