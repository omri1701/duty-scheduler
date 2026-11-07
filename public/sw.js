// Duty service worker: web push notifications that open the screen each one links to, and an
// offline app shell (decision 2026-11-06): the document, its static assets and the public
// configuration are cached, so the last schedule the app saved stays viewable with no network.
// Team data itself is never cached here; the app keeps its last snapshot per member.
const CACHE = 'duty-shell-v1';
const SHELL = ['/', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png', '/favicon.svg'];
const LINK = /^\/\?[a-z]+=[A-Za-z0-9=&_-]*$/;

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).catch(() => {}).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', event => {
  const {request} = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // The document and the public configuration: the network first, the last copy without it.
  if (request.mode === 'navigate' || url.pathname === '/api/config') {
    const key = request.mode === 'navigate' ? '/' : url.pathname;
    event.respondWith(fetch(request).then(response => {
      if (response.ok) caches.open(CACHE).then(cache => cache.put(key, response.clone())).catch(() => {});
      return response;
    }).catch(() => caches.match(key).then(cached => cached ?? Response.error())));
    return;
  }
  // Hashed static assets never change: the cache first, filled from the network.
  if (url.pathname.startsWith('/_next/static/') || SHELL.includes(url.pathname)) {
    event.respondWith(caches.match(request).then(cached => cached ?? fetch(request).then(response => {
      if (response.ok) caches.open(CACHE).then(cache => cache.put(request, response.clone())).catch(() => {});
      return response;
    })));
  }
});

self.addEventListener('push', event => {
  let data = {};
  try {data = event.data ? event.data.json() : {};} catch {data = {};}
  const text = value => typeof value === 'string' ? value.slice(0, 200) : '';
  const lang = data.lang === 'he' ? 'he' : 'en';
  const url = typeof data.url === 'string' && LINK.test(data.url) ? data.url : '/';
  event.waitUntil(self.registration.showNotification(text(data.title) || 'Duty', {
    body: text(data.body), lang, dir: lang === 'he' ? 'rtl' : 'ltr', tag: text(data.tag) || undefined,
    icon: '/icon-192.png', badge: '/icon-192.png', data: {url},
  }));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const link = event.notification.data && LINK.test(event.notification.data.url) ? event.notification.data.url : '/';
  const target = new URL(link, self.location.origin).href;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({type: 'window', includeUncontrolled: true});
    const open = windows.find(client => new URL(client.url).origin === self.location.origin);
    if (open) {
      // The open app switches tab and month itself, keeping any unsaved edit (no reload).
      open.postMessage({type: 'duty-open', url: link});
      await open.focus();
      return;
    }
    await self.clients.openWindow(target);
  })());
});
