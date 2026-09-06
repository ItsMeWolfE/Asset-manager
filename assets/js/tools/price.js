// Price XLSX Fixer - pulls item codes and updated prices out of a supplier list.
//
// The header scoring, column choice and text-safe output all live in the
// spreadsheet worker, unchanged from 2.4.1. This file handles input (a workbook
// or a pasted table) and reports what the worker decided.

import { h, icon } from '../core/dom.js';
import { t, plural } from '../core/i18n.js';
import { createStatus, createLog, createDropzone, pageHead } from '../core/ui.js';
import { runSheetJob, isSpreadsheet, XLSX_MIME } from '../core/sheet.js';
import { saveBlob } from '../core/files.js';

/**
 * Square off a ragged grid: trim trailing blank rows, then pad every row to the
 * widest one so the worker sees a rectangle.
 */
function normalizeGrid(rows) {
  if (!Array.isArray(rows)) return [];

  const grid = rows.map((row) => (Array.isArray(row) ? row : [row])
    .map((cell) => String(cell ?? '').replace(/ /g, ' ').trim()));

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

/** Pull a grid out of pasted HTML, using whichever table has the most cells. */
function gridFromHtml(html) {
  if (!html || !/<table[\s>]/i.test(html)) return null;

  const doc = new DOMParser().parseFromString(html, 'text/html');
  const tables = Array.from(doc.querySelectorAll('table'));
  if (!tables.length) return null;

  const table = tables.sort((a, b) =>
    b.querySelectorAll('th, td').length - a.querySelectorAll('th, td').length)[0];

  const grid = Array.from(table.rows).map((row) =>
    Array.from(row.cells).map((cell) => cell.textContent ?? ''));

  return normalizeGrid(grid);
}

/** Tab-separated clipboard text, as Excel and Sheets produce it. */
function gridFromText(text) {
  if (!text) return null;
  const rows = text.replace(/\r\n?/g, '\n').split('\n').map((line) => line.split('\t'));
  return normalizeGrid(rows);
}

export function createPrice() {
  let mode = 'file';
  let busy = false;
  let pastedGrid = null;

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
    log.add(`${plural(pastedGrid.length, 'row', 'rows')} ${t('pasted.')}`);

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
        pasteArea.value = grid.slice(0, 40).map((row) => row.join('\t')).join('\n');
        pasteInfo.textContent = `${plural(grid.length, 'row', 'rows')} × ${plural(grid[0].length, 'column', 'columns')} ${t('ready.')}`;
        generateButton.disabled = false;
      }
    },
    onInput: () => {
      const grid = gridFromText(pasteArea.value);
      pastedGrid = grid && grid.length ? grid : null;
      pasteInfo.textContent = pastedGrid
        ? `${plural(pastedGrid.length, 'row', 'rows')} × ${plural(pastedGrid[0].length, 'column', 'columns')} ${t('ready.')}`
        : t('Nothing pasted yet.');
      generateButton.disabled = !pastedGrid;
    },
  });

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
      onClick: () => setMode(value),
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

  setMode('file');

  return { el: root, destroy() {} };
}
