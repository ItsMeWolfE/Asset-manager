// About - what every tool does, how to use it, and the release history.

import { h, icon } from '../core/dom.js';
import { t } from '../core/i18n.js';
import { prefs } from '../core/prefs.js';
import { pageHead } from '../core/ui.js';
import { ABOUT } from '../data/about.js';
import { CHANGELOG } from '../data/changelog.js';
import { APP_VERSION, BUILD_ID } from '../core/version.js';
import { deployedRelease, onDeployedRelease } from '../core/update.js';

// The documentation data uses the 2.x icon names.
const ICON_MAP = {
  Crop: 'crop',
  Resize: 'resize',
  FileText: 'fileText',
  Table: 'table',
  BadgeDollar: 'badgeDollar',
  Settings: 'settings',
  Refresh: 'refresh',
};

function renderGroup(group) {
  if (group.type === 'ol' || group.type === 'ul') {
    return h('div', null,
      h('h4', null, group.h),
      h(group.type === 'ol' ? 'ol' : 'ul', null,
        ...group.items.map((item) => h('li', null, item))));
  }

  return h('div', null,
    h('h4', null, group.h),
    ...group.items.map((item) => h('p', null, item)));
}

/** An ISO timestamp in the reader's own locale and zone, or null if unusable. */
function formatStamp(iso) {
  const at = new Date(iso ?? '');
  if (Number.isNaN(at.getTime())) return null;

  // Deliberately not dateStyle/timeStyle: mixing those with timeZoneName throws,
  // and a deploy time without a zone is a time you cannot act on.
  return at.toLocaleString(prefs.lang, {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
  });
}

/**
 * What the server last published, when, and whether this copy matches it.
 *
 * The point of the pair: two copies can both report 3.3.0 and still be running
 * different code, so the version alone cannot answer "am I current". The build
 * ids can, and version.json is never cached, so the comparison is against what
 * the server has right now rather than whenever this copy was cached.
 */
function buildLines() {
  const deployed = deployedRelease();
  const when = formatStamp(deployed?.built);

  const latest = deployed?.build
    ? `${t('Latest build')} ${deployed.build}${when ? ` · ${t('pushed')} ${when}` : ''}`
    : t('The server could not be reached, so the latest build is unknown.');

  let running = `${t('Running build')} ${BUILD_ID}`;
  if (deployed?.build) {
    running += ` — ${deployed.build === BUILD_ID ? t('this copy is up to date.') : t('an update is waiting.')}`;
  }

  return [latest, running];
}

function renderSection(section) {
  return h('section', { class: 'panel' },
    h('div', { class: 'page-head' },
      h('div', { class: 'page-head__icon' }, icon(ICON_MAP[section.icon] || 'info', 18)),
      h('div', null,
        h('h2', { class: 'panel__title' }, section.title),
        h('p', { class: 'panel__hint' }, section.tagline))),
    h('div', { class: 'doc' }, ...section.groups.map(renderGroup)),
  );
}

export function createAbout() {
  // Falls back to English for a language with no documentation written yet.
  const data = ABOUT[prefs.lang] || ABOUT.en;

  // Repainted if the version check lands after this panel is built.
  const foot = h('div', { class: 'muted buildinfo' });
  const paintFoot = () => foot.replaceChildren(...buildLines().map((line) => h('p', null, line)));
  paintFoot();

  const root = h('div', { class: 'stack' },
    pageHead('info', t('About'), t('How each tool works, from start to finish.')),

    h('section', { class: 'panel' },
      h('h2', { class: 'panel__title' }, data.title),
      h('div', { class: 'doc' }, ...data.intro.map((line) => h('p', null, line)))),

    ...data.sections.map(renderSection),

    h('section', { class: 'panel' },
      h('div', { class: 'panel__head' },
        h('div', null,
          h('h2', { class: 'panel__title' }, t('Release history')),
          h('p', { class: 'panel__hint' }, `${t('Running version')} ${APP_VERSION}`))),
      h('div', null, ...CHANGELOG.map((entry) => h('article', { class: 'release' },
        h('div', { class: 'release__ver' }, entry.version),
        h('div', { class: 'release__title' }, t(entry.title)),
        h('p', { class: 'release__body' }, t(entry.description)))))),

    foot,
  );

  const stopWaiting = onDeployedRelease(paintFoot);

  return { el: root, destroy() { stopWaiting(); } };
}
