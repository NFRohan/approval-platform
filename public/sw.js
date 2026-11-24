// =====================================================================
// The service worker: what makes the portal an app on a phone.
//
//   * Installable, opening full screen from the home screen
//     (/manifest.webmanifest).
//   * The built scripts and styles are cached as they are fetched: their
//     names carry a hash, so a cached copy is never stale, and the app
//     opens fast on a slow connection.
//   * Pages always come from the network — approvals are live data — and
//     a page asked for with no connection shows /offline.html instead of
//     the browser's error.
//   * Push notifications: what the bell shows, on the lock screen, even
//     with the app closed; tapping one opens the request.
// =====================================================================

const STATIC = 'ams-static-v1';
const SHELL = ['/offline.html', '/icons/icon-192.png', '/icons/badge-72.png', '/manifest.webmanifest', '/favicon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(STATIC).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== STATIC) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Hashed build output and icons: cache first, then keep.
  if (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/icons/')) {
    event.respondWith((async () => {
      const cache = await caches.open(STATIC);
      const hit = await cache.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) cache.put(req, res.clone());
      return res;
    })());
    return;
  }

  // A page: from the network, or the offline page.
  if (req.mode === 'navigate') {
    event.respondWith(fetch(req).catch(async () => (await caches.match('/offline.html')) ?? Response.error()));
  }
});

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { body: event.data ? event.data.text() : '' }; }
  const title = data.title || 'Admin Services Portal';
  event.waitUntil(self.registration.showNotification(title, {
    body: data.body || '',
    icon: '/icons/icon-192.png',
    badge: '/icons/badge-72.png',
    tag: data.tag || undefined,
    renotify: !!data.tag,
    data: { url: data.url || '/' },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || '/', self.location.origin).href;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of windows) {
      if (new URL(w.url).origin === self.location.origin && 'focus' in w) {
        await w.focus();
        if ('navigate' in w) await w.navigate(target);
        return;
      }
    }
    await self.clients.openWindow(target);
  })());
});
