// Background removal.
//
// Runs U^2-Net (the small "u2netp" variant) through ONNX Runtime Web on the
// WebAssembly backend, so inference happens on the CPU of whatever machine has
// the page open. No pixels leave the browser, no GPU is involved, and nothing
// has to be installed - which is the whole point, because this runs on office
// machines with neither a discrete GPU nor permission to install software.
//
// A module worker rather than the classic Blob workers used elsewhere in the
// app: ONNX Runtime loads its WebAssembly glue through a dynamic import, which
// needs a real same-origin URL to resolve against.

import * as ort from '../../vendor/onnxruntime/ort.min.mjs';

const MODEL_URL = new URL('../../models/u2netp.onnx', import.meta.url);
const WASM_DIR = new URL('../../vendor/onnxruntime/', import.meta.url);

// U^2-Net was trained at 320x320. Keeping to it is both the accurate choice and
// what holds a CPU forward pass to a few hundred milliseconds.
const SIDE = 320;
const AREA = SIDE * SIDE;

// ImageNet statistics, matching the reference U^2-Net preprocessing.
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

// The network's rim is soft. Products have hard edges, so the midtones get
// pulled apart: below LO is background, above HI is product, and the narrow
// band between stays anti-aliased so the cutout does not look sawn out.
const EDGE_LO = 0.30;
const EDGE_HI = 0.70;

// How far the kept blobs are grown before they are used to suppress everything
// else. Enough to spare their own soft rims, not enough to readmit a nearby
// reflection.
const KEEP_DILATE = 3;

// A blob this big relative to the largest one is treated as part of the
// product. Product shots are routinely more than one piece - a pair of shoes,
// a set, a lid beside a jar - and dropping everything but the single biggest
// mass silently deletes half the product. Real network noise is a fraction of
// a percent, so this sits far above it and far below any genuine second item.
const KEEP_RATIO = 0.10;

ort.env.wasm.wasmPaths = WASM_DIR.href;
// SharedArrayBuffer needs COOP/COEP headers, which GitHub Pages cannot send, so
// threads are unavailable by definition. Asking for one skips the probe and the
// failed worker spawn behind it.
ort.env.wasm.numThreads = 1;
ort.env.wasm.simd = true;
ort.env.logLevel = 'error';

let sessionPromise = null;

function session() {
  if (!sessionPromise) {
    sessionPromise = ort.InferenceSession
      .create(MODEL_URL.href, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' })
      .catch((error) => { sessionPromise = null; throw error; });
  }
  return sessionPromise;
}

/** Scale the full-size frame down to the network's square input. */
function toInput(rgba, width, height) {
  const full = new OffscreenCanvas(width, height);
  full.getContext('2d').putImageData(new ImageData(rgba, width, height), 0, 0);

  const small = new OffscreenCanvas(SIDE, SIDE);
  const ctx = small.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  // Aspect is deliberately not preserved: the reference implementation squashes
  // to the square too, and the mask is stretched back the same way afterwards.
  ctx.drawImage(full, 0, 0, width, height, 0, 0, SIDE, SIDE);
  return ctx.getImageData(0, 0, SIDE, SIDE).data;
}

function toTensor(small) {
  const data = new Float32Array(3 * AREA);

  // Reference U^2-Net divides by the brightest channel present rather than a
  // flat 255, which stops an underexposed photo reaching the net dark.
  let max = 0;
  for (let i = 0; i < small.length; i += 4) {
    if (small[i] > max) max = small[i];
    if (small[i + 1] > max) max = small[i + 1];
    if (small[i + 2] > max) max = small[i + 2];
  }
  if (max === 0) max = 1;

  for (let p = 0, i = 0; p < AREA; p += 1, i += 4) {
    data[p] = (small[i] / max - MEAN[0]) / STD[0];
    data[AREA + p] = (small[i + 1] / max - MEAN[1]) / STD[1];
    data[2 * AREA + p] = (small[i + 2] / max - MEAN[2]) / STD[2];
  }
  return new ort.Tensor('float32', data, [1, 3, SIDE, SIDE]);
}

/** Rescale the raw saliency map into 0..1. */
function normalise(raw) {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < raw.length; i += 1) {
    if (raw[i] < lo) lo = raw[i];
    if (raw[i] > hi) hi = raw[i];
  }
  const span = hi - lo || 1;
  const mask = new Float32Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) mask[i] = (raw[i] - lo) / span;
  return mask;
}

/**
 * Drop the specks, keep the product.
 *
 * Whatever the network lights up away from the product - a reflection, a
 * shadow on the backdrop, a stray highlight - is noise, and cutting it leaves
 * a cleaner result. But a product shot is often more than one piece, so this
 * keeps every blob within KEEP_RATIO of the largest rather than the largest
 * alone. The survivors are grown by a few pixels before they mask the rest, so
 * their own soft rims live through it.
 *
 * Flood fill is iterative on purpose: recursion blows the stack on a subject
 * that fills the frame.
 */
function keepMainBlobs(mask) {
  const solid = new Uint8Array(AREA);
  for (let i = 0; i < AREA; i += 1) solid[i] = mask[i] >= 0.5 ? 1 : 0;

  const label = new Int32Array(AREA).fill(-1);
  const stack = new Int32Array(AREA);
  const sizes = [];

  for (let start = 0; start < AREA; start += 1) {
    if (!solid[start] || label[start] !== -1) continue;

    const id = sizes.length;
    let top = 0;
    let size = 0;
    stack[top] = start;
    top += 1;
    label[start] = id;

    while (top > 0) {
      top -= 1;
      const p = stack[top];
      size += 1;
      const x = p % SIDE;
      const y = (p / SIDE) | 0;
      if (x > 0 && solid[p - 1] && label[p - 1] === -1) { label[p - 1] = id; stack[top] = p - 1; top += 1; }
      if (x < SIDE - 1 && solid[p + 1] && label[p + 1] === -1) { label[p + 1] = id; stack[top] = p + 1; top += 1; }
      if (y > 0 && solid[p - SIDE] && label[p - SIDE] === -1) { label[p - SIDE] = id; stack[top] = p - SIDE; top += 1; }
      if (y < SIDE - 1 && solid[p + SIDE] && label[p + SIDE] === -1) { label[p + SIDE] = id; stack[top] = p + SIDE; top += 1; }
    }
    sizes.push(size);
  }

  // Nothing crossed the threshold - an empty or featureless frame. Leave the
  // mask alone rather than handing back a blank one.
  if (!sizes.length) return mask;

  let biggest = 0;
  for (let i = 0; i < sizes.length; i += 1) if (sizes[i] > biggest) biggest = sizes[i];
  const floor = biggest * KEEP_RATIO;

  const keep = new Uint8Array(AREA);
  for (let i = 0; i < AREA; i += 1) {
    if (label[i] !== -1 && sizes[label[i]] >= floor) keep[i] = 1;
  }

  let grown = keep;
  for (let pass = 0; pass < KEEP_DILATE; pass += 1) {
    const next = grown.slice();
    for (let y = 0; y < SIDE; y += 1) {
      for (let x = 0; x < SIDE; x += 1) {
        const p = y * SIDE + x;
        if (grown[p]) continue;
        if ((x > 0 && grown[p - 1]) || (x < SIDE - 1 && grown[p + 1]) ||
            (y > 0 && grown[p - SIDE]) || (y < SIDE - 1 && grown[p + SIDE])) next[p] = 1;
      }
    }
    grown = next;
  }

  const out = new Float32Array(AREA);
  for (let i = 0; i < AREA; i += 1) out[i] = grown[i] ? mask[i] : 0;
  return out;
}

/** Crisp up the rim, then stretch the mask back to the source dimensions. */
function toAlpha(mask, width, height) {
  const small = new ImageData(SIDE, SIDE);
  const px = small.data;
  const span = EDGE_HI - EDGE_LO;

  for (let i = 0; i < AREA; i += 1) {
    let v = (mask[i] - EDGE_LO) / span;
    v = v <= 0 ? 0 : v >= 1 ? 1 : v * v * (3 - 2 * v); // smoothstep
    const b = Math.round(v * 255);
    const o = i * 4;
    px[o] = b;
    px[o + 1] = b;
    px[o + 2] = b;
    px[o + 3] = 255;
  }

  const from = new OffscreenCanvas(SIDE, SIDE);
  from.getContext('2d').putImageData(small, 0, 0);

  const to = new OffscreenCanvas(width, height);
  const ctx = to.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(from, 0, 0, SIDE, SIDE, 0, 0, width, height);

  const big = ctx.getImageData(0, 0, width, height).data;
  const alpha = new Uint8ClampedArray(width * height);
  for (let i = 0, o = 0; i < alpha.length; i += 1, o += 4) alpha[i] = big[o];
  return alpha;
}

self.onmessage = async (event) => {
  const { id, type, width, height, buffer } = event.data;

  try {
    if (type === 'warmup') {
      await session();
      self.postMessage({ id, ready: true });
      return;
    }

    const active = await session();
    const input = toInput(new Uint8ClampedArray(buffer), width, height);
    const output = await active.run({ [active.inputNames[0]]: toTensor(input) });

    // U^2-Net emits seven side outputs; the first is the fused prediction and
    // the only one worth reading.
    const raw = output[active.outputNames[0]].data;
    const alpha = toAlpha(keepMainBlobs(normalise(raw)), width, height);

    self.postMessage({ id, width, height, alpha: alpha.buffer }, [alpha.buffer]);
  } catch (error) {
    self.postMessage({ id, error: error?.message || 'Background removal failed' });
  }
};
