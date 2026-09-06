// Image decoding, encoding and the crop pipeline.
//
// Bounds detection runs in assets/js/workers/crop-worker.js so a large batch
// never blocks the interface. That worker's algorithm is carried over from
// 2.4.1 unchanged, including the alpha-edge fix.

import { CROP_WORKER_SRC } from '../workers/crop-worker-source.js';
import { segmentAlpha } from './segment.js';

const ANALYSIS_TIMEOUT_MS = 60_000;

let cropWorkerUrl = null;

function cropWorkerUrlOnce() {
  if (!cropWorkerUrl) {
    const blob = new Blob([CROP_WORKER_SRC], { type: 'text/javascript;charset=utf-8' });
    cropWorkerUrl = URL.createObjectURL(blob);
  }
  return cropWorkerUrl;
}

/** Lossless WebP where the browser supports it, PNG everywhere else. */
export const WEBP_OK = (() => {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const ok = typeof canvas.toDataURL === 'function' &&
      canvas.toDataURL('image/webp').startsWith('data:image/webp');
    canvas.width = 0;
    canvas.height = 0;
    return ok;
  } catch {
    return false;
  }
})();

export const OUTPUT_MIME = WEBP_OK ? 'image/webp' : 'image/png';
export const OUTPUT_EXT = WEBP_OK ? 'webp' : 'png';

// ---------------------------------------------------------------------------
// Crop worker client
// ---------------------------------------------------------------------------

let worker = null;
let nextId = 0;
const pending = new Map();

function getWorker() {
  if (worker) return worker;

  worker = new Worker(cropWorkerUrlOnce(), { name: 'asset-crop-scanner' });

  worker.onmessage = (event) => {
    const job = pending.get(event.data.id);
    if (!job) return;
    window.clearTimeout(job.timer);
    pending.delete(event.data.id);

    if (event.data.error) job.reject(new Error(event.data.error));
    else job.resolve(event.data.bounds ?? null);
  };

  worker.onerror = (event) => {
    const error = new Error(event.message || 'Crop worker failed');
    for (const job of pending.values()) {
      window.clearTimeout(job.timer);
      job.reject(error);
    }
    pending.clear();
    worker?.terminate();
    worker = null;
  };

  return worker;
}

/** Ask the worker for the content bounds of an ImageData. */
function analyse(imageData) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = window.setTimeout(() => {
      pending.delete(id);
      reject(new Error('Crop analysis timed out'));
    }, ANALYSIS_TIMEOUT_MS);

    pending.set(id, { resolve, reject, timer });
    getWorker().postMessage(
      { id, width: imageData.width, height: imageData.height, buffer: imageData.data.buffer },
      [imageData.data.buffer],
    );
  });
}

// ---------------------------------------------------------------------------
// Decode / encode
// ---------------------------------------------------------------------------

/** Decode a file to something drawable, with a cleanup callback. */
export async function decodeImage(file) {
  if ('createImageBitmap' in window) {
    try {
      const bitmap = await createImageBitmap(file);
      return { source: bitmap, cleanup: () => bitmap.close() };
    } catch { /* fall through to the <img> path */ }
  }

  const url = URL.createObjectURL(file);
  try {
    const image = await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Image decoding failed'));
      img.src = url;
    });
    return { source: image, cleanup: () => URL.revokeObjectURL(url) };
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}

/** Encode a canvas, preferring lossless WebP. */
export function encodeCanvas(canvas) {
  return new Promise((resolve, reject) => {
    const fallback = () => {
      try {
        const url = canvas.toDataURL(OUTPUT_MIME, 1);
        const [meta, data] = url.split(',');
        const binary = atob(data);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
        resolve(new Blob([bytes], { type: meta.slice(5).split(';')[0] }));
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    };

    if (typeof canvas.toBlob !== 'function') { fallback(); return; }

    try {
      canvas.toBlob((blob) => (blob ? resolve(blob) : fallback()), OUTPUT_MIME, 1);
    } catch {
      fallback();
    }
  });
}

/**
 * The dominant border colour, used to fill the overhang in square mode.
 * Returns null when the border is effectively transparent.
 */
function edgeColour(data, w, h) {
  const at = (x, y) => {
    const i = (y * w + x) * 4;
    return [data[i], data[i + 1], data[i + 2], data[i + 3]];
  };
  const mx = w >> 1;
  const my = h >> 1;
  const samples = [
    at(0, 0), at(w - 1, 0), at(0, h - 1), at(w - 1, h - 1),
    at(mx, 0), at(mx, h - 1), at(0, my), at(w - 1, my),
  ];

  let best = samples[0];
  let bestScore = Infinity;
  for (const sample of samples) {
    let score = 0;
    for (const other of samples) {
      score += Math.abs(sample[0] - other[0]) +
        Math.abs(sample[1] - other[1]) +
        Math.abs(sample[2] - other[2]) +
        Math.abs(sample[3] - other[3]);
    }
    if (score < bestScore) { bestScore = score; best = sample; }
  }

  if (best[3] <= 15) return null;
  return `rgba(${best[0]},${best[1]},${best[2]},${(best[3] / 255).toFixed(4)})`;
}

/**
 * Crop one image to its content.
 *
 * Returns a Blob, or null when the image is entirely background.
 * In square mode the crop is expanded to a centred 1:1 box and any area beyond
 * the source is filled with the detected border colour.
 *
 * With `removeBackground` the subject is cut out first and everything else is
 * made transparent. Bounds detection then runs over the cutout, so the crop
 * follows the product rather than whatever the backdrop happened to reach -
 * and in square mode the fill colour comes out transparent, because by then
 * the border genuinely is.
 */
export async function cropImage(file, square, removeBackground = false) {
  const { source, cleanup } = await decodeImage(file);
  let scratch = null;

  try {
    const width = 'naturalWidth' in source ? source.naturalWidth : source.width;
    const height = 'naturalHeight' in source ? source.naturalHeight : source.height;
    if (!width || !height) throw new Error('Invalid image dimensions');

    scratch = document.createElement('canvas');
    scratch.width = width;
    scratch.height = height;

    const scratchCtx = scratch.getContext('2d', { willReadFrequently: true });
    if (!scratchCtx) throw new Error('Canvas 2D context is unavailable');

    scratchCtx.clearRect(0, 0, width, height);
    scratchCtx.drawImage(source, 0, 0);

    const imageData = scratchCtx.getImageData(0, 0, width, height);

    // Whatever the final crop is drawn from. Background removal replaces it
    // with the masked canvas, since the original still has its backdrop.
    let drawSource = source;

    if (removeBackground) {
      // segmentAlpha() transfers the buffer it is handed, so it gets a copy and
      // the original stays readable for the bounds pass below.
      const copy = new ImageData(new Uint8ClampedArray(imageData.data), width, height);
      const alpha = await segmentAlpha(copy);

      // Multiply rather than overwrite: a source PNG may already be partly
      // transparent, and that transparency should survive.
      const px = imageData.data;
      for (let i = 3, a = 0; a < alpha.length; i += 4, a += 1) {
        px[i] = (px[i] * alpha[a]) / 255;
      }

      scratchCtx.putImageData(imageData, 0, 0);
      drawSource = scratch;
    }

    const background = square ? edgeColour(imageData.data, width, height) : null;

    // analyse() transfers the pixel buffer, so read anything needed from it first.
    const bounds = await analyse(imageData);

    if (!bounds) return null;

    let cropW = bounds.maxX - bounds.minX + 1;
    let cropH = bounds.maxY - bounds.minY + 1;
    let sx = bounds.minX;
    let sy = bounds.minY;
    if (cropW <= 0 || cropH <= 0) throw new Error('Invalid crop bounds');

    if (square) {
      const side = Math.max(cropW, cropH);
      sx = Math.round(bounds.minX + cropW / 2 - side / 2);
      sy = Math.round(bounds.minY + cropH / 2 - side / 2);
      cropW = side;
      cropH = side;
    }

    const out = document.createElement('canvas');
    out.width = cropW;
    out.height = cropH;

    const ctx = out.getContext('2d');
    if (!ctx) throw new Error('Output canvas is unavailable');
    ctx.clearRect(0, 0, cropW, cropH);

    const x0 = Math.max(0, sx);
    const y0 = Math.max(0, sy);
    const x1 = Math.min(width, sx + cropW);
    const y1 = Math.min(height, sy + cropH);

    const overhangs = x0 > 0 || y0 > 0 || x1 - sx < cropW || y1 - sy < cropH;
    if (background && overhangs) {
      ctx.fillStyle = background;
      ctx.fillRect(0, 0, cropW, cropH);
    }

    if (x1 > x0 && y1 > y0) {
      ctx.drawImage(drawSource, x0, y0, x1 - x0, y1 - y0, x0 - sx, y0 - sy, x1 - x0, y1 - y0);
    }

    const blob = await encodeCanvas(out);
    out.width = 1;
    out.height = 1;
    return blob;
  } finally {
    // Kept alive until here: with background removal the scratch canvas is the
    // thing the crop is drawn from, so it cannot be released any earlier.
    if (scratch) {
      scratch.width = 1;
      scratch.height = 1;
    }
    cleanup();
  }
}

/** Give each output a unique name, appending _2, _3 … on collision. */
export function uniqueName(sourceName, taken) {
  const base = sourceName.replace(/\.[^/.]+$/, '') || 'image';
  let name = `${base}.${OUTPUT_EXT}`;
  if (!taken) return name;

  let n = 2;
  while (taken.has(name)) {
    name = `${base}_${n}.${OUTPUT_EXT}`;
    n += 1;
  }
  taken.add(name);
  return name;
}

/** Run `task` over `items` with at most `limit` in flight. */
export async function mapLimit(items, limit, task) {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      await task(items[index], index);
    }
  });
  await Promise.all(runners);
}
