// Dragon Fixer - turns a Dragon stock export into the two-column import file.
//
// Column detection, the availability mapping and the barcode filtering all run
// in the spreadsheet worker, unchanged from 2.4.1.

import { h, icon } from '../core/dom.js';
import { t, plural } from '../core/i18n.js';
import { createStatus, createLog, createDropzone, pageHead } from '../core/ui.js';
import { runSheetJob, isSpreadsheet, XLSX_MIME } from '../core/sheet.js';
import { saveBlob } from '../core/files.js';
import { loadStored, saveStored } from '../core/prefs.js';

const FILTER_KEY = 'asset-manager-dragon-filter-v1';
const isFilter = (v) => v === 'all' || v === 'in' || v === 'out';

export function createDragon() {
  let filter = loadStored(FILTER_KEY, isFilter, 'all');
  let busy = false;

  const status = createStatus();
  const log = createLog();
  const filterButtons = new Map();

  function filterButton(value, label, iconName) {
    const button = h('button', {
      type: 'button',
      'aria-pressed': String(filter === value),
      onClick: () => {
        filter = value;
        saveStored(FILTER_KEY, value);
        for (const [key, btn] of filterButtons) btn.setAttribute('aria-pressed', String(filter === key));
      },
    }, iconName ? icon(iconName, 14) : null, t(label));

    filterButtons.set(value, button);
    return button;
  }

  function setBusy(value) {
    busy = value;
    for (const button of filterButtons.values()) button.disabled = value;
    dropzone.setBusy(value);
  }

  async function process(file) {
    if (!file || busy) return;

    if (!isSpreadsheet(file)) {
      status.set({ phase: 'error', title: t('Unsupported file'), summary: t('Choose an XLSX, XLS or CSV file.') });
      log.error(t('Unsupported file format.'));
      return;
    }

    setBusy(true);
    log.clear();
    status.set({
      phase: 'processing',
      title: `${t('Opening')} ${file.name}`,
      summary: t('Barcode text and stock values are normalized locally.'),
      progress: 5,
    });
    log.add(`${t('Reading file')}: ${file.name}`);

    try {
      const buffer = await file.arrayBuffer();
      const result = await runSheetJob(
        { tool: 'dragon', buffer, filter },
        [buffer],
        (progress, text) => status.set({ progress, title: text || undefined }),
      );

      const name = `${file.name.replace(/\.[^/.]+$/, '')}_dragon_fixed.xlsx`;
      saveBlob(new Blob([result.buffer], { type: XLSX_MIME }), name);

      status.set({
        phase: 'success',
        title: t('Processing complete'),
        summary: `${plural(result.count ?? 0, 'product', 'products')} ${t('exported. Download started.')}`,
        progress: 100,
      });
      log.success(`${t('Download started')}: ${name}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      status.set({ phase: 'error', title: t('Processing failed'), summary: message, progress: 0 });
      log.error(message);
    } finally {
      setBusy(false);
    }
  }

  const dropzone = createDropzone({
    iconName: 'table',
    title: t('Choose or drop a Dragon spreadsheet'),
    hint: t('Accepts XLSX, XLS and CSV. Barcodes are read as formatted text so leading zeroes survive.'),
    buttonLabel: t('Select spreadsheet'),
    accept: '.xlsx,.xls,.csv',
    multiple: false,
    onFiles: (files) => process(files[0]),
  });

  const root = h('div', { class: 'stack' },
    pageHead('table', t('Dragon Fixer'), t('Normalize Dragon inventory spreadsheets for import.')),

    h('section', { class: 'panel' },
      h('div', { class: 'panel__head' },
        h('div', null,
          h('h2', { class: 'panel__title' }, t('Stock filter')),
          h('p', { class: 'panel__hint' }, t('Applied when the file is processed, so set it before loading.'))),
        h('div', { class: 'segmented', role: 'group', 'aria-label': t('Stock filter') },
          filterButton('all', 'All products'),
          filterButton('in', 'In stock (10)', 'check'),
          filterButton('out', 'Out of stock (9)', 'x'))),
      dropzone.el),

    status.el,
    log.el,
  );

  return { el: root, destroy() {} };
}
