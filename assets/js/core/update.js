// Update checking.
//
// Two mechanisms, and they back each other up:
//
//  1. version.json is fetched on every start with `cache: 'no-store'`, so the
//     app always learns about a new release immediately, even if the service
//     worker has not noticed yet.
//  2. version.json also carries a build id, which changes whenever the shipped
//     files do. That catches a deploy that was never cut as a release, which a
//     version comparison alone cannot see.
//  3. The service worker precaches the shell. When a new one installs it waits,
//     and we surface that as the same banner.
//
// Either way the user gets one prompt and one button. Nothing has to be
// downloaded or replaced by hand.

import { APP_VERSION, BUILD_ID } from './version.js';
import { h, icon } from './dom.js';
import { t } from './i18n.js';

// Resolved against the page, not against this module: that keeps the single-file
// build working and survives being hosted from a subdirectory.
const VERSION_URL = new URL('version.json', document.baseURI);
const SW_URL = new URL('sw.js', document.baseURI);
const RELOAD_FALLBACK_MS = 4000;

/** Compare dotted versions. Returns 1, -1 or 0. */
export function compareVersions(a, b) {
  const parse = (value) =>
    String(value || '0').replace(/^v/i, '').split('.').map((part) => Number.parseInt(part, 10) || 0);

  const left = parse(a);
  const right = parse(b);
  const length = Math.max(left.length, right.length);

  for (let i = 0; i < length; i += 1) {
    const l = left[i] ?? 0;
    const r = right[i] ?? 0;
    if (l > r) return 1;
    if (l < r) return -1;
  }
  return 0;
}

let banner = null;
let applying = false;
let deployed = null;
const pending = new Set();

/**
 * What version.json last reported, or null if the check has not landed yet.
 * The About panel reads this to show the deployed build beside the running one.
 */
export function deployedRelease() {
  return deployed;
}

/**
 * Run `fn` when the version check lands, or right away if it already has.
 * Returns an unsubscribe function, for a caller's `destroy()`.
 *
 * Without this a panel built during the check would show no deployed build and
 * never correct itself - and a check still in flight is exactly when the answer
 * is worth having.
 */
export function onDeployedRelease(fn) {
  if (deployed) {
    fn(deployed);
    return () => {};
  }
  pending.add(fn);
  return () => pending.delete(fn);
}

function showBanner({ version, notes, onApply }) {
  banner?.remove();

  const button = h('button', {
    type: 'button',
    class: 'btn',
    onClick: () => {
      if (applying) return;
      applying = true;
      button.disabled = true;
      button.textContent = t('Updating…');
      onApply();
    },
  }, icon('download', 14), t('Update now'));

  banner = h('div', { class: 'update', role: 'status' },
    h('div', { class: 'update__text' },
      h('div', { class: 'update__title' },
        version ? `${t('Version')} ${version} ${t('is available')}` : t('An update is available')),
      notes ? h('div', { class: 'update__note' }, notes) : null),
    button,
    h('button', {
      type: 'button',
      class: 'btn btn--ghost',
      onClick: () => { banner?.remove(); banner = null; },
    }, t('Later')),
  );

  document.querySelector('.update-slot')?.replaceChildren(banner);
}

/** Reload, defeating any intermediate HTTP cache. */
function hardReload() {
  window.location.reload();
}

/**
 * Activate a waiting service worker and reload once it takes control.
 * Falls back to a plain reload if anything about that does not happen.
 */
async function applyServiceWorkerUpdate() {
  if (!('serviceWorker' in navigator)) { hardReload(); return; }

  try {
    const registration = await navigator.serviceWorker.getRegistration();
    if (!registration) { hardReload(); return; }

    await registration.update().catch(() => {});

    const worker = registration.waiting || registration.installing;
    if (!worker) { hardReload(); return; }

    let reloaded = false;
    const reloadOnce = () => {
      if (reloaded) return;
      reloaded = true;
      hardReload();
    };

    navigator.serviceWorker.addEventListener('controllerchange', reloadOnce, { once: true });
    worker.postMessage({ type: 'SKIP_WAITING' });

    // If the worker never takes control, reload anyway rather than hanging.
    window.setTimeout(reloadOnce, RELOAD_FALLBACK_MS);
  } catch {
    hardReload();
  }
}

/** Ask the server what the current release is. */
async function fetchLatest() {
  const url = new URL(VERSION_URL);
  url.searchParams.set('_', String(Date.now()));

  const response = await fetch(url, { cache: 'no-store', credentials: 'omit' });
  if (!response.ok) throw new Error(`version.json responded ${response.status}`);
  return response.json();
}

/**
 * Register the service worker and check for a newer release.
 * Safe to call unconditionally: it does nothing harmful on file:// or offline.
 */
export async function initUpdates() {
  const online = window.location.protocol === 'http:' || window.location.protocol === 'https:';
  if (!online) return;

  if ('serviceWorker' in navigator) {
    try {
      const registration = await navigator.serviceWorker.register(SW_URL, {
        scope: new URL('./', SW_URL).pathname,
      });

      // A worker already waiting means an update downloaded on a previous visit.
      if (registration.waiting && navigator.serviceWorker.controller) {
        showBanner({ version: null, notes: t('A newer version has already been downloaded.'), onApply: applyServiceWorkerUpdate });
      }

      registration.addEventListener('updatefound', () => {
        const installing = registration.installing;
        if (!installing) return;

        installing.addEventListener('statechange', () => {
          // `controller` is null on the very first install; that is not an update.
          if (installing.state === 'installed' && navigator.serviceWorker.controller) {
            showBanner({ version: null, notes: t('A new version has been downloaded and is ready.'), onApply: applyServiceWorkerUpdate });
          }
        });
      });
    } catch {
      // Registration can fail on an insecure origin. The version check below
      // still works, so this is not fatal.
    }
  }

  try {
    const latest = await fetchLatest();
    deployed = latest;
    pending.forEach((fn) => fn(latest));
    pending.clear();

    if (compareVersions(latest.version, APP_VERSION) > 0) {
      showBanner({
        version: latest.version,
        notes: latest.title || latest.notes || '',
        onApply: applyServiceWorkerUpdate,
      });
    } else if (latest.build && BUILD_ID && latest.build !== BUILD_ID) {
      // Same release, different files: a push that was not cut as a release.
      // Worth offering, but not worth announcing as a new version - there is no
      // release note to show, because there was no release.
      showBanner({
        version: null,
        notes: t('This release was rebuilt since your copy was cached.'),
        onApply: applyServiceWorkerUpdate,
      });
    }
  } catch {
    // Offline, or the file is not deployed yet. The app keeps working.
  }
}
