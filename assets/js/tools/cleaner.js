// HTML Cleaner - turns a supplier's description markup into flat, safe HTML.
//
// The transform is a faithful port of the 2.4.1 flattener: sanitize, walk the
// tree into a token stream, then rebuild it as a sequence of paragraphs.
// Tables, images and videos survive; everything structural is flattened away.

import { h, icon, debounce } from '../core/dom.js';
import { t } from '../core/i18n.js';
import { sanitize, setSanitizedHTML } from '../core/sanitize.js';
import { pageHead, toast } from '../core/ui.js';
import { loadStored, saveStored } from '../core/prefs.js';

const PREVIEW_DEBOUNCE_MS = 250;
const INPUT_VIEW_KEY = 'asset-manager-cleaner-input-view-v1';
const OUTPUT_VIEW_KEY = 'asset-manager-cleaner-output-view-v1';
const isView = (v) => v === 'visual' || v === 'code';

// Structural elements that become paragraph breaks.
const BLOCKS = new Set(['ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DD', 'DIV',
  'DETAILS', 'DIALOG', 'DL', 'DT', 'FIELDSET', 'FIGCAPTION', 'FIGURE', 'FOOTER',
  'FORM', 'HEADER', 'HGROUP', 'LI', 'MAIN', 'NAV', 'OL', 'PRE', 'SECTION',
  'SUMMARY', 'UL']);

// Dropped outright, contents and all.
const DROP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'IFRAME',
  'OBJECT', 'EMBED', 'SVG', 'CANVAS', 'AUDIO', 'INPUT', 'BUTTON', 'SELECT',
  'TEXTAREA']);

// Survive into the output as themselves.
const KEEP = new Set(['TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'TH', 'TD',
  'CAPTION', 'COLGROUP', 'COL', 'P', 'STRONG', 'IMG', 'VIDEO', 'SOURCE',
  'TRACK', 'BR']);

const CARRIED_ATTRS = ['class', 'style', 'dir', 'lang', 'title'];
const CELLS = new Set(['TD', 'TH', 'CAPTION']);

function carriedAttrs(element) {
  const attrs = {};
  for (const name of CARRIED_ATTRS) {
    const value = element.getAttribute(name);
    if (value && value.trim()) attrs[name] = value;
  }
  return attrs;
}

function applyAttrs(element, attrs) {
  for (const [name, value] of Object.entries(attrs || {})) {
    element.setAttribute(name, value);
  }
}

/** A <video> keeps only its <source>/<track> children. */
function flattenVideo(video) {
  const clone = video.cloneNode(true);
  for (const node of [...clone.querySelectorAll('*')].reverse()) {
    if (node.tagName !== 'SOURCE' && node.tagName !== 'TRACK') {
      node.replaceWith(...node.childNodes);
    }
  }
  return clone;
}

/** Tables keep their grid but lose wrappers; cell contents become paragraphs. */
function cleanTable(table) {
  const clone = table.cloneNode(true);
  const doc = clone.ownerDocument;

  const copyAttrs = (from, to) => {
    for (const attr of [...from.attributes]) to.setAttribute(attr.name, attr.value);
  };

  for (const node of [...clone.querySelectorAll('*')].reverse()) {
    const tag = node.tagName;

    if (tag === 'SPAN') {
      node.replaceWith(...node.childNodes);
      continue;
    }

    if (tag === 'B') {
      const strong = doc.createElement('strong');
      copyAttrs(node, strong);
      strong.append(...node.childNodes);
      node.replaceWith(strong);
      continue;
    }

    if (/^H[1-6]$/.test(tag)) {
      const paragraph = doc.createElement('p');
      const strong = doc.createElement('strong');
      copyAttrs(node, paragraph);
      strong.append(...node.childNodes);
      paragraph.append(strong);
      node.replaceWith(paragraph);
      continue;
    }

    if (tag === 'DIV' || BLOCKS.has(tag)) {
      const parentTag = node.parentElement?.tagName;
      const directCellChild = CELLS.has(parentTag) &&
        !node.querySelector('p,table,thead,tbody,tfoot,tr,th,td,caption,colgroup');

      if (directCellChild) {
        const paragraph = doc.createElement('p');
        copyAttrs(node, paragraph);
        paragraph.append(...node.childNodes);
        node.replaceWith(paragraph);
      } else {
        node.replaceWith(...node.childNodes);
      }
      continue;
    }

    if (!KEEP.has(tag)) node.replaceWith(...node.childNodes);
  }

  return clone;
}

/**
 * Flatten supplier HTML into a sequence of paragraphs.
 * Input is sanitized first, so this only has to deal with structure.
 */
export function transformHtml(html) {
  if (!html) return '';

  const doc = new DOMParser().parseFromString(sanitize(html), 'text/html');
  const tokens = [];

  const walk = (node, inline = false) => {
    if (node.nodeType === Node.TEXT_NODE) {
      tokens.push({ k: 'text', v: node.data });
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;

    const tag = node.tagName;

    if (tag === 'IMG') { tokens.push({ k: 'media', n: node.cloneNode(true), inline }); return; }
    if (tag === 'VIDEO') { tokens.push({ k: 'media', n: flattenVideo(node), inline }); return; }
    if (tag === 'TABLE') { tokens.push({ k: 'table', n: cleanTable(node) }); return; }
    if (tag === 'SOURCE' || tag === 'TRACK' || DROP.has(tag)) return;
    if (tag === 'BR' || tag === 'HR') { tokens.push({ k: 'break' }); return; }

    if (tag === 'STRONG' || tag === 'B') {
      tokens.push({ k: 'strongStart', a: carriedAttrs(node) });
      [...node.childNodes].forEach((child) => walk(child, true));
      tokens.push({ k: 'strongEnd' });
      return;
    }

    if (/^H[1-6]$/.test(tag)) {
      tokens.push({ k: 'break' }, { k: 'attrs', a: carriedAttrs(node) }, { k: 'strongStart', a: {} });
      [...node.childNodes].forEach((child) => walk(child, true));
      tokens.push({ k: 'strongEnd' }, { k: 'break' });
      return;
    }

    if (tag === 'P') {
      tokens.push({ k: 'break' }, { k: 'attrs', a: carriedAttrs(node) });
      [...node.childNodes].forEach((child) => walk(child, true));
      tokens.push({ k: 'break' });
      return;
    }

    if (BLOCKS.has(tag)) {
      tokens.push({ k: 'break' }, { k: 'attrs', a: carriedAttrs(node) });
      [...node.childNodes].forEach((child) => walk(child, false));
      tokens.push({ k: 'break' });
      return;
    }

    [...node.childNodes].forEach((child) => walk(child, true));
  };

  [...doc.body.childNodes].forEach((node) => walk(node, false));

  // Rebuild: tokens drive an open paragraph and a stack of <strong> wrappers.
  const fragment = doc.createDocumentFragment();
  let paragraph = null;
  let cursor = null;
  let strongStack = [];
  let openStrongs = [];
  let pendingAttrs = null;

  const openParagraph = () => {
    if (paragraph) return;

    paragraph = doc.createElement('p');
    applyAttrs(paragraph, pendingAttrs);
    pendingAttrs = null;
    cursor = paragraph;
    openStrongs = [paragraph];

    for (const attrs of strongStack) {
      const strong = doc.createElement('strong');
      applyAttrs(strong, attrs);
      cursor.append(strong);
      cursor = strong;
      openStrongs.push(strong);
    }
  };

  const closeParagraph = () => {
    if (!paragraph) return;

    for (const strong of [...paragraph.querySelectorAll('strong')].reverse()) {
      const hasContent = (strong.textContent ?? '').trim() || strong.querySelector('img, video');
      if (!hasContent) {
        strong.remove();
        continue;
      }
      // Collapse <strong><strong>x</strong></strong> down to one level.
      if (strong.querySelector(':scope > strong:only-child') && strong.childNodes.length === 1) {
        strong.replaceWith(...strong.childNodes);
      }
    }

    while (paragraph.firstChild?.nodeType === Node.TEXT_NODE && !paragraph.firstChild.data.trim()) {
      paragraph.firstChild.remove();
    }
    while (paragraph.lastChild?.nodeType === Node.TEXT_NODE && !paragraph.lastChild.data.trim()) {
      paragraph.lastChild.remove();
    }

    if ((paragraph.textContent ?? '').trim() || paragraph.querySelector('img, video')) {
      fragment.append(paragraph);
    }

    paragraph = null;
    cursor = null;
    openStrongs = [];
    pendingAttrs = null;
  };

  for (const token of tokens) {
    if (token.k === 'break') {
      closeParagraph();
      pendingAttrs = null;
    } else if (token.k === 'attrs') {
      pendingAttrs = token.a;
    } else if (token.k === 'text') {
      if (!paragraph && !token.v.trim()) continue;
      openParagraph();
      cursor.append(doc.createTextNode(token.v));
    } else if (token.k === 'media') {
      if (token.inline) {
        openParagraph();
        cursor.append(token.n);
      } else {
        closeParagraph();
        fragment.append(token.n);
        pendingAttrs = null;
      }
    } else if (token.k === 'table') {
      closeParagraph();
      fragment.append(token.n);
      pendingAttrs = null;
    } else if (token.k === 'strongStart') {
      openParagraph();
      const strong = doc.createElement('strong');
      applyAttrs(strong, token.a);
      cursor.append(strong);
      strongStack = strongStack.concat([token.a]);
      cursor = strong;
      openStrongs.push(strong);
    } else if (token.k === 'strongEnd') {
      if (strongStack.length) {
        strongStack.pop();
        if (paragraph) {
          openStrongs.pop();
          cursor = openStrongs[openStrongs.length - 1] || paragraph;
        }
      }
    }
  }

  closeParagraph();

  const holder = doc.createElement('div');
  holder.append(fragment);
  return holder.innerHTML;
}

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

async function copyRich(html) {
  if (navigator.clipboard?.write && typeof ClipboardItem !== 'undefined') {
    const text = new DOMParser().parseFromString(html, 'text/html').body.textContent ?? '';
    await navigator.clipboard.write([new ClipboardItem({
      'text/html': new Blob([html], { type: 'text/html' }),
      'text/plain': new Blob([text], { type: 'text/plain' }),
    })]);
    return;
  }
  if (!navigator.clipboard?.writeText) throw new Error('Clipboard access is unavailable in this browser context.');
  await navigator.clipboard.writeText(html);
}

export function createCleaner() {
  let source = '';
  let output = '';
  let inputView = loadStored(INPUT_VIEW_KEY, isView, 'visual');
  let outputView = loadStored(OUTPUT_VIEW_KEY, isView, 'visual');

  const visualInput = h('div', {
    class: 'editor rich',
    contentEditable: 'true',
    role: 'textbox',
    'aria-multiline': 'true',
    'aria-label': t('Rich HTML input'),
    dir: 'auto',
    onInput: () => { source = visualInput.innerHTML; schedule(); },
    onPaste: (event) => {
      event.preventDefault();
      const pasted = event.clipboardData.getData('text/html') || event.clipboardData.getData('text/plain');
      if (!pasted) return;
      insertSanitized(visualInput, pasted);
      source = visualInput.innerHTML;
      schedule();
    },
  });

  const codeInput = h('textarea', {
    class: 'textarea code',
    placeholder: t('Paste HTML…'),
    'aria-label': t('HTML source input'),
    onInput: () => { source = codeInput.value; schedule(); },
  });

  const visualOutput = h('div', { class: 'editor rich', dir: 'auto' });
  const codeOutput = h('textarea', { class: 'textarea code', readOnly: true, 'aria-label': t('Cleaned HTML output') });

  const inputPlaceholder = h('div', { class: 'pane__placeholder' }, t('Paste rich text here…'));
  const outputPlaceholder = h('div', { class: 'pane__placeholder' }, t('Waiting for input…'));

  /** Insert sanitized HTML at the caret inside a contenteditable. */
  function insertSanitized(host, html) {
    host.focus();
    const selection = window.getSelection();

    if (!selection?.rangeCount || !host.contains(selection.getRangeAt(0).commonAncestorContainer)) {
      host.append(document.createDocumentFragment());
      const holder = document.createElement('div');
      setSanitizedHTML(holder, html);
      host.append(...holder.childNodes);
      return;
    }

    const range = selection.getRangeAt(0);
    range.deleteContents();

    const holder = document.createElement('div');
    setSanitizedHTML(holder, html);

    const fragment = document.createDocumentFragment();
    fragment.append(...holder.childNodes);
    const last = fragment.lastChild;

    range.insertNode(fragment);
    if (last) {
      range.setStartAfter(last);
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
    }
  }

  const schedule = debounce(() => {
    output = transformHtml(source);
    setSanitizedHTML(visualOutput, output);
    codeOutput.value = output;
    syncPlaceholders();
  }, PREVIEW_DEBOUNCE_MS);

  function syncPlaceholders() {
    inputPlaceholder.hidden = Boolean(source) || inputView !== 'visual';
    outputPlaceholder.hidden = Boolean(output);
    copyButton.disabled = !output;
  }

  function setInputView(view) {
    inputView = view;
    visualInput.hidden = view !== 'visual';
    codeInput.hidden = view !== 'code';

    // Moving back to visual re-renders from the current source.
    if (view === 'visual') setSanitizedHTML(visualInput, source);
    else codeInput.value = source;

    for (const [value, button] of inputViewButtons) button.setAttribute('aria-pressed', String(view === value));
    syncPlaceholders();
  }

  function setOutputView(view) {
    outputView = view;
    visualOutput.hidden = view !== 'visual';
    codeOutput.hidden = view !== 'code';
    for (const [value, button] of outputViewButtons) button.setAttribute('aria-pressed', String(view === value));
  }

  const inputViewButtons = new Map();
  const outputViewButtons = new Map();

  function viewToggle(map, current, onPick, label, key) {
    const group = h('div', { class: 'segmented', role: 'group', 'aria-label': label });
    for (const value of ['visual', 'code']) {
      const button = h('button', {
        type: 'button',
        'aria-pressed': String(current === value),
        onClick: () => { onPick(value); saveStored(key, value); },
      }, t(value === 'visual' ? 'Visual' : 'Code'));
      map.set(value, button);
      group.append(button);
    }
    return group;
  }

  const copyButton = h('button', {
    type: 'button', class: 'btn btn--sm', disabled: true,
    onClick: async () => {
      if (!output) return;
      try {
        if (outputView === 'visual') await copyRich(output);
        else await navigator.clipboard.writeText(output);
        toast(t('Copied.'));
      } catch (error) {
        toast(error instanceof Error ? error.message : String(error));
      }
    },
  }, icon('copy', 14), t('Copy'));

  const clearButton = h('button', {
    type: 'button', class: 'btn btn--danger btn--sm',
    onClick: () => {
      source = '';
      output = '';
      schedule.cancel();
      visualInput.replaceChildren();
      codeInput.value = '';
      visualOutput.replaceChildren();
      codeOutput.value = '';
      syncPlaceholders();
    },
  }, icon('trash', 14), t('Clear'));

  const root = h('div', { class: 'stack' },
    h('div', { class: 'row row--between' },
      pageHead('fileText', t('HTML Cleaner'), t('Clean and normalize product-description HTML safely.')),
      clearButton),

    h('div', { class: 'panes' },
      h('section', { class: 'pane' },
        h('header', { class: 'pane__head' },
          h('h2', { class: 'pane__title' }, icon('settings', 14), t('Input')),
          viewToggle(inputViewButtons, inputView, setInputView, t('Input view'), INPUT_VIEW_KEY)),
        h('div', { class: 'pane__body' }, visualInput, codeInput, inputPlaceholder)),

      h('section', { class: 'pane' },
        h('header', { class: 'pane__head' },
          h('h2', { class: 'pane__title' }, icon('type', 14), t('Output')),
          h('div', { class: 'row' },
            viewToggle(outputViewButtons, outputView, setOutputView, t('Output view'), OUTPUT_VIEW_KEY),
            copyButton)),
        h('div', { class: 'pane__body' }, visualOutput, codeOutput, outputPlaceholder))),
  );

  setInputView(inputView);
  setOutputView(outputView);
  syncPlaceholders();

  return {
    el: root,
    destroy() { schedule.cancel(); },
  };
}
