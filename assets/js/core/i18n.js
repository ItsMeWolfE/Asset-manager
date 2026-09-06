// Translation lookup.
//
// English strings are the keys, so an untranslated string still renders as
// readable English instead of a missing-key placeholder. Which languages exist
// is decided entirely by assets/js/i18n/index.js; nothing here knows about any
// particular one.

import { languageFor, LANGUAGES } from '../i18n/index.js';
import { prefs } from './prefs.js';

const active = () => languageFor(prefs.lang);

export function t(text) {
  return active().strings[text] ?? text;
}

/** Interpolate `{name}` placeholders after translating the template. */
export function tf(text, values) {
  return t(text).replace(/\{(\w+)\}/g, (match, key) =>
    Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match,
  );
}

/** Count-aware helper: `plural(3, 'file', 'files')` -> "3 files". */
export function plural(count, one, many) {
  const word = Number(count) === 1 ? one : many;
  return `${count} ${t(word)}`;
}

/** Every language on offer, for the preferences picker. */
export const languages = () => LANGUAGES;

export const isRTL = () => active().dir === 'rtl';
