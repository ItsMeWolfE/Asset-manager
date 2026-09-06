// Preferences: language, theme, text size, accent colour.
//
// Stored in localStorage under a single key and applied straight to the root
// element as CSS custom properties, so every rule in app.css follows along.

import { languageFor } from '../i18n/index.js';

const KEY = 'asset-manager-prefs-v1';

// Read-only fallbacks, newest first, so settings saved by an earlier build are
// picked up once and then re-saved under the current key.
const LEGACY_KEYS = ['bam-prefs-v3', 'bam-prefs-v1'];

export const THEMES = [
  { id: 'dark', label: 'Dark', scheme: 'dark', vars: { '--bg-deep': '#090b10', '--bg-base': '#10131a', '--bg-surface': '#181d27', '--bg-border': '#2b3341', '--text-highlight': '#f4f7fb', '--text-main': '#cbd3df', '--text-muted': '#8d99aa', '--text-muted-dark': '#667184', '--accent-main': '#5b6df8', '--accent-hover': '#7181ff', '--accent-light': '#91a0ff' } },
  { id: 'midnight', label: 'Midnight', scheme: 'dark', vars: { '--bg-deep': '#04060a', '--bg-base': '#080b11', '--bg-surface': '#0f141d', '--bg-border': '#1f2836', '--text-highlight': '#eef3fa', '--text-main': '#c5cede', '--text-muted': '#8794a8', '--text-muted-dark': '#5f6b7e', '--accent-main': '#0f9d6e', '--accent-hover': '#10b981', '--accent-light': '#6ee7b7' } },
  { id: 'ocean', label: 'Ocean', scheme: 'dark', vars: { '--bg-deep': '#041826', '--bg-base': '#072a3f', '--bg-surface': '#0b3a55', '--bg-border': '#17587f', '--text-highlight': '#f0f9ff', '--text-main': '#cfe6f5', '--text-muted': '#96c2dc', '--text-muted-dark': '#6d9dbd', '--accent-main': '#0891b2', '--accent-hover': '#06b6d4', '--accent-light': '#7dd3fc' } },
  { id: 'light', label: 'Light', scheme: 'light', vars: { '--bg-deep': '#e7ebf2', '--bg-base': '#f6f8fc', '--bg-surface': '#ffffff', '--bg-border': '#d3dae5', '--text-highlight': '#0d1424', '--text-main': '#2c3648', '--text-muted': '#57637a', '--text-muted-dark': '#9aa5b6', '--accent-main': '#4a5bd4', '--accent-hover': '#3b4ac2', '--accent-light': '#2f3ba8' } },
  { id: 'sepia', label: 'Sepia', scheme: 'light', vars: { '--bg-deep': '#e6dbc4', '--bg-base': '#f4ecd8', '--bg-surface': '#fbf6ea', '--bg-border': '#d6c6a6', '--text-highlight': '#2a2317', '--text-main': '#4a3f2c', '--text-muted': '#6f6144', '--text-muted-dark': '#a89877', '--accent-main': '#9a6b2f', '--accent-hover': '#82581f', '--accent-light': '#6b4715' } },
  { id: 'contrast', label: 'High contrast', scheme: 'dark', vars: { '--bg-deep': '#000000', '--bg-base': '#000000', '--bg-surface': '#0b0b0b', '--bg-border': '#767676', '--text-highlight': '#ffffff', '--text-main': '#f2f2f2', '--text-muted': '#dcdcdc', '--text-muted-dark': '#a6a6a6', '--accent-main': '#1d4ed8', '--accent-hover': '#2563eb', '--accent-light': '#93c5fd' } },
];

export const THEME_BY_ID = Object.fromEntries(THEMES.map((t) => [t.id, t]));

export const SIZES = [
  { v: 90, label: 'Small text', short: 'S' },
  { v: 100, label: 'Normal text', short: 'M' },
  { v: 112, label: 'Large text', short: 'L' },
  { v: 125, label: 'Extra large text', short: 'XL' },
];

const DEFAULTS = { lang: 'en', theme: 'dark', fontScale: 100, accent: null };

function read() {
  for (const key of [KEY, ...LEGACY_KEYS]) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) continue;

      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') continue;

      const merged = { ...DEFAULTS, ...parsed };

      // Copy a legacy value forward straight away, so the current key is the
      // one that counts from here on instead of only after the next change.
      if (key !== KEY) {
        try { localStorage.setItem(KEY, JSON.stringify(merged)); } catch { /* private mode */ }
      }
      return merged;
    } catch { /* corrupt or unavailable storage falls through to defaults */ }
  }
  return { ...DEFAULTS };
}

export const prefs = read();

const listeners = new Set();

/** Subscribe to preference changes. Returns an unsubscribe function. */
export function onPrefsChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Lighten a hex colour toward white by `percent`, matching the 2.x accent
 * derivation so a custom accent still produces a usable hover shade.
 */
function lighten(hex, percent) {
  const clean = hex.replace(/^#/, '');
  const full = clean.length === 3 ? clean.replace(/(.)/g, '$1$1') : clean;
  const channel = (offset) => {
    const value = Number.parseInt(full.slice(offset, offset + 2), 16);
    if (!Number.isFinite(value)) return '00';
    const lifted = Math.max(0, Math.min(255, Math.round(value + (255 - value) * (percent / 100))));
    return lifted.toString(16).padStart(2, '0');
  };
  return `#${channel(0)}${channel(2)}${channel(4)}`;
}

export function applyPrefs() {
  const theme = THEME_BY_ID[prefs.theme] || THEME_BY_ID.dark;
  const root = document.documentElement;

  for (const [name, value] of Object.entries(theme.vars)) {
    root.style.setProperty(name, value);
  }

  if (prefs.accent) {
    root.style.setProperty('--accent-main', prefs.accent);
    root.style.setProperty('--accent-hover', lighten(prefs.accent, 14));
    root.style.setProperty('--accent-light', lighten(prefs.accent, 32));
  }

  root.style.setProperty('--font-scale', `${prefs.fontScale}%`);
  root.dataset.scheme = theme.scheme;
  root.dataset.theme = theme.id;
  // Direction comes from the language definition, so a future right-to-left
  // language works without touching this file.
  const language = languageFor(prefs.lang);
  root.lang = language.code;
  root.dir = language.dir;
}

/**
 * Merge a patch into preferences, persist, re-apply, and notify.
 * `changed` tells subscribers which keys moved, so main.js only re-renders the
 * tool when the language actually changed.
 */
export function setPrefs(patch) {
  const changed = [];
  for (const [key, value] of Object.entries(patch)) {
    if (prefs[key] !== value) {
      prefs[key] = value;
      changed.push(key);
    }
  }
  if (!changed.length) return;

  try { localStorage.setItem(KEY, JSON.stringify(prefs)); } catch { /* private mode */ }
  applyPrefs();
  for (const fn of listeners) fn(changed);
}

// ---------------------------------------------------------------------------
// Generic persisted-value helpers, shared by the tools.
// ---------------------------------------------------------------------------

export function loadStored(key, isValid, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const value = JSON.parse(raw);
    return isValid(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

export function saveStored(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode */ }
}
