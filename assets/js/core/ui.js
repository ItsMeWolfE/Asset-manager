// Shared UI pieces used by more than one tool: the status/progress panel, the
// event log, the drop zone, and a toast.

import { h, clear, icon } from './dom.js';
import { t } from './i18n.js';

const MAX_LOG_ENTRIES = 300;

/**
 * Status panel with a phase dot, title, summary and progress bar.
 * Phases: idle | processing | success | error.
 */
export function createStatus() {
  const dot = h('span', { class: 'status__dot' });
  const title = h('div', { class: 'status__title' }, t('Ready'));
  const summary = h('div', { class: 'status__summary' });
  const pct = h('div', { class: 'status__pct' });
  const bar = h('div', { class: 'progress__bar', style: { width: '0%' } });
  const progress = h('div', {
    class: 'progress',
    role: 'progressbar',
    'aria-valuemin': '0',
    'aria-valuemax': '100',
  }, bar);

  const root = h('section', { class: 'panel status', dataset: { phase: 'idle' } },
    h('div', { class: 'status__row' }, dot,
      h('div', { class: 'status__text' }, title, summary), pct),
    progress,
  );
  progress.hidden = true;

  return {
    el: root,
    set({ phase, title: titleText, summary: summaryText, progress: value }) {
      if (phase) root.dataset.phase = phase;
      if (titleText !== undefined) title.textContent = titleText;
      if (summaryText !== undefined) summary.textContent = summaryText;

      if (value === undefined || value === null) {
        progress.hidden = true;
        pct.textContent = '';
      } else {
        const clamped = Math.max(0, Math.min(100, value));
        progress.hidden = false;
        bar.style.width = `${clamped}%`;
        progress.setAttribute('aria-valuenow', String(Math.round(clamped)));
        pct.textContent = `${Math.round(clamped)}%`;
      }
    },
    reset() {
      root.dataset.phase = 'idle';
      title.textContent = t('Ready');
      summary.textContent = '';
      progress.hidden = true;
      pct.textContent = '';
      bar.style.width = '0%';
    },
  };
}

/**
 * Event log. Entries are appended as text nodes, never as HTML, so a filename
 * containing markup cannot alter the page.
 */
export function createLog() {
  const body = h('div', { class: 'log__body', role: 'log', 'aria-live': 'polite' });
  const empty = h('div', { class: 'log__empty' }, t('No events yet.'));
  body.append(empty);

  const clearBtn = h('button', {
    type: 'button',
    class: 'btn btn--ghost btn--sm',
    onClick: () => api.clear(),
  }, icon('trash', 14), t('Clear'));

  const root = h('section', { class: 'panel' },
    h('div', { class: 'panel__head' },
      h('div', null,
        h('h2', { class: 'panel__title' }, t('Event log')),
        h('p', { class: 'panel__hint' }, t('Errors appear in red.'))),
      clearBtn),
    body,
  );

  let count = 0;

  const api = {
    el: root,
    add(message, kind = 'info') {
      if (!count) clear(body);
      count += 1;

      body.append(h('div', { class: 'log__line', dataset: { kind } },
        h('span', { class: 'log__time' }, new Date().toLocaleTimeString()),
        h('span', { class: 'log__msg' }, message)));

      while (count > MAX_LOG_ENTRIES && body.firstChild) {
        body.firstChild.remove();
        count -= 1;
      }
      body.scrollTop = body.scrollHeight;
    },
    error(message) { api.add(message, 'error'); },
    success(message) { api.add(message, 'success'); },
    clear() {
      count = 0;
      clear(body).append(empty);
    },
  };

  return api;
}

/**
 * Drop zone with drag, click-to-browse and (optionally) paste support.
 * `onFiles` receives a File[].
 */
export function createDropzone({ iconName, title, hint, buttonLabel, accept, multiple, onFiles }) {
  const input = h('input', {
    type: 'file',
    class: 'sr-only',
    accept: accept || '',
    multiple: Boolean(multiple),
    onChange: () => {
      const files = Array.from(input.files || []);
      input.value = '';
      if (files.length) onFiles(files);
    },
  });

  const button = h('button', {
    type: 'button',
    class: 'btn',
    onClick: () => input.click(),
  }, buttonLabel);

  const heading = h('h3', null, title);

  const root = h('div', {
    class: 'dropzone',
    dataset: { over: 'false' },
    onDragenter: (event) => { event.preventDefault(); if (!root.dataset.busy) root.dataset.over = 'true'; },
    onDragover: (event) => { event.preventDefault(); if (!root.dataset.busy) root.dataset.over = 'true'; },
    onDragleave: (event) => {
      event.preventDefault();
      if (!root.contains(event.relatedTarget)) root.dataset.over = 'false';
    },
    onDrop: (event) => {
      event.preventDefault();
      root.dataset.over = 'false';
      if (root.dataset.busy) return;
      const files = Array.from(event.dataTransfer?.files || []);
      if (files.length) onFiles(files);
    },
  },
    h('div', { class: 'dropzone__icon' }, icon(iconName, 22)),
    heading,
    h('p', null, hint),
    button,
    input,
  );

  return {
    el: root,
    setBusy(busy) {
      root.dataset.busy = busy ? 'true' : '';
      button.disabled = busy;
      input.disabled = busy;
    },
    setTitle(text) { heading.textContent = text; },
  };
}

let toastTimer = 0;

export function toast(message) {
  document.querySelector('.toast')?.remove();
  const el = h('div', { class: 'toast', role: 'status' }, message);
  document.body.append(el);
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el.remove(), 2200);
}

/** Standard page header shown at the top of every tool. */
export function pageHead(iconName, title, description) {
  return h('header', { class: 'page-head' },
    h('div', { class: 'page-head__icon' }, icon(iconName, 18)),
    h('div', null, h('h1', null, title), h('p', null, description)),
  );
}
