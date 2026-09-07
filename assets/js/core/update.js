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
// The check repeats while the app is open, so an update deployed mid-session is
// offered without waiting for a reload. Nothing is ever applied on its own: the
// banner lives outside the tool panel, so offering an update leaves whatever the
// user is working on exactly where it was, and only their click reloads.
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

// A minute, not seconds. version.json is a few hundred bytes, but nothing
// deploys often enough for a tighter loop to find anything, and the checks that
// actually feel instant are the event-driven ones below: returning to the tab,
// or coming back online, check straight away.
const POLL_MS = 60_000;

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
let registration = null;
const pending = new Set();

// Which update the banner is offering, and which one the user waved away. Both
// matter only because the check now repeats: without them a banner would be
// rebuilt under the user's cursor every minute, and "Later" would last exactly
// until the next tick.
let announced = null;
let dismissed = null;

// What the current banner was built from, so a language change can rebuild it in
// the new language. It sits outside the tool panel, so remounting misses it.
let shown = null;

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

/**
 * Build the banner. `note` is text from version.json and is shown as it came;
 * `noteKey` is one of our own strings and is translated at render time, so a
 * language change can rebuild the banner rather than leave it in the old one.
 */
function showBanner({ version, note, noteKey }) {
  banner?.remove();
  shown = { version, note, noteKey };

  const button = h('button', {
    type: 'button',
    class: 'btn',
    onClick: () => {
      if (applying) return;
      applying = true;
      button.disabled = true;
      button.textContent = t('Updating…');
      applyServiceWorkerUpdate();
    },
  }, icon('download', 14), t('Update now'));

  const text = noteKey ? t(noteKey) : note;

  banner = h('div', { class: 'update', role: 'status' },
    h('div', { class: 'update__text' },
      h('div', { class: 'update__title' },
        version ? `${t('Version')} ${version} ${t('is available')}` : t('An update is available')),
      text ? h('div', { class: 'update__note' }, text) : null),
    button,
    h('button', {
      type: 'button',
      class: 'btn btn--ghost',
      onClick: () => {
        // Remembered, so the next tick a minute later does not undo the click.
        // Anything newer than this carries a different target and still gets
        // through.
        dismissed = announced;
        announced = null;
        shown = null;
        banner?.remove();
        banner = null;
      },
    }, t('Later')),
  );

  document.querySelector('.update-slot')?.replaceChildren(banner);
}

/**
 * Offer an update once. `target` names the update itself rather than how it was
 * spotted, so the same deploy found by the version check and by the service
 * worker is one offer, and one dismissal covers both.
 *
 * Returns whether this call put something new on screen.
 */
function offer(target, options) {
  if (applying || target === announced || target === dismissed) return false;
  announced = target;
  showBanner(options);
  return true;
}

/**
 * Rebuild the banner in the current language. The banner sits outside the tool
 * panel, so main.js's remount does not reach it.
 */
export function refreshUpdateBanner() {
  if (banner && shown && !applying) showBanner(shown);
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
 * One check: ask what is deployed, tell anyone waiting, and offer what is new.
 *
 * Never throws and never touches the page beyond the banner slot, because this
 * runs on a timer underneath whatever the user is doing.
 */
async function check() {
  let latest;
  try {
    latest = await fetchLatest();
  } catch {
    // Offline, or version.json is not deployed yet. The app keeps working, and
    // the next tick will try again.
    return;
  }

  deployed = latest;
  pending.forEach((fn) => fn(latest));
  pending.clear();

  let fresh = false;
  if (compareVersions(latest.version, APP_VERSION) > 0) {
    fresh = offer(`v${latest.version}`, {
      version: latest.version,
      note: latest.title || latest.notes || '',
    });
  } else if (latest.build && BUILD_ID && latest.build !== BUILD_ID) {
    // Same release, different files: a push that was not cut as a release.
    // Worth offering, but not worth announcing as a new version - there is no
    // release note to show, because there was no release.
    fresh = offer(`b${latest.build}`, {
      noteKey: 'This release was rebuilt since your copy was cached.',
    });
  }

  // Only once there is something to fetch: let the worker start precaching it
  // now, so "Update now" applies immediately instead of beginning the download
  // at the click. Skipping it otherwise keeps the idle cost to one small
  // request a minute.
  if (fresh) registration?.update().catch(() => {});
}

/** The service worker found an update; name it the same as the version check would. */
function offerFromWorker(noteKey) {
  offer(deployed?.build ? `b${deployed.build}` : 'sw', { noteKey });
}

/**
 * Check on a timer, and immediately on the two events that mean a check is
 * likely to be worth something: the tab coming back to the foreground, and the
 * connection returning. A hidden tab is skipped - there is nobody to show a
 * banner to, and it would only be found again the moment it is looked at.
 */
function startPolling() {
  const tick = () => { if (!document.hidden) check(); };

  window.setInterval(tick, POLL_MS);
  document.addEventListener('visibilitychange', tick);
  window.addEventListener('online', tick);
}

/**
 * Register the service worker, check for a newer release, and keep checking.
 * Safe to call unconditionally: it does nothing harmful on file:// or offline.
 */
export async function initUpdates() {
  const online = window.location.protocol === 'http:' || window.location.protocol === 'https:';
  if (!online) return;

  if ('serviceWorker' in navigator) {
    try {
      registration = await navigator.serviceWorker.register(SW_URL, {
        scope: new URL('./', SW_URL).pathname,
      });

      // A worker already waiting means an update downloaded on a previous visit.
      if (registration.waiting && navigator.serviceWorker.controller) {
        offerFromWorker('A newer version has already been downloaded.');
      }

      registration.addEventListener('updatefound', () => {
        const installing = registration.installing;
        if (!installing) return;

        installing.addEventListener('statechange', () => {
          // `controller` is null on the very first install; that is not an update.
          if (installing.state === 'installed' && navigator.serviceWorker.controller) {
            offerFromWorker('A new version has been downloaded and is ready.');
          }
        });
      });
    } catch {
      // Registration can fail on an insecure origin. The version check below
      // still works, so this is not fatal.
    }
  }

  await check();
  startPolling();
}
