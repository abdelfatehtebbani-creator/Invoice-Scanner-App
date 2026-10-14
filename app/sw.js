/* Service worker: keeps the app shell available so the app opens instantly and
   installs as a PWA. Invoice data always goes to the network (the API is on
   another origin and is never cached). Bump VERSION on every release. */
const VERSION = 'invoice-scanner-v2.0.0';
const SHELL = [
  './', 'index.html', 'manifest.webmanifest', 'css/app.css', 'js/config.js', 'js/shared.js', 'js/app.js',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  // Network first so a new release is picked up; the cache is the offline fallback.
  e.respondWith(
    fetch(new Request(e.request, { cache: 'no-cache' })).then((res) => {
      const copy = res.clone();
      caches.open(VERSION).then((c) => c.put(e.request, copy));
      return res;
    }).catch(() => caches.match(e.request, { ignoreSearch: true }).then((r) => r || caches.match('index.html')))
  );
});
