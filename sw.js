// Service worker: offline shell plus the update handshake.
//
// CACHE_VERSION is rewritten by tools/release.sh together with version.json and
// core/version.js. Changing it is what makes the browser install a new worker,
// which is what surfaces the update prompt in the page.

const CACHE_VERSION = '3.1.0';
const CACHE_NAME = `asset-manager-shell-${CACHE_VERSION}`;

// Everything needed to boot with no network.
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './assets/css/app.css',
  './assets/js/main.js',
  './assets/js/core/version.js',
  './assets/js/core/dom.js',
  './assets/js/core/prefs.js',
  './assets/js/core/i18n.js',
  './assets/js/core/ui.js',
  './assets/js/core/files.js',
  './assets/js/core/image.js',
  './assets/js/core/sheet.js',
  './assets/js/core/sanitize.js',
  './assets/js/core/update.js',
  './assets/js/tools/cropper.js',
  './assets/js/tools/resizer.js',
  './assets/js/tools/cleaner.js',
  './assets/js/tools/dragon.js',
  './assets/js/tools/price.js',
  './assets/js/tools/about.js',
  './assets/js/data/about.js',
  './assets/js/data/changelog.js',
  './assets/js/data/i18n-he.js',
  './assets/js/workers/crop-worker-source.js',
  './assets/js/vendor/sheet-worker-source.js',
];

// "Asset Manager.html" is deliberately not precached. It is the double-click
// launcher, meant to live on a desktop rather than be served, and it only ever
// redirects here.

const SCOPE_PATH = new URL('./', self.location).pathname;

/** True only for the app's own entry point, not for other pages in scope. */
function isAppShell(url) {
  return url.pathname === SCOPE_PATH || url.pathname === `${SCOPE_PATH}index.html`;
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    // addAll is atomic: one bad URL would leave the app half-cached, so each
    // entry is added individually and a failure is logged rather than fatal.
    await Promise.all(SHELL.map(async (url) => {
      try {
        await cache.add(new Request(url, { cache: 'reload' }));
      } catch {
        // A missing optional file must not block the install.
      }
    }));
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names
      .filter((name) => (name.startsWith('asset-manager-shell-') || name.startsWith('bam-shell-')) && name !== CACHE_NAME)
      .map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

// The page asks the waiting worker to take over when the user accepts an update.
self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // version.json must never be answered from cache: it is the update check.
  if (url.pathname.endsWith('/version.json')) {
    event.respondWith(fetch(request, { cache: 'no-store' }).catch(() => caches.match(request)));
    return;
  }

  // Navigations: network first, so a deployed update is picked up on reload,
  // with the cached shell as the offline fallback.
  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const response = await fetch(request);
        // Only the app shell belongs under the index.html key. Any other page
        // served from this scope - the launcher, for one - would otherwise
        // overwrite it and be handed back in its place when offline.
        if (isAppShell(url)) {
          const cache = await caches.open(CACHE_NAME);
          cache.put('./index.html', response.clone());
        }
        return response;
      } catch {
        return (await caches.match('./index.html')) || (await caches.match('./')) || Response.error();
      }
    })());
    return;
  }

  // Everything else: cache first. Cache names are versioned, so a new release
  // never serves a stale asset.
  event.respondWith((async () => {
    const cached = await caches.match(request);
    if (cached) return cached;

    try {
      const response = await fetch(request);
      if (response.ok && response.type === 'basic') {
        const cache = await caches.open(CACHE_NAME);
        cache.put(request, response.clone());
      }
      return response;
    } catch {
      return Response.error();
    }
  })());
});
