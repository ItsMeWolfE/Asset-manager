// Spreadsheet worker client.
//
// The worker bundles SheetJS 0.18.5 together with the Dragon and Price column
// logic, carried over from 2.4.1 byte for byte. It is started from a Blob (a
// classic worker, not a module) because that is what fixed local file:// use in
// Chromium back in 2.0.2, and that constraint has not changed.

import { SHEET_WORKER_SRC } from '../vendor/sheet-worker-source.js';

let blobUrl = null;

function workerUrl() {
  if (blobUrl) return blobUrl;
  const blob = new Blob([SHEET_WORKER_SRC], { type: 'text/javascript;charset=utf-8' });
  blobUrl = URL.createObjectURL(blob);
  return blobUrl;
}

/**
 * Run one spreadsheet job.
 *
 * `message` is posted to a fresh worker, which is always terminated when the
 * job settles. `onProgress(percent, status)` is optional.
 * Returns the worker's success payload.
 */
export function runSheetJob(message, transfer = [], onProgress) {
  return new Promise((resolve, reject) => {
    let worker;
    try {
      worker = new Worker(workerUrl(), { name: 'asset-sheet-worker' });
    } catch {
      // Some locked-down contexts refuse blob: workers.
      reject(new Error('The spreadsheet worker could not be started in this browser.'));
      return;
    }

    const finish = (fn, value) => {
      worker.terminate();
      fn(value);
    };

    worker.onmessage = (event) => {
      const data = event.data;
      if (data.type === 'progress') {
        onProgress?.(data.progress ?? 0, data.status ?? '');
        return;
      }
      if (data.type === 'error') {
        finish(reject, new Error(data.message || 'The workbook could not be processed.'));
        return;
      }
      if (data.type === 'success') finish(resolve, data);
    };

    worker.onerror = (event) => {
      finish(reject, new Error(event.message || 'The background spreadsheet worker stopped unexpectedly.'));
    };

    try {
      worker.postMessage(message, transfer);
    } catch (error) {
      finish(reject, error instanceof Error ? error : new Error(String(error)));
    }
  });
}

export const XLSX_MIME =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export const isSpreadsheet = (file) => /\.(xlsx?|csv)$/i.test(file.name);
