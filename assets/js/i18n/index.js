// The languages the interface is available in.
//
// English is the source language: its strings are the keys used throughout the
// code, so it carries no catalogue of its own and can never fall out of date.
//
// To add a language, write ./<code>.js exporting the same shape as ./he.js,
// import it here, and add it to LANGUAGES. That is the whole change - the
// preferences picker, the page text direction, the <html lang> attribute and
// every t() call read from this list rather than testing for a specific code.

import { he } from './he.js';

/** The source language. An empty catalogue means every lookup falls through. */
export const en = { code: 'en', name: 'English', dir: 'ltr', strings: {} };

export const LANGUAGES = [en, he];

export const DEFAULT_LANGUAGE = en;

/** The language for a stored code, falling back to English. */
export function languageFor(code) {
  return LANGUAGES.find((entry) => entry.code === code) || DEFAULT_LANGUAGE;
}

/** Whether a stored preference names a language that still exists. */
export function isLanguageCode(code) {
  return LANGUAGES.some((entry) => entry.code === code);
}
