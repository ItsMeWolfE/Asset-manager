// Translation lookup.
//
// English strings are the keys, so an untranslated string still renders as
// readable English instead of a missing-key placeholder.

import { HE } from '../data/i18n-he.js';
import { prefs } from './prefs.js';

export function t(text) {
  if (prefs.lang !== 'he') return text;
  return HE[text] ?? text;
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

export const isRTL = () => prefs.lang === 'he';
