// Background removal client.
//
// Owns the segmentation worker and the one-off cost of starting it. The model
// and the WebAssembly runtime together are about 16 MB, fetched only when
// somebody actually turns background removal on - nobody who never touches the
// option pays for it.
//
// Everything runs locally. The model is served from this origin like any other
// asset, and the images never leave the page.

const WORKER_URL = new URL('../workers/segment-worker.js', import.meta.url);

// Fetching ~16 MB over an office connection can be slow, and a first run also
// compiles the WebAssembly module. Inference itself is quick by comparison.
const WARMUP_TIMEOUT_MS = 180_000;
const SEGMENT_TIMEOUT_MS = 90_000;

let worker = null;
let nextId = 0;
let warmed = null;
const pending = new Map();

/**
 * Whether this browser can run the model at all.
 *
 * Module workers and OffscreenCanvas are the two things the worker cannot do
 * without; every browser that has them also has the WebAssembly it needs.
 */
export function isSegmentationSupported() {
  return typeof Worker !== 'undefined' &&
    typeof OffscreenCanvas !== 'undefined' &&
    typeof WebAssembly === 'object';
}

function failAll(error) {
  for (const job of pending.values()) {
    window.clearTimeout(job.timer);
    job.reject(error);
  }
  pending.clear();
  worker?.terminate();
  worker = null;
  warmed = null;
}

function getWorker() {
  if (worker) return worker;

  worker = new Worker(WORKER_URL, { type: 'module', name: 'asset-background-removal' });

  worker.onmessage = (event) => {
    const job = pending.get(event.data.id);
    if (!job) return;
    window.clearTimeout(job.timer);
    pending.delete(event.data.id);

    if (event.data.error) job.reject(new Error(event.data.error));
    else job.resolve(event.data);
  };

  worker.onerror = (event) => {
    failAll(new Error(event.message || 'The background model failed to start'));
  };

  return worker;
}

function send(message, transfer, timeoutMs, timeoutText) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = window.setTimeout(() => {
      pending.delete(id);
      reject(new Error(timeoutText));
    }, timeoutMs);

    pending.set(id, { resolve, reject, timer });
    try {
      getWorker().postMessage({ ...message, id }, transfer || []);
    } catch (error) {
      window.clearTimeout(timer);
      pending.delete(id);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

/**
 * Download and compile the model.
 *
 * Safe to call repeatedly: the work happens once and later callers await the
 * same promise. Calling it before a batch keeps the wait in one visible place
 * instead of stretching out the first image.
 */
export function warmUpSegmentation() {
  if (!warmed) {
    warmed = send({ type: 'warmup' }, [], WARMUP_TIMEOUT_MS,
      'Timed out loading the background model')
      .catch((error) => { warmed = null; throw error; });
  }
  return warmed;
}

/**
 * Compute a per-pixel alpha mask for one frame.
 *
 * Takes an ImageData and hands back a Uint8ClampedArray of width*height alpha
 * values. The pixel buffer is transferred, so the caller must not read the
 * ImageData afterwards.
 */
export async function segmentAlpha(imageData) {
  const { width, height } = imageData;
  const result = await send(
    { width, height, buffer: imageData.data.buffer },
    [imageData.data.buffer],
    SEGMENT_TIMEOUT_MS,
    'Background removal timed out',
  );
  return new Uint8ClampedArray(result.alpha);
}

/** Drop the worker and the memory the model holds. */
export function releaseSegmentation() {
  if (!worker && !pending.size) return;
  failAll(new Error('Background removal was cancelled'));
}
