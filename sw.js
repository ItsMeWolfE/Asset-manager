// Service worker: offline shell plus the update handshake.
//
// CACHE_VERSION is rewritten by tools/release.sh together with version.json and
// core/version.js. Changing it is what makes the browser install a new worker,
// which is what surfaces the update prompt in the page.

const CACHE_VERSION = '3.3.0';
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
  './assets/js/i18n/index.js',
  './assets/js/i18n/he.js',
  './assets/js/core/segment.js',
  './assets/js/workers/segment-worker.js',
  './assets/js/workers/crop-worker-source.js',
  './assets/js/vendor/sheet-worker-source.js',
];

// "Asset Manager.html" is deliberately not precached. It is the double-click
// launcher, meant to live on a desktop rather than be served, and it only ever
// redirects here.

// Neither is the background-removal model or the ONNX runtime beside it: ~16 MB
// that only matters to someone who turns the option on. They get their own
// cache, named for the model rather than the release, because they change far
// more rarely than the app does - putting them in the versioned shell cache
// would make every release re-download the lot. Bump this name when the model
// itself is replaced.
const MODEL_CACHE = 'asset-manager-model-v1';

/** Heavyweight, rarely-changing assets that outlive a release. */
function isModelAsset(url) {
  return url.pathname.includes('/assets/models/') ||
    url.pathname.includes('/assets/vendor/onnxruntime/');
}

const SCOPE_PATH = new URL('./', self.location).pathname;

/** True only for the app's own entry point, not for other pages in scope. */
function isAppShell(url) {
  return url.pathname === SCOPE_PATH || url.pathname === `${SCOPE_PATH}index.html`;
}

/** The precached shell, read from this release's cache only. */
async function cachedShell() {
  const cache = await caches.open(CACHE_NAME);
  return (await cache.match('./index.html')) || (await cache.match('./'));
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

  // Navigations: cache first, like every other asset. The precached shell is
  // the local copy of the app, so launching it reaches the network for nothing
  // but version.json - online or off, on the desktop or in an installed window.
  //
  // Releases still arrive. The browser revalidates sw.js on navigation whatever
  // this handler answers with; a changed CACHE_VERSION installs a new worker,
  // which precaches the next shell under a new cache name and prompts through
  // core/update.js. Accepting that prompt activates it, drops the old cache in
  // `activate`, and reloads - and this lookup then finds the new shell.
  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      // Only the app's own entry point is answered from the shell cache. Other
      // pages served from this scope - the launcher, for one - are not the app
      // and must not be handed index.html in their place.
      if (isAppShell(url)) {
        const cached = await cachedShell();
        if (cached) return cached;
      }

      try {
        const response = await fetch(request);
        // Cache only a real shell response. Storing an error page under the
        // index.html key used to self-correct on the next online load; now that
        // this lookup comes first, it would be served until the next release.
        if (isAppShell(url) && response.ok) {
          const cache = await caches.open(CACHE_NAME);
          cache.put('./index.html', response.clone());
        }
        return response;
      } catch {
        return (await cachedShell()) || Response.error();
      }
    })());
    return;
  }

  // The model and its runtime: cache first, in the cache that survives releases.
  if (isModelAsset(url)) {
    event.respondWith((async () => {
      const cache = await caches.open(MODEL_CACHE);
      const cached = await cache.match(request);
      if (cached) return cached;

      const response = await fetch(request);
      if (response.ok) cache.put(request, response.clone());
      return response;
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
