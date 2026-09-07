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
//
// The pipeline, in order:
//
//   1. A pass over the whole frame, to find roughly where the product is.
//   2. A second pass over just that region, when the product does not already
//      fill the frame. The network always sees 320x320, so cropping to the
//      product is the only way to spend those pixels on it - which is what
//      rescues a trailing sheet of paper or an aerial that the first pass,
//      looking at the whole frame, could not resolve.
//   3. Blob cleanup at a bounded working resolution.
//   4. The edge curve, applied at full resolution rather than at 320, so the
//      rim is drawn from the real pixels instead of from an upscaled stair.

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

// The mask is assembled and cleaned at this resolution on its longer side.
// Blob work is linear in pixels, so this keeps a 24-megapixel photo costing the
// same as a small one, while staying well above the 320 the network emits.
const WORK_MAX = 512;

// The second pass is skipped once the product covers this much of the frame:
// there is no zoom left to gain, and the pass would cost a second for nothing.
const REFINE_COVER_MAX = 0.62;

// How far the crop is grown past the product before the second pass, as a
// fraction of the longer side. Enough that the rim is never against the edge of
// what the network is shown.
const REFINE_PAD = 0.08;

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
function normalise(raw, from, count) {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < count; i += 1) {
    const v = raw[from + i];
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  const span = hi - lo || 1;
  const mask = new Float32Array(count);
  for (let i = 0; i < count; i += 1) mask[i] = (raw[from + i] - lo) / span;
  return mask;
}

/**
 * Run the network over one rectangle of the source.
 *
 * The rectangle is squashed to fill the square rather than letterboxed into it.
 * Preserving the aspect ratio reads as the more careful choice and it is not:
 * the network is trained on squashed input, and letterboxing a wide frame hands
 * it a third fewer pixels of product to look at. Measured on a wide product
 * shot, letterboxing lost a corner of a sheet of paper that squashing kept.
 */
async function inferRect(source, rect) {
  const square = new OffscreenCanvas(SIDE, SIDE);
  const ctx = square.getContext('2d', { willReadFrequently: true });
  // A PNG that already carries transparency would otherwise reach the network
  // as black, which reads as a second object sitting behind the product. White
  // is what a product shot's backdrop nearly always is, and for the fully
  // opaque images that are the common case this costs nothing.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, SIDE, SIDE);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, rect.x, rect.y, rect.w, rect.h, 0, 0, SIDE, SIDE);

  const active = await session();
  const output = await active.run({ [active.inputNames[0]]: toTensor(ctx.getImageData(0, 0, SIDE, SIDE).data) });

  // U^2-Net emits seven side outputs; the first is the fused prediction and
  // the only one worth reading.
  const raw = output[active.outputNames[0]].data;
  return { mask: normalise(raw, 0, AREA), w: SIDE, h: SIDE };
}

/** Draw a small float mask onto a canvas so the GPU can resample it. */
function maskToCanvas(mask, w, h) {
  const image = new ImageData(w, h);
  for (let i = 0; i < mask.length; i += 1) {
    const v = Math.round(Math.max(0, Math.min(1, mask[i])) * 255);
    const o = i * 4;
    image.data[o] = v;
    image.data[o + 1] = v;
    image.data[o + 2] = v;
    image.data[o + 3] = 255;
  }
  const canvas = new OffscreenCanvas(w, h);
  canvas.getContext('2d').putImageData(image, 0, 0);
  return canvas;
}

/** Resample a mask canvas into a float array of the given size. */
function canvasToMask(canvas, w, h, sw, sh) {
  const to = new OffscreenCanvas(w, h);
  const ctx = to.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(canvas, 0, 0, sw, sh, 0, 0, w, h);

  const px = ctx.getImageData(0, 0, w, h).data;
  const mask = new Float32Array(w * h);
  for (let i = 0, o = 0; i < mask.length; i += 1, o += 4) mask[i] = px[o] / 255;
  return mask;
}

/** The box the product sits in, in source pixels, or null if nothing is lit. */
function maskBounds(mask, w, h, threshold) {
  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0, i = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1, i += 1) {
      if (mask[i] < threshold) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return null;
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

/**
 * Drop the specks, keep the product.
 *
 * Whatever the network lights up away from the product - a stray highlight, a
 * speck of noise - is not worth keeping, and cutting it leaves a cleaner
 * result. But a product shot is often more than one piece, so this keeps every
 * blob within KEEP_RATIO of the largest rather than the largest alone. The
 * survivors are grown by a few pixels before they mask the rest, so their own
 * soft rims live through it.
 *
 * Flood fill is iterative on purpose: recursion blows the stack on a subject
 * that fills the frame.
 */
function keepMainBlobs(mask, w, h) {
  const count = w * h;
  const solid = new Uint8Array(count);
  for (let i = 0; i < count; i += 1) solid[i] = mask[i] >= 0.5 ? 1 : 0;

  const label = new Int32Array(count).fill(-1);
  const stack = new Int32Array(count);
  const sizes = [];

  for (let start = 0; start < count; start += 1) {
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
      const x = p % w;
      const y = (p / w) | 0;
      if (x > 0 && solid[p - 1] && label[p - 1] === -1) { label[p - 1] = id; stack[top] = p - 1; top += 1; }
      if (x < w - 1 && solid[p + 1] && label[p + 1] === -1) { label[p + 1] = id; stack[top] = p + 1; top += 1; }
      if (y > 0 && solid[p - w] && label[p - w] === -1) { label[p - w] = id; stack[top] = p - w; top += 1; }
      if (y < h - 1 && solid[p + w] && label[p + w] === -1) { label[p + w] = id; stack[top] = p + w; top += 1; }
    }
    sizes.push(size);
  }

  // Nothing crossed the threshold - an empty or featureless frame. Leave the
  // mask alone rather than handing back a blank one.
  if (!sizes.length) return mask;

  let biggest = 0;
  for (let i = 0; i < sizes.length; i += 1) if (sizes[i] > biggest) biggest = sizes[i];
  const floor = biggest * KEEP_RATIO;

  const keep = new Uint8Array(count);
  for (let i = 0; i < count; i += 1) {
    if (label[i] !== -1 && sizes[label[i]] >= floor) keep[i] = 1;
  }

  let grown = keep;
  for (let pass = 0; pass < KEEP_DILATE; pass += 1) {
    const next = grown.slice();
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        const p = y * w + x;
        if (grown[p]) continue;
        if ((x > 0 && grown[p - 1]) || (x < w - 1 && grown[p + 1]) ||
            (y > 0 && grown[p - w]) || (y < h - 1 && grown[p + w])) next[p] = 1;
      }
    }
    grown = next;
  }

  const out = new Float32Array(count);
  for (let i = 0; i < count; i += 1) out[i] = grown[i] ? mask[i] : 0;
  return out;
}

/** Pull the midtones apart so the rim is crisp without being sawn out. */
function applyEdgeCurve(alpha) {
  const span = EDGE_HI - EDGE_LO;
  for (let i = 0; i < alpha.length; i += 1) {
    let v = (alpha[i] / 255 - EDGE_LO) / span;
    v = v <= 0 ? 0 : v >= 1 ? 1 : v * v * (3 - 2 * v); // smoothstep
    alpha[i] = Math.round(v * 255);
  }
}

self.onmessage = async (event) => {
  const { id, type, width, height, buffer } = event.data;

  try {
    if (type === 'warmup') {
      await session();
      self.postMessage({ id, ready: true });
      return;
    }

    const rgba = new Uint8ClampedArray(buffer);
    const source = new OffscreenCanvas(width, height);
    source.getContext('2d').putImageData(new ImageData(rgba, width, height), 0, 0);

    // Pass one: the whole frame, to find the product.
    const first = await inferRect(source, { x: 0, y: 0, w: width, h: height });

    // The working resolution the mask is assembled and cleaned at.
    const workScale = Math.min(1, WORK_MAX / Math.max(width, height));
    const ww = Math.max(1, Math.round(width * workScale));
    const wh = Math.max(1, Math.round(height * workScale));

    let work = canvasToMask(maskToCanvas(first.mask, first.w, first.h), ww, wh, first.w, first.h);

    // Pass two: the product alone, when it does not already fill the frame.
    const bounds = maskBounds(work, ww, wh, 0.5);
    if (bounds) {
      const cover = (bounds.w * bounds.h) / (ww * wh);
      if (cover < REFINE_COVER_MAX) {
        const pad = Math.round(Math.max(width, height) * REFINE_PAD);
        const rect = {
          x: Math.max(0, Math.round(bounds.x / workScale) - pad),
          y: Math.max(0, Math.round(bounds.y / workScale) - pad),
          w: 0,
          h: 0,
        };
        rect.w = Math.min(width - rect.x, Math.round(bounds.w / workScale) + pad * 2);
        rect.h = Math.min(height - rect.y, Math.round(bounds.h / workScale) + pad * 2);

        if (rect.w > 8 && rect.h > 8) {
          const second = await inferRect(source, rect);
          const patch = maskToCanvas(second.mask, second.w, second.h);

          // Combined by taking whichever pass is more certain, not by letting
          // the second overwrite the first.
          //
          // The second pass exists to resolve what the first was too coarse to
          // see - an aerial, the lip of a sheet of paper. It is not a better
          // judge of what the product is, only of where its edge runs, and
          // letting it overwrite lets one uncertain corner punch a hole in
          // something the first pass had right.
          const canvas = new OffscreenCanvas(ww, wh);
          const ctx = canvas.getContext('2d', { willReadFrequently: true });
          ctx.fillStyle = '#000000';
          ctx.fillRect(0, 0, ww, wh);
          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = 'high';
          ctx.drawImage(patch, 0, 0, second.w, second.h,
            rect.x * workScale, rect.y * workScale, rect.w * workScale, rect.h * workScale);

          const px = ctx.getImageData(0, 0, ww, wh).data;
          for (let i = 0, o = 0; i < work.length; i += 1, o += 4) {
            const refined = px[o] / 255;
            if (refined > work[i]) work[i] = refined;
          }
        }
      }
    }

    work = keepMainBlobs(work, ww, wh);

    // Up to full resolution while still soft, so the edge curve acts on the
    // real pixels rather than on a stair that was already hardened at 320 and
    // then stretched - which is what used to make a hard edge look sawn out.
    const bigCanvas = maskToCanvas(work, ww, wh);
    const big = canvasToMask(bigCanvas, width, height, ww, wh);

    const alpha = new Uint8ClampedArray(width * height);
    for (let i = 0; i < alpha.length; i += 1) alpha[i] = Math.round(big[i] * 255);

    applyEdgeCurve(alpha);

    self.postMessage({ id, width, height, alpha: alpha.buffer }, [alpha.buffer]);
  } catch (error) {
    self.postMessage({ id, error: error?.message || 'Background removal failed' });
  }
};
