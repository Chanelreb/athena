/* Athena service worker — installable + offline, and never stale online.
   Strategy: NETWORK-FIRST for same-origin GETs. When online you always get the
   freshest file and we refresh the cache; when offline we serve the last good
   copy (falling back to the app shell for navigations). All user data lives in
   localStorage / Supabase, never here. */
const CACHE = 'athena-shell-v17';
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
  // The update check must reach the real server, or a stale copy can never
  // notice that it is the stale one. Never intercept it, never cache it.
  if (url.pathname.endsWith('/version.json')) return;
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
        return res;
      })
      .catch(() => caches.match(req).then((hit) => {
        if (hit) return hit;
        // Only a page navigation may fall back to the app shell. Handing
        // index.html to a <script> tag that asked for a .js file means the
        // browser parses HTML as JavaScript, the script silently does not
        // exist, and the app carries on without it. That is how a flaky
        // moment on a phone turned into Athena quietly losing its sign-in
        // library and dropping to local-only storage for good.
        if (req.mode === 'navigate') return caches.match('./index.html');
        return new Response('', { status: 504, statusText: 'Offline and not cached' });
      }))
  );
});
