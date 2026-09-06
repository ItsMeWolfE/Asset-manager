// Application shell: navigation, preferences and tool mounting.

import { h, clear, icon } from './core/dom.js';
import { t } from './core/i18n.js';
import { prefs, setPrefs, applyPrefs, onPrefsChange, THEMES, THEME_BY_ID, SIZES } from './core/prefs.js';
import { APP_VERSION } from './core/version.js';
import { initUpdates } from './core/update.js';

import { createCropper } from './tools/cropper.js';
import { createResizer } from './tools/resizer.js';
import { createCleaner } from './tools/cleaner.js';
import { createDragon } from './tools/dragon.js';
import { createPrice } from './tools/price.js';
import { createAbout } from './tools/about.js';

const TOOLS = [
  { id: 'cropper', label: 'Batch Cropper', description: 'Remove empty borders from product images and export WebP files.', icon: 'crop', create: createCropper },
  { id: 'resizer', label: 'Smart Resizer', description: 'Place an image precisely inside a fixed output canvas.', icon: 'resize', create: createResizer },
  { id: 'transformer', label: 'HTML Cleaner', description: 'Clean and normalize product-description HTML safely.', icon: 'fileText', create: createCleaner },
  { id: 'dragon', label: 'Dragon Fixer', description: 'Normalize Dragon inventory spreadsheets for import.', icon: 'table', create: createDragon },
  { id: 'price', label: 'Price XLSX Fixer', description: 'Extract item codes and updated consumer prices into text-safe XLSX output.', icon: 'badgeDollar', create: createPrice },
  { id: 'about', label: 'About', description: 'How each tool works, from start to finish.', icon: 'info', create: createAbout },
];

const DEFAULT_TOOL = 'cropper';

let current = null;
let currentId = null;

const navButtons = new Map();
const content = h('main', { class: 'stack', id: 'tool-panel', tabIndex: -1 });

// ---------------------------------------------------------------------------
// Tool mounting
// ---------------------------------------------------------------------------

function toolIdFromHash() {
  const id = window.location.hash.replace(/^#\/?/, '');
  return TOOLS.some((tool) => tool.id === id) ? id : DEFAULT_TOOL;
}

function mount(id, { focus = false } = {}) {
  const tool = TOOLS.find((entry) => entry.id === id) || TOOLS[0];

  if (currentId === tool.id && current) return;

  current?.destroy?.();
  current = tool.create();
  currentId = tool.id;

  clear(content).append(current.el);
  document.title = `${t(tool.label)} — Bug Asset Manager`;

  for (const [key, button] of navButtons) {
    if (key === tool.id) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }

  // Focus moves for screen-reader and keyboard users, but `preventScroll` is
  // essential: focusing the panel otherwise scrolls it to the top of the
  // viewport, hiding the tool heading underneath the sticky header.
  if (focus) {
    content.focus({ preventScroll: true });
    window.scrollTo({ top: 0, behavior: 'auto' });
  }
}

/** Re-create the running tool, e.g. after a language change. */
function remount() {
  const id = currentId;
  currentId = null;
  mount(id || DEFAULT_TOOL);
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

function buildNav() {
  const nav = h('nav', { class: 'nav', 'aria-label': t('Application navigation') },
    h('div', { class: 'nav__label' }, t('Asset tools')));

  for (const tool of TOOLS) {
    const button = h('button', {
      type: 'button',
      class: 'nav__item',
      onClick: () => { window.location.hash = `#/${tool.id}`; },
    },
      icon(tool.icon, 16),
      h('span', { class: 'nav__text' },
        h('span', null, t(tool.label)),
        h('span', { class: 'nav__desc' }, t(tool.description))));

    navButtons.set(tool.id, button);
    nav.append(button);
  }

  return nav;
}

// ---------------------------------------------------------------------------
// Preferences popover
// ---------------------------------------------------------------------------

function buildPrefs() {
  let open = false;

  const panel = h('div', { class: 'pop__panel', role: 'dialog', 'aria-label': t('Preferences') });
  panel.hidden = true;

  const toggle = h('button', {
    type: 'button',
    class: 'btn btn--icon',
    'aria-label': t('Preferences'),
    'aria-haspopup': 'dialog',
    'aria-expanded': 'false',
    onClick: () => setOpen(!open),
  }, icon('settings', 18));

  const root = h('div', { class: 'pop' }, toggle, panel);

  function setOpen(value) {
    open = value;
    panel.hidden = !value;
    toggle.setAttribute('aria-expanded', String(value));
    if (value) render();
  }

  function chip(label, active, onClick, title) {
    return h('button', {
      type: 'button', class: 'chip', 'aria-pressed': String(active),
      title: title || label, onClick,
    }, label);
  }

  function render() {
    const theme = THEME_BY_ID[prefs.theme] || THEME_BY_ID.dark;
    const accent = prefs.accent || theme.vars['--accent-main'];

    clear(panel).append(
      h('section', { class: 'pop__section' },
        h('h3', null, t('Language')),
        h('div', { class: 'grid-2' },
          chip('English', prefs.lang === 'en', () => setPrefs({ lang: 'en' })),
          chip('עברית', prefs.lang === 'he', () => setPrefs({ lang: 'he' })))),

      h('section', { class: 'pop__section' },
        h('h3', null, t('Theme')),
        h('div', { class: 'grid-3' }, ...THEMES.map((entry) => h('button', {
          type: 'button', class: 'swatch',
          'aria-pressed': String(prefs.theme === entry.id),
          title: t(entry.label), 'aria-label': t(entry.label),
          onClick: () => setPrefs({ theme: entry.id }),
        },
          h('span', {
            class: 'swatch__preview', 'aria-hidden': 'true',
            style: {
              background: entry.vars['--bg-base'],
              boxShadow: `inset 0 0 0 1px ${entry.vars['--bg-border']}, inset 0 -6px 0 -2px ${entry.vars['--accent-main']}`,
            },
          }),
          h('span', { class: 'swatch__label' }, t(entry.label))))),
      ),

      h('section', { class: 'pop__section' },
        h('h3', null, t('Text size')),
        h('div', { class: 'grid-4' }, ...SIZES.map((size) =>
          chip(size.short, prefs.fontScale === size.v, () => setPrefs({ fontScale: size.v }), t(size.label))))),

      h('section', { class: 'pop__section' },
        h('h3', null, t('Accent colour')),
        h('div', { class: 'accent-row' },
          h('input', {
            type: 'color', value: accent, 'aria-label': t('Accent colour'),
            onInput: (event) => setPrefs({ accent: event.target.value }),
          }),
          h('code', null, accent),
          prefs.accent
            ? h('button', { type: 'button', class: 'link-btn', onClick: () => setPrefs({ accent: null }) }, t('Reset'))
            : null)),
    );
  }

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && open) setOpen(false);
  });

  document.addEventListener('pointerdown', (event) => {
    if (open && !root.contains(event.target)) setOpen(false);
  });

  return { el: root, refresh: () => { if (open) render(); } };
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

function boot() {
  applyPrefs();

  const prefsPopover = buildPrefs();

  const shell = h('div', { class: 'shell' },
    h('header', { class: 'topbar' },
      h('div', { class: 'topbar__brand' },
        h('div', { class: 'topbar__mark' }, icon('layers', 18)),
        h('div', null,
          h('div', { class: 'topbar__title' }, 'Bug Asset Manager'),
          h('div', { class: 'topbar__ver' }, `v${APP_VERSION}`))),
      h('div', { class: 'topbar__spacer' }),
      prefsPopover.el),

    h('div', { class: 'update-slot', style: { padding: '0 16px' } }),

    h('div', { class: 'layout' }, buildNav(), content),
  );

  document.body.replaceChildren(shell);

  onPrefsChange((changed) => {
    prefsPopover.refresh();
    // Language changes the strings baked into every tool, so rebuild.
    if (changed.includes('lang')) {
      rebuildNavLabels();
      remount();
    }
  });

  window.addEventListener('hashchange', () => mount(toolIdFromHash(), { focus: true }));

  mount(toolIdFromHash());
  initUpdates();
}

function rebuildNavLabels() {
  for (const [id, button] of navButtons) {
    const tool = TOOLS.find((entry) => entry.id === id);
    if (!tool) continue;
    const [, textWrap] = button.childNodes;
    if (!textWrap) continue;
    textWrap.childNodes[0].textContent = t(tool.label);
    textWrap.childNodes[1].textContent = t(tool.description);
  }
  document.querySelector('.nav')?.setAttribute('aria-label', t('Application navigation'));
  document.querySelector('.nav__label')?.replaceChildren(t('Asset tools'));
}

boot();
