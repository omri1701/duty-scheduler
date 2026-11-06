// Duty service worker: shows web push notifications and opens the screen each one
// links to. It caches nothing; the app always loads from the network.
const LINK = /^\/\?[a-z]+=[A-Za-z0-9=&_-]*$/;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

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
      await open.focus();
      if ('navigate' in open) {try {await open.navigate(target); return;} catch {}}
      open.postMessage({type: 'duty-open', url: link});
      return;
    }
    await self.clients.openWindow(target);
  })());
});
