/* Athena service worker — installable + offline, and never stale online.
   Strategy: NETWORK-FIRST for same-origin GETs. When online you always get the
   freshest file and we refresh the cache; when offline we serve the last good
   copy (falling back to the app shell for navigations). All user data lives in
   localStorage / Supabase, never here. */
const CACHE = 'athena-shell-v44';
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
      // Keep the share cache. It holds a photo someone is part way through
      // sending us, and an update landing at that moment must not eat it.
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== 'athena-share').map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/* ---- share target (Android) ----
   Android hands a share to the app as a POST, which a static site has nowhere
   to receive. The service worker is the receiver: it takes the form data,
   parks it in a cache of its own, and bounces the browser to the app with a
   flag. The page picks it up on the way in and empties the cache. */
const SHARE_CACHE = 'athena-share';
const SHARE_META = './__share/meta';

async function receiveShare(request){
  try {
    const form = await request.formData();
    const files = form.getAll('photos').filter((f) => f && f.size);
    const cache = await caches.open(SHARE_CACHE);
    const keys = [];
    for (let i = 0; i < files.length; i++){
      const key = './__share/' + Date.now() + '-' + i;
      await cache.put(new Request(key), new Response(files[i], {
        headers: { 'Content-Type': files[i].type || 'application/octet-stream' }
      }));
      keys.push(key);
    }
    await cache.put(new Request(SHARE_META), new Response(JSON.stringify({
      title: form.get('title') || '', text: form.get('text') || '',
      url: form.get('url') || '', files: keys
    }), { headers: { 'Content-Type': 'application/json' } }));
  } catch (_){ /* fall through: better an empty app than a dead end */ }
  // 303 so the browser turns the POST into a GET.
  return Response.redirect('./?shared=1', 303);
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method === 'POST' && url.pathname.endsWith('/share')){
    e.respondWith(receiveShare(req));
    return;
  }
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

/* ---- nudges ----
   The payload arrives already worded: Athena decided what to say when it wrote
   the queue, days ago, because that is the only place that knows what a block
   or a task is. Nothing is worked out here. */
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_){ d = {}; }
  e.waitUntil(self.registration.showNotification(d.title || 'Athena', {
    body: d.body || '',
    // A tag replaces rather than stacks. Two reminders about the same block,
    // because two devices are subscribed or because one arrived late, should
    // be one line on the lock screen, not two.
    tag: d.tag || 'athena',
    icon: './icons/icon-192.png',
    badge: './icons/icon-192.png',
    data: { url: d.url || './' }
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || './';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      // Reuse a window that is already open rather than piling up tabs. Only
      // navigate it if it is not already where the nudge wanted to go.
      for (const c of list){
        if (!('focus' in c)) continue;
        const want = new URL(url, self.location.origin).href;
        if (c.url !== want && 'navigate' in c) return c.navigate(want).then((w) => (w || c).focus());
        return c.focus();
      }
      return self.clients.openWindow(url);
    })
  );
});
