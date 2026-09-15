const CACHE = 'powerwall-v3';
const PRECACHE = [
  '/',
  '/index.html'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(PRECACHE))
      .then(() => self.skipWaiting())
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
  const req = e.request;

  // Only ever handle same-origin GETs. Let the browser fetch everything else
  // (POST/PUT, cross-origin API calls to Tesla/Octopus, OAuth) natively —
  // routing those through the SW breaks on iOS 26/27 with
  // "FetchEvent.respondWith received an error: TypeError: Load failed".
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Never cache our own API calls — always go to the network for live data.
  if (url.pathname.startsWith('/.netlify/')) return;

  // Network-first for HTML so app updates reach users immediately.
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then(resp => {
          const clone = resp.clone();
          caches.open(CACHE).then(c => c.put(req, clone));
          return resp;
        })
        .catch(() => caches.match('/index.html'))
    );
    return;
  }

  // Cache-first for all other static assets (JS, icons, etc.), with a network
  // fallback that can never reject the respondWith.
  e.respondWith(
    caches.match(req).then(cached => {
      if (cached) return cached;
      return fetch(req)
        .then(resp => {
          const clone = resp.clone();
          caches.open(CACHE).then(c => c.put(req, clone));
          return resp;
        })
        .catch(() => cached);
    })
  );
});

self.addEventListener('push', e => {
  const data = e.data ? e.data.json() : { title: 'Powerwall Manager', body: '' };
  e.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/icon.svg',
      badge: '/icon.svg',
      tag: data.tag || 'powerwall',
      renotify: true
    })
  );
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const client of list) {
        if (client.url.includes(self.location.origin) && 'focus' in client) return client.focus();
      }
      return clients.openWindow('/');
    })
  );
});
