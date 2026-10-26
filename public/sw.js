// SGS AI hub service worker. Caches the site shell for offline use. It never caches API
// responses, launch links or anything carrying credentials.
const VERSION = '__ASSET_VERSION__';
const SHELL_CACHE = `sgsai-shell-${VERSION}`;
const SHELL = [
  '/offline/',
  '/workspace/',
  '/assets/css/global.css?v=__ASSET_VERSION__',
  '/assets/css/account.css?v=__ASSET_VERSION__',
  '/assets/css/hub.css?v=__ASSET_VERSION__',
  '/assets/js/app.js?v=__ASSET_VERSION__',
  '/assets/fonts/manrope-latin.woff2',
  '/assets/fonts/dm-sans-latin.woff2',
  '/logo/android-chrome-192x192.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL)));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key.startsWith('sgsai-') && key !== SHELL_CACHE).map((key) => caches.delete(key)))).then(() => self.clients.claim()));
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

function bypass(url, request) {
  return request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/') || request.headers.has('authorization');
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (bypass(url, request)) return;

  if (request.mode === 'navigate') {
    // Network first; offline falls back to the cached page or the offline page. /go/ links are never cached.
    event.respondWith(fetch(request).then((response) => {
      if (response.ok && !url.pathname.startsWith('/go/') && SHELL.includes(url.pathname)) {
        const copy = response.clone();
        caches.open(SHELL_CACHE).then((cache) => cache.put(request, copy));
      }
      return response;
    }).catch(async () => (await caches.match(request)) ?? caches.match('/offline/')));
    return;
  }

  if (/\.(css|js|woff2|png|jpg|webp|svg|ico)$/.test(url.pathname)) {
    // Stale-while-revalidate for static assets.
    event.respondWith(caches.open(SHELL_CACHE).then(async (cache) => {
      const cached = await cache.match(request);
      const network = fetch(request).then((response) => {
        if (response.ok) cache.put(request, response.clone());
        return response;
      }).catch(() => cached);
      return cached ?? network;
    }));
  }
});
