const CACHE = 'mac-deck-v2'; // bumped → old v1 cache is wiped on activate
const STATIC = ['/manifest.json', '/icon.svg', '/icon-maskable.svg'];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(STATIC))
      .then(() => self.skipWaiting()) // activate immediately, don't wait for old tabs to close
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;

  const url = new URL(e.request.url);

  // ── Network-first for HTML ─────────────────────────────────────────────────
  // Always fetch fresh index.html. Only fall back to cache if server is down.
  if (url.pathname === '/' || url.pathname.endsWith('.html')) {
    e.respondWith(
      fetch(e.request).catch(() => caches.match('/'))
    );
    return;
  }

  // ── Skip live API routes (never cache) ────────────────────────────────────
  if (url.pathname.startsWith('/api/') || url.pathname === '/config.json') return;

  // ── Cache-first for static assets (icons, manifest) ───────────────────────
  e.respondWith(
    caches.match(e.request).then(cached =>
      cached || fetch(e.request).then(res => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return res;
      })
    )
  );
});
