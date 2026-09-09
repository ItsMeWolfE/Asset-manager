// Price XLSX Fixer - pulls item codes and updated prices out of a supplier list.
//
// The header scoring, column choice and text-safe output all live in the
// spreadsheet worker, unchanged from 2.4.1. This file handles input (a workbook
// or a pasted table) and reports what the worker decided.

import { h, icon } from '../core/dom.js';
import { t, tf, plural } from '../core/i18n.js';
import { createStatus, createLog, createDropzone, pageHead } from '../core/ui.js';
import { runSheetJob, isSpreadsheet, XLSX_MIME } from '../core/sheet.js';
import { saveBlob } from '../core/files.js';
import { loadStored, saveStored } from '../core/prefs.js';

/**
 * Clipboard cells arrive with invisible baggage: non-breaking spaces, the
 * direction marks a Hebrew table is full of, and - when a cell holds more than
 * one paragraph - newlines. A tab or a newline inside a cell would tear the
 * grid apart when the table is written back into the textarea, so every run of
 * whitespace is collapsed to a single space and the direction marks are
 * dropped rather than carried into the exported item codes.
 */
const BIDI_MARKS = /[\u200e\u200f\u061c\u202a-\u202e\u2066-\u2069]/g;

const cleanCell = (value) => String(value ?? '').replace(BIDI_MARKS, '').replace(/\s+/g, ' ').trim();

/**
 * Square off a ragged grid: trim trailing blank rows, then pad every row to the
 * widest one so the worker sees a rectangle.
 */
function normalizeGrid(rows) {
  if (!Array.isArray(rows)) return [];

  const grid = rows.map((row) => (Array.isArray(row) ? row : [row]).map(cleanCell));

  while (grid.length && grid[grid.length - 1].every((cell) => !cell)) grid.pop();
  if (!grid.length) return [];

  let widest = -1;
  for (const row of grid) {
    for (let i = row.length - 1; i >= 0; i -= 1) {
      if (row[i]) { widest = Math.max(widest, i); break; }
    }
  }
  if (widest < 0) return [];

  return grid.map((row) => Array.from({ length: widest + 1 }, (_, i) => row[i] ?? ''));
}

/**
 * One HTML table to a grid, honouring colspan and rowspan. Without this a
 * merged cell - ordinary in supplier tables and in anything pasted out of Word
 * - shifts every cell after it one column across, and the item code and the
 * price stop lining up with the headers they were found under.
 */
function gridFromTable(table) {
  const grid = [];
  const rowAt = (index) => grid[index] ?? (grid[index] = []);

  Array.from(table.rows).forEach((row, rowIndex) => {
    const cells = rowAt(rowIndex);
    let column = 0;

    for (const cell of Array.from(row.cells)) {
      // Skip over the columns a cell from an earlier row is still occupying.
      while (cells[column] !== undefined) column += 1;

      const across = Math.max(1, Math.min(cell.colSpan || 1, 64));
      const down = Math.max(1, Math.min(cell.rowSpan || 1, 512));
      const text = cell.textContent ?? '';

      for (let i = 0; i < across; i += 1) {
        // Only the leading column of a wide cell carries the text, but a cell
        // merged downwards repeats: a price merged across variant rows really
        // does belong to every one of them.
        cells[column + i] = i === 0 ? text : '';
        for (let j = 1; j < down; j += 1) rowAt(rowIndex + j)[column + i] = i === 0 ? text : '';
      }

      column += across;
    }
  });

  return Array.from(grid, (row) => Array.from(row ?? [], (cell) => cell ?? ''));
}

// Enough of the worker's vocabulary to tell a header row from a data row. This
// only decides which pasted table to hand over; the real scoring, and the
// choice of columns, stays in the worker.
const ITEM_HINT = /קוד|פריט|ברקוד|מק/;
const PRICE_HINT = /מחיר|חדש|צרכן|מעודכן|עדכון/;

const hasHeaderRow = (grid) => grid.some((row) =>
  row.some((cell) => ITEM_HINT.test(cell)) && row.some((cell) => PRICE_HINT.test(cell)));

/**
 * Pull a grid out of pasted HTML: the table with the most cells, unless that
 * one turns out to be a fragment of a table split across several.
 */
function gridFromHtml(html) {
  if (!html || !/<table[\s>]/i.test(html)) return null;

  const doc = new DOMParser().parseFromString(html, 'text/html');
  const grids = Array.from(doc.querySelectorAll('table'))
    .map((table) => normalizeGrid(gridFromTable(table)))
    .filter((grid) => grid.length);
  if (!grids.length) return null;

  const cellCount = (grid) => grid.length * grid[0].length;
  const best = grids.reduce((a, b) => (cellCount(b) > cellCount(a) ? b : a));
  if (best.length >= 2 && hasHeaderRow(best)) return best;

  // Some pages give the header row a table of its own, or split a long list
  // over several tables. The biggest single one is then a header with no rows
  // under it, or rows with no header over them - either way the worker is left
  // with nothing it can export. Stitching the tables of equal width back
  // together in document order recovers both, and changes nothing at all for
  // the ordinary single-table paste.
  const stitched = grids.filter((grid) => grid[0].length === best[0].length).flat();
  return stitched.length > best.length && hasHeaderRow(stitched) ? stitched : best;
}

/** Tab-separated clipboard text, as Excel and Sheets produce it. */
function gridFromText(text) {
  if (!text) return null;
  const rows = text.replace(/\r\n?/g, '\n').split('\n').map((line) => line.split('\t'));
  return normalizeGrid(rows);
}

const MODE_KEY = 'asset-manager-price-mode-v1';
const isMode = (v) => v === 'file' || v === 'paste';

// How many pasted rows the box shows. The grid behind it is kept whole; this
// only bounds what a very long paste does to the textarea.
const PREVIEW_ROWS = 200;

export function createPrice(carried = null) {
  let mode = loadStored(MODE_KEY, isMode, 'file');
  let busy = false;
  let pastedGrid = carried?.grid ?? null;

  // What the box was last filled with from a grid, and how many rows that
  // grid had beyond it. While the text is untouched the grid is still the
  // truth; once it is edited the text becomes the truth instead, and the rows
  // that were never shown are gone - which the notice under the box says out
  // loud rather than quietly exporting a shorter list.
  let previewText = carried?.grid && carried?.text ? carried.text : '';
  let hiddenRows = pastedGrid ? Math.max(0, pastedGrid.length - PREVIEW_ROWS) : 0;
  let droppedRows = 0;

  const status = createStatus();
  const log = createLog();
  const modeButtons = new Map();

  function setBusy(value) {
    busy = value;
    for (const button of modeButtons.values()) button.disabled = value;
    dropzone.setBusy(value);
    generateButton.disabled = value || !pastedGrid;
    pasteArea.disabled = value;
  }

  function reportResult(result, fallbackName) {
    log.add(`${t('Worksheet')}: ${result.sheetName} — ${t('header row')} ${result.headerRow}`);
    log.add(`${t('Item column')}: ${result.itemHeader}`);
    log.add(`${t('Price column')}: ${result.priceHeader}`);

    // The verb has to agree with the count, so the whole clause is pluralised.
    if (result.alternativePrices > 0) {
      log.add(plural(result.alternativePrices,
        'other price column was passed over.',
        'other price columns were passed over.'));
    }
    if (result.skippedBlank > 0) {
      log.add(plural(result.skippedBlank,
        'row had only one of the two values and was skipped.',
        'rows had only one of the two values and were skipped.'));
    }
    if (result.unsafeNumericItems > 0) {
      log.error(t('Some item codes were stored as unsafe large numbers. Excel had already rounded them in the source file; ask the supplier to send codes as text.'));
    }

    const name = result.filename || `${fallbackName}_price_fixed.xlsx`;
    saveBlob(new Blob([result.buffer], { type: XLSX_MIME }), name);

    status.set({
      phase: 'success',
      title: t('Processing complete'),
      summary: `${plural(result.count ?? 0, 'row', 'rows')} ${t('exported. Download started.')}`,
      progress: 100,
    });
    log.success(`${t('Download started')}: ${name}`);
  }

  function fail(error) {
    const message = error instanceof Error ? error.message : String(error);
    status.set({ phase: 'error', title: t('Processing failed'), summary: message, progress: 0 });
    log.error(message);
  }

  async function processFile(file) {
    if (!file || busy) return;

    if (!isSpreadsheet(file)) {
      status.set({ phase: 'error', title: t('Unsupported file'), summary: t('Choose an XLSX, XLS or CSV file.') });
      log.error(t('Unsupported file format.'));
      return;
    }

    setBusy(true);
    log.clear();
    status.set({ phase: 'processing', title: `${t('Opening')} ${file.name}`, summary: '', progress: 5 });
    log.add(`${t('Reading file')}: ${file.name}`);

    const baseName = file.name.replace(/\.[^/.]+$/, '') || 'prices';

    try {
      const buffer = await file.arrayBuffer();
      const result = await runSheetJob(
        { tool: 'price', kind: 'file', buffer, baseName },
        [buffer],
        (progress, text) => status.set({ progress, title: text || undefined }),
      );
      reportResult(result, baseName);
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  }

  async function processGrid() {
    if (!pastedGrid || busy) return;

    setBusy(true);
    log.clear();
    status.set({ phase: 'processing', title: t('Reading pasted table'), summary: '', progress: 10 });
    log.add(`${plural(pastedGrid.length, 'row', 'rows')} × ${plural(pastedGrid[0].length, 'column', 'columns')} ${t('pasted.')}`);

    try {
      const result = await runSheetJob(
        { tool: 'price', kind: 'paste', grid: pastedGrid, baseName: 'pasted' },
        [],
        (progress, text) => status.set({ progress, title: text || undefined }),
      );
      reportResult(result, 'pasted');
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  }

  const dropzone = createDropzone({
    iconName: 'badgeDollar',
    title: t('Choose or drop a supplier price list'),
    hint: t('Accepts XLSX, XLS and CSV. Every worksheet is scanned and the best item-code and updated-price columns are chosen.'),
    buttonLabel: t('Upload file'),
    accept: '.xlsx,.xls,.csv',
    multiple: false,
    onFiles: (files) => processFile(files[0]),
  });

  const pasteInfo = h('p', { class: 'muted' }, t('Nothing pasted yet.'));

  const pasteArea = h('textarea', {
    class: 'textarea',
    rows: '8',
    placeholder: t('Paste rows straight from Excel or a web page…'),
    'aria-label': t('Pasted table'),
    onPaste: (event) => {
      const html = event.clipboardData?.getData('text/html');
      const grid = gridFromHtml(html) || gridFromText(event.clipboardData?.getData('text/plain'));

      if (grid && grid.length) {
        event.preventDefault();
        pastedGrid = grid;
        hiddenRows = Math.max(0, grid.length - PREVIEW_ROWS);
        droppedRows = 0;
        previewText = grid.slice(0, PREVIEW_ROWS).map((row) => row.join('\t')).join('\n');
        pasteArea.value = previewText;
        syncPasteInfo();
      }
    },
    onInput: () => {
      // Untouched text means the grid it came from still stands. Re-reading the
      // box here would throw away every row past the preview, and would also
      // lose what only the HTML paste knew: which cells were merged.
      if (previewText && pasteArea.value === previewText) { syncPasteInfo(); return; }

      const grid = gridFromText(pasteArea.value);
      pastedGrid = grid && grid.length ? grid : null;
      droppedRows = hiddenRows;
      hiddenRows = 0;
      previewText = '';
      syncPasteInfo();
    },
  });

  function syncPasteInfo() {
    if (!pastedGrid) {
      pasteInfo.textContent = t('Nothing pasted yet.');
      generateButton.disabled = true;
      return;
    }

    const size = `${plural(pastedGrid.length, 'row', 'rows')} × ${plural(pastedGrid[0].length, 'column', 'columns')} ${t('ready.')}`;
    let note = '';
    if (hiddenRows > 0) note = t('Only the first rows are shown. All of them will be used, unless you edit the box.');
    if (droppedRows > 0) note = tf('Editing the box replaced the pasted table, so {count} rows that were not shown are no longer part of it. Paste again to get them back.', { count: droppedRows });

    pasteInfo.textContent = note ? `${size} ${note}` : size;
    generateButton.disabled = busy;
  }

  const generateButton = h('button', {
    type: 'button', class: 'btn', disabled: true,
    onClick: () => processGrid(),
  }, icon('download', 14), t('Generate XLSX'));

  const filePanel = h('div', null, dropzone.el);
  const pastePanel = h('div', { class: 'stack' },
    pasteArea,
    h('div', { class: 'row row--between' }, pasteInfo, generateButton));

  function setMode(value) {
    mode = value;
    filePanel.hidden = value !== 'file';
    pastePanel.hidden = value !== 'paste';
    for (const [key, button] of modeButtons) button.setAttribute('aria-pressed', String(mode === key));
  }

  function modeButton(value, label, iconName) {
    const button = h('button', {
      type: 'button',
      'aria-pressed': String(mode === value),
      onClick: () => { setMode(value); saveStored(MODE_KEY, value); },
    }, icon(iconName, 14), t(label));
    modeButtons.set(value, button);
    return button;
  }

  const root = h('div', { class: 'stack' },
    pageHead('badgeDollar', t('Price XLSX Fixer'),
      t('Extract item codes and updated consumer prices into text-safe XLSX output.')),

    h('section', { class: 'panel' },
      h('div', { class: 'panel__head' },
        h('div', null,
          h('h2', { class: 'panel__title' }, t('Input')),
          h('p', { class: 'panel__hint' }, t('Check the log: it names the worksheet and the two columns it chose.'))),
        h('div', { class: 'segmented', role: 'group', 'aria-label': t('Input mode') },
          modeButton('file', 'Upload file', 'upload'),
          modeButton('paste', 'Paste table', 'clipboard'))),
      filePanel,
      pastePanel),

    status.el,
    log.el,
  );

  setMode(mode);
  if (carried?.text) pasteArea.value = carried.text;
  syncPasteInfo();

  return {
    el: root,
    getState() { return { grid: pastedGrid, text: pasteArea.value }; },
    // A grid of strings and the text behind it are both JSON, so they survive
    // the reload that applying an update performs.
    getPortableState() { return { grid: pastedGrid, text: pasteArea.value }; },
    destroy() {},
  };
}
