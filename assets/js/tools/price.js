// XLSX Fixer - pulls item codes out of a supplier list, together with either
// the updated price or the 9/10 stock value the import expects.
//
// The header scoring, column choice and text-safe output all live in the
// spreadsheet worker: the price half unchanged from 2.4.1, the stock half
// beside it in vendor/stock-processor-source.js. This file handles input (a
// workbook or a pasted table) and reports what the worker decided.

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
const STOCK_HINT = /מלאי|זמינ|כמות|stock|availab/i;

const hasHeaderRow = (grid) => grid.some((row) =>
  row.some((cell) => ITEM_HINT.test(cell))
  && row.some((cell) => PRICE_HINT.test(cell) || STOCK_HINT.test(cell)));

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

  // What the file is being read for. Carried across a tool switch or a language
  // change, like the pasted table is, but deliberately not remembered between
  // visits: which of the two columns a run writes, and which value it writes,
  // are too easy to leave set from last week and never look at.
  let category = carried?.category === 'stock' ? 'stock' : 'price';
  let stockSource = carried?.stockSource === 'all' ? 'all' : 'detect';
  let stockValue = carried?.stockValue === '9' ? '9' : '10';

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

  // Every toggle on the page, so a run can disable the lot of them.
  const controls = [];

  function setBusy(value) {
    busy = value;
    for (const button of controls) button.disabled = value;
    dropzone.setBusy(value);
    generateButton.disabled = value || !pastedGrid;
    pasteArea.disabled = value;
  }

  /**
   * One segmented control. `read` is called rather than captured because the
   * value it reflects lives in a variable these buttons themselves reassign.
   */
  function segmented(label, read, write, entries) {
    const buttons = new Map();

    const group = h('div', { class: 'segmented', role: 'group', 'aria-label': label });

    for (const [value, text, iconName] of entries) {
      const button = h('button', {
        type: 'button',
        'aria-pressed': String(read() === value),
        onClick: () => {
          write(value);
          for (const [key, entry] of buttons) entry.setAttribute('aria-pressed', String(key === value));
        },
      }, iconName ? icon(iconName, 14) : null, t(text));

      buttons.set(value, button);
      controls.push(button);
      group.append(button);
    }

    return group;
  }

  // -------------------------------------------------------------------------
  // Running a job
  // -------------------------------------------------------------------------

  /** The worker message for the current category, given one input source. */
  const jobFor = (source) => (category === 'price'
    ? { tool: 'price', ...source }
    : { tool: 'stock', mode: stockSource, value: stockValue, ...source });

  function reportResult(result, fallbackName) {
    // A headerless list has no heading to name, and the columns are reported by
    // their letter instead - so the log still says which two were read.
    if (result.headerless) {
      log.add(`${t('Worksheet')}: ${result.sheetName} — ${t('no header row')}`);
      log.add(t('The columns were chosen by what is in them, not by their headings.'));
    } else {
      log.add(`${t('Worksheet')}: ${result.sheetName} — ${t('header row')} ${result.headerRow}`);
    }

    log.add(`${t('Item column')}: ${result.itemHeader}`);

    if (category === 'price') {
      log.add(`${t('Price column')}: ${result.priceHeader}`);

      // The verb has to agree with the count, so the whole clause is pluralised.
      if (result.alternativePrices > 0) {
        log.add(plural(result.alternativePrices,
          'other price column was passed over.',
          'other price columns were passed over.'));
      }
    } else if (result.stockHeader) {
      log.add(`${t('Stock column')}: ${result.stockHeader}`);

      if (result.alternativeStock > 0) {
        log.add(plural(result.alternativeStock,
          'other stock column was passed over.',
          'other stock columns were passed over.'));
      }
    } else {
      log.add(`${t('Stock value')}: ${t(result.value === '9' ? 'Out of stock (9)' : 'In stock (10)')}`);
    }

    if (result.skippedBlank > 0) {
      log.add(plural(result.skippedBlank,
        'row had only one of the two values and was skipped.',
        'rows had only one of the two values and were skipped.'));
    }

    // A wording nobody has taught it is reported rather than guessed at, with
    // the actual text, so it can be added.
    if (result.skippedUnknown > 0) {
      log.add(plural(result.skippedUnknown,
        'row had a stock value that could not be read and was skipped.',
        'rows had stock values that could not be read and were skipped.'));
      if (result.unknownSamples?.length) {
        log.add(`${t('For example')}: ${result.unknownSamples.join(' · ')}`);
      }
    }

    if (result.unsafeNumericItems > 0) {
      log.error(t('Some item codes were stored as unsafe large numbers. Excel had already rounded them in the source file; ask the supplier to send codes as text.'));
    }

    const suffix = category === 'price' ? '_price_fixed.xlsx' : '_stock_fixed.xlsx';
    const name = result.filename || `${fallbackName}${suffix}`;
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
        jobFor({ kind: 'file', buffer, baseName }),
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
        jobFor({ kind: 'paste', grid: pastedGrid, baseName: 'pasted' }),
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

  // -------------------------------------------------------------------------
  // Input
  // -------------------------------------------------------------------------

  const dropzone = createDropzone({
    iconName: 'archive',
    title: t('Choose or drop a supplier spreadsheet'),
    hint: t('Accepts XLSX, XLS and CSV. Every worksheet is scanned and the best item-code column is chosen, together with the price or stock column beside it.'),
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
  }

  const modeSwitch = segmented(t('Input mode'), () => mode, (value) => {
    setMode(value);
    saveStored(MODE_KEY, value);
  }, [['file', 'Upload file', 'upload'], ['paste', 'Paste table', 'clipboard']]);

  // -------------------------------------------------------------------------
  // What to extract
  // -------------------------------------------------------------------------

  const DETECT_HINT = 'The stock column is found the way the price column is. Wordings like "יש במלאי" and "3 יחידות" become 10, and "אין במלאי" or "אזל במלאי" become 9; anything it cannot read is skipped and counted in the log.';
  const MARK_HINT = 'No stock column is read. Every item code in the file is written out against the one value you choose here.';

  const stockHint = h('p', { class: 'panel__hint' }, t(DETECT_HINT));

  const valueRow = h('div', { class: 'row' },
    h('span', { class: 'field__label' }, t('Value to write')),
    segmented(t('Value to write'), () => stockValue, (value) => { stockValue = value; },
      [['10', 'In stock (10)', 'check'], ['9', 'Out of stock (9)', 'x']]));

  function setStockSource(value) {
    stockSource = value;
    valueRow.hidden = value !== 'all';
    stockHint.textContent = t(value === 'all' ? MARK_HINT : DETECT_HINT);
  }

  const stockPanel = h('div', { class: 'stack' },
    h('div', { class: 'row' },
      h('span', { class: 'field__label' }, t('Stock source')),
      segmented(t('Stock source'), () => stockSource, setStockSource,
        [['detect', 'Read the stock column', 'table'], ['all', 'Mark every row', 'wand']])),
    valueRow,
    stockHint);

  function setCategory(value) {
    category = value;
    stockPanel.hidden = value !== 'stock';
  }

  const categorySwitch = segmented(t('Output'), () => category, setCategory,
    [['price', 'Prices', 'badgeDollar'], ['stock', 'Stock', 'archive']]);

  const root = h('div', { class: 'stack' },
    pageHead('archive', t('XLSX Fixer'),
      t('Extract item codes with updated prices or stock values into text-safe XLSX output.')),

    h('section', { class: 'panel' },
      h('div', { class: 'panel__head' },
        h('div', null,
          h('h2', { class: 'panel__title' }, t('Output')),
          h('p', { class: 'panel__hint' }, t('Prices, or the 9 and 10 stock values the import expects.'))),
        categorySwitch),
      stockPanel),

    h('section', { class: 'panel' },
      h('div', { class: 'panel__head' },
        h('div', null,
          h('h2', { class: 'panel__title' }, t('Input')),
          h('p', { class: 'panel__hint' }, t('Check the log: it names the worksheet and the columns it chose.'))),
        modeSwitch),
      filePanel,
      pastePanel),

    status.el,
    log.el,
  );

  setCategory(category);
  setStockSource(stockSource);
  setMode(mode);
  if (carried?.text) pasteArea.value = carried.text;
  syncPasteInfo();

  return {
    el: root,
    getState() {
      return { grid: pastedGrid, text: pasteArea.value, category, stockSource, stockValue };
    },
    // A grid of strings and the text behind it are both JSON, so they survive
    // the reload that applying an update performs. What the run was set to
    // write goes with them, so an update applied mid-job does not quietly
    // change the answer.
    getPortableState() {
      return { grid: pastedGrid, text: pasteArea.value, category, stockSource, stockValue };
    },
    destroy() {},
  };
}
