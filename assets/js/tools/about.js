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

/**
 * The running version and build, plus the deployed build when it differs -
 * which is the whole point: two copies can report 3.3.0 and still be running
 * different code. A mismatch means this copy is cached and an update is
 * waiting; the banner above offers it.
 */
function versionLine() {
  const line = `${t('Running version')} ${APP_VERSION} · ${t('build')} ${BUILD_ID}`;
  const build = deployedRelease()?.build;

  return build && build !== BUILD_ID
    ? `${line} · ${t('deployed build')} ${build}`
    : line;
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

  // Held onto so the version check can refresh it if it lands after this panel
  // is built.
  const hint = h('p', { class: 'panel__hint' }, versionLine());

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
          hint)),
      h('div', null, ...CHANGELOG.map((entry) => h('article', { class: 'release' },
        h('div', { class: 'release__ver' }, entry.version),
        h('div', { class: 'release__title' }, t(entry.title)),
        h('p', { class: 'release__body' }, t(entry.description)))))),
  );

  const stopWaiting = onDeployedRelease(() => { hint.textContent = versionLine(); });

  return { el: root, destroy() { stopWaiting(); } };
}
