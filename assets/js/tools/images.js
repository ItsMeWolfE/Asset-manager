// Images - one tool for both things we do to a product photo before it goes on
// the site.
//
// **Optimise** takes a batch, trims the empty margin off each one and writes it
// out as WebP or PNG. **Place** takes the same images and puts them, by hand,
// inside a canvas of a fixed size.
//
// They were two tools until v4, and between them they had two dropzones, two
// paste handlers, two ZIP writers and two naming rules - and only one of them
// let you choose the file format, which is why the other one was still writing
// lossless WebP long after that was found to double the size of a supplier
// JPEG. All of that is shared here, and the mode switch decides which of the
// two panels is on screen.

import { h, icon, clear } from '../core/dom.js';
import { t, tf, plural } from '../core/i18n.js';
import { loadStored, saveStored } from '../core/prefs.js';
import { createStatus, createLog, createDropzone, pageHead, toast } from '../core/ui.js';
import {
  processImage, encodeCanvas, uniqueName, mapLimit, FORMATS, isFormatSupported,
} from '../core/image.js';
import { isSegmentationSupported, warmUpSegmentation } from '../core/segment.js';
import { StoreZip, saveBlob, safeName } from '../core/files.js';

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const isMode = (v) => v === 'optimise' || v === 'place';
const isFormat = (v) => v === 'webp' || v === 'png';
const isPackaging = (v) => v === 'zip' || v === 'single';
const isTrim = (v) => v === 'off' || v === 'tight' || v === 'square';
const isBackground = (v) => v === 'keep' || v === 'remove';
const isApply = (value) => value === 'all' || value === 'one';
const isPresetId = (value) => typeof value === 'string' && value.length > 0;
const isColour = (value) => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);

// Every choice the switches on this page make, as it is before anybody has
// saved anything: Optimise, WebP, one ZIP, a tight trim, the background kept.
// This is what Reset default goes back to.
const FACTORY = Object.freeze({
  mode: 'optimise',
  format: 'webp',
  packaging: 'zip',
  trim: 'tight',
  background: 'keep',
  applyTo: 'all',
  presetId: 'top-product',
  transparent: true,
  colour: '#ffffff',
});

const VALID = {
  mode: isMode,
  format: isFormat,
  packaging: isPackaging,
  trim: isTrim,
  background: isBackground,
  applyTo: isApply,
  presetId: isPresetId,
  transparent: (value) => typeof value === 'boolean',
  colour: isColour,
};

// The switches do not remember themselves. Changing one changes what is on
// screen for as long as the tab is open; Save as default writes the whole set
// here in one go, and that set is what the page opens with next time. Until
// 4.0.1 every switch saved itself the moment it was clicked, so whatever was
// tried last quietly became the next day's starting point.
const DEFAULTS_KEY = 'asset-manager-images-defaults-v1';
const PRESET_KEY = 'asset-manager-resizer-presets-v1';
const LEGACY_PRESET_KEYS = ['bam-resizer-presets-v3', 'devtools-resizer-presets-v2'];

/** Keep each field that is valid, and take the factory value for any that is not. */
function sanitizeConfig(value) {
  const source = value && typeof value === 'object' ? value : {};
  return Object.fromEntries(Object.entries(FACTORY).map(([key, fallback]) =>
    [key, VALID[key](source[key]) ? source[key] : fallback]));
}

const sameConfig = (a, b) => Object.keys(FACTORY).every((key) => a[key] === b[key]);

const loadDefaults = () => sanitizeConfig(loadStored(DEFAULTS_KEY, (v) => Boolean(v) && typeof v === 'object', null));

const isPresetList = (value) => Array.isArray(value) && value.every((preset) =>
  preset && typeof preset === 'object' &&
  typeof preset.id === 'string' && typeof preset.name === 'string' &&
  Number.isInteger(preset.w) && Number.isInteger(preset.h) &&
  preset.w > 0 && preset.h > 0);

const BUILT_IN = [
  { id: 'top-product', name: 'Top Product', w: 264, h: 248 },
  { id: 'square-sm', name: 'Square Small', w: 100, h: 100 },
  { id: 'square-lg', name: 'Square Large', w: 500, h: 500 },
  { id: 'hd', name: 'HD 1080p', w: 1920, h: 1080 },
  { id: 'insta-story', name: 'Story', w: 1080, h: 1920 },
];

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// What every run encodes at, in both modes. 92 is visually indistinguishable
// from lossless on product photography while being a fraction of the size - a
// lossless WebP of an already-lossy JPEG comes out roughly twice as big as the
// JPEG, because it has to preserve the JPEG's own compression noise exactly.
//
// It reaches WebP only. PNG has no lossy mode, so a PNG is lossless whatever is
// passed, and either format keeps its alpha channel intact.
const QUALITY = 0.92;

// A batch can afford two decoders in flight. Individual downloads are kept
// sequential because browsers throttle rapid successive downloads.
const ZIP_CONCURRENCY = 2;

const SNAP_PX = 10;
const MIN_SCALE = 0.1;
const MAX_SCALE = 5;
const PREVIEW_MAX = 680;

/** Both shapes the stash can hand back: v4's, and the resizer's from 3.x. */
function carriedItems(carried) {
  const list = Array.isArray(carried?.items) ? carried.items
    : (carried?.image ? [carried] : []);
  return list
    .filter((entry) => entry?.image)
    .map((entry) => ({
      image: entry.image,
      baseName: entry.baseName ?? 'image',
      objectUrl: entry.objectUrl ?? null,
      scale: entry.scale ?? 1,
      position: entry.position ? { ...entry.position } : { x: 0, y: 0 },
    }));
}

export function createImages(carried = null) {
  // A browser with no WebP canvas encoder, or without the module workers and
  // OffscreenCanvas the background model needs, cannot honour a default that
  // asks for them, so it is not pretended it can.
  const canWebp = isFormatSupported('webp');
  const canCutOut = isSegmentationSupported();
  const possible = (config) => ({
    ...config,
    format: canWebp ? config.format : 'png',
    background: canCutOut ? config.background : 'keep',
  });

  let saved = loadDefaults();

  // A tool switch, a language change or an update hands back what was on
  // screen, saved or not. A 3.x address can ask for a mode on top of that.
  const start = possible(sanitizeConfig(carried?.config ?? saved));
  if (isMode(carried?.mode)) start.mode = carried.mode;

  let mode = start.mode;
  let format = start.format;
  let packaging = start.packaging;
  let trim = start.trim;
  let background = start.background;

  const status = createStatus();
  const log = createLog();

  // Which panel the shared dropzone is feeding, and whether anything is running
  // in either of them.
  let busy = false;

  const ext = () => FORMATS[format].ext;
  const mime = () => FORMATS[format].mime;

  // -------------------------------------------------------------------------
  // Shared controls
  // -------------------------------------------------------------------------

  const groups = [];

  const saveDefaultButton = h('button', {
    type: 'button',
    class: 'btn btn--ghost btn--sm',
    title: t('Open with these settings every time, in this browser.'),
    onClick: () => {
      saved = snapshot();
      saveStored(DEFAULTS_KEY, saved);
      syncControls();
      toast(t('Saved as the default.'));
    },
  }, icon('check', 14), t('Save as default'));

  const resetDefaultButton = h('button', {
    type: 'button',
    class: 'btn btn--ghost btn--sm',
    title: t('Back to Optimise, WebP, one ZIP, a tight trim and the background kept.'),
    onClick: () => {
      saved = { ...FACTORY };
      try { localStorage.removeItem(DEFAULTS_KEY); } catch { /* private mode */ }
      applyConfig(FACTORY);
      toast(t('Default reset.'));
    },
  }, icon('refresh', 14), t('Reset default'));

  /**
   * Each button only lights up when pressing it would change something:
   * Save while the screen differs from the saved default, Reset while either
   * of them differs from the original.
   */
  function syncDefaultButtons() {
    const now = snapshot();
    saveDefaultButton.disabled = busy || sameConfig(now, possible(saved));
    resetDefaultButton.disabled = busy ||
      (sameConfig(now, possible(FACTORY)) && sameConfig(saved, FACTORY));
  }

  /**
   * One segmented control. `read` is called rather than captured because the
   * value it reflects lives in a variable these buttons themselves reassign.
   */
  function segmented(label, read, write, entries, { disabled } = {}) {
    const buttons = new Map();
    const group = h('div', { class: 'segmented', role: 'group', 'aria-label': label });

    for (const [value, text, iconName] of entries) {
      const button = h('button', {
        type: 'button',
        'aria-pressed': String(read() === value),
        onClick: () => { write(value); syncControls(); },
      }, iconName ? icon(iconName, 14) : null, t(text));
      buttons.set(value, button);
      group.append(button);
    }

    groups.push({ read, buttons, disabled });
    return group;
  }

  /**
   * The single place that decides which controls are live, so a run finishing
   * cannot re-enable something the browser or the current settings rule out.
   */
  function syncControls() {
    for (const { read, buttons, disabled } of groups) {
      const value = read();
      for (const [key, button] of buttons) {
        button.setAttribute('aria-pressed', String(value === key));
        button.disabled = busy || Boolean(disabled?.(key));
      }
    }
    syncDefaultButtons();
  }

  const formatSwitch = segmented(t('File format'), () => format, (value) => {
    format = value;
  }, [
    ['webp', 'Product images (WebP)', 'image'],
    ['png', 'Page images (PNG)', 'fileText'],
  ], { disabled: (value) => value === 'webp' && !canWebp });

  const packagingSwitch = segmented(t('Download'), () => packaging, (value) => {
    packaging = value;
  }, [
    ['zip', 'One ZIP', 'archive'],
    ['single', 'Separate files', 'download'],
  ]);

  const modeSwitch = segmented(t('What to do'), () => mode, (value) => {
    mode = value;
    syncMode();
  }, [
    ['optimise', 'Optimise', 'crop'],
    ['place', 'Place', 'resize'],
  ]);

  // -------------------------------------------------------------------------
  // Shared input
  // -------------------------------------------------------------------------

  const dropzone = createDropzone({
    iconName: 'image',
    title: t('Choose or drop product images'),
    hint: '',
    buttonLabel: t('Select images'),
    accept: 'image/*',
    multiple: true,
    onFiles: (files) => receive(files),
  });

  function receive(files) {
    const images = files.filter((file) => file.type?.startsWith('image/'));
    if (!images.length || busy) return;
    if (mode === 'optimise') runOptimise(images);
    else loadForPlacement(images);
  }

  /**
   * Bound to the document, not to the panel: a paste with nothing focused
   * targets <body>, which never bubbles through the tool container. One handler
   * for both modes, where there used to be an identical one in each.
   */
  function onPaste(event) {
    if (busy || !event.clipboardData) return;
    if (event.target.closest('input, textarea, [contenteditable="true"]')) return;

    const files = [];
    Array.from(event.clipboardData.items).forEach((item, index) => {
      if (!item.type.startsWith('image/')) return;
      const file = item.getAsFile();
      if (file) {
        files.push(new File([file], `pasted_${Date.now()}_${index}.png`, { type: file.type || 'image/png' }));
      }
    });

    if (files.length) {
      event.preventDefault();
      receive(files);
    }
  }

  function setBusy(value) {
    busy = value;
    syncControls();
    dropzone.setBusy(value);
    clearButton.disabled = value;
    setPlaceBusy(value);
  }

  // =========================================================================
  // Optimise
  // =========================================================================

  let runToken = 0;

  const trimSwitch = segmented(t('Trim'), () => trim, (value) => {
    trim = value;
  }, [
    ['off', 'Off', 'image'],
    ['tight', 'Tight', 'crop'],
    ['square', 'Square (1:1)', 'layers'],
  ]);

  const backgroundSwitch = segmented(t('Background'), () => background, (value) => {
    background = value;
  }, [
    ['keep', 'Keep', 'image'],
    ['remove', 'Cut out', 'wand'],
  ], { disabled: (value) => value === 'remove' && !canCutOut });

  const clearButton = h('button', {
    type: 'button',
    class: 'btn btn--ghost btn--sm',
    onClick: () => {
      if (busy) return;
      status.reset();
      log.clear();
    },
  }, t('Clear completed state'));

  async function runOptimise(images) {
    const token = ++runToken;
    setBusy(true);
    log.clear();

    status.set({
      phase: 'processing',
      title: `${t('Preparing')} ${plural(images.length, 'image', 'images')}`,
      summary: t('The upload area stays available after this run completes.'),
      progress: 0,
    });

    // Every setting is read once here, so changing a control mid-run cannot
    // leave half the batch cropped and the other half not.
    const crop = trim !== 'off';
    const square = trim === 'square';
    const outMime = mime();
    const outExt = ext();
    const cutOut = background === 'remove';

    log.add(tf('Started a run with {count} images, output {format}, trim {trim}.', {
      count: images.length,
      format: outExt.toUpperCase(),
      trim: t(trim === 'off' ? 'Off' : (square ? 'Square (1:1)' : 'Tight')),
    }));

    const taken = new Set();
    const ready = [];
    let done = 0;
    let skipped = 0;

    try {
      if (cutOut) {
        status.set({
          title: t('Loading the background model'),
          summary: t('About 16 MB the first time. It is cached afterwards, and it runs on this computer - the images are never uploaded.'),
        });
        await warmUpSegmentation();
        if (runToken !== token) return;
        log.add(t('Background model ready.'));
      }

      // One at a time when cutting out: the model runs single-threaded on the
      // CPU, so a second job in flight only competes for the same core.
      const concurrency = cutOut ? 1 : ZIP_CONCURRENCY;

      await mapLimit(images, concurrency, async (file, index) => {
        if (runToken !== token) return;

        const verb = cutOut ? t('Removing background') : (crop ? t('Cropping') : t('Converting'));
        status.set({ title: `${verb} ${index + 1}/${images.length}: ${file.name}` });

        try {
          const blob = await processImage(file, {
            crop, square, removeBackground: cutOut, mime: outMime, quality: QUALITY,
          });
          if (!blob) {
            skipped += 1;
            log.error(`${t('Skipped empty image')}: ${file.name}`);
          } else {
            const name = uniqueName(file.name, taken, outExt);
            ready.push({ name, blob });
            log.add(`${t('Prepared')}: ${name}`);
          }
        } catch (error) {
          skipped += 1;
          log.error(`${file.name}: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
          done += 1;
          status.set({ progress: Math.round((done / images.length) * 90) });
        }
      });

      if (runToken !== token) return;

      if (!ready.length) {
        status.set({
          phase: 'error',
          title: t('No output generated'),
          summary: t('Every image failed to process, or was empty and cropped away to nothing. See the event log below.'),
          progress: 0,
        });
        return;
      }

      if (ready.length > 1 && packaging === 'zip') {
        status.set({ title: t('Building ZIP archive'), progress: 95 });
      }
      await packAndDeliver(ready, crop ? 'tight_cropped.zip' : 'converted_images.zip');

      status.set({
        phase: 'success',
        title: t('Processing complete'),
        summary: `${plural(ready.length, 'file', 'files')} ${t('prepared')}${skipped ? `; ${skipped} ${t('skipped')}` : ''}.`,
        progress: 100,
      });
    } catch (error) {
      log.error(error instanceof Error ? error.message : String(error));
      status.set({
        phase: 'error',
        title: t('Processing failed'),
        summary: t('The completed state stays visible until you start another run or clear it.'),
      });
    } finally {
      if (runToken === token) setBusy(false);
    }
  }

  /** StoreZip takes blobs one at a time, so the ZIP is built here. */
  async function packAndDeliver(entries, zipFilename) {
    if (entries.length === 1) {
      saveBlob(entries[0].blob, entries[0].name);
      log.success(`${t('Download started')}: ${entries[0].name}`);
      return;
    }
    if (packaging === 'single') {
      for (const entry of entries) saveBlob(entry.blob, entry.name);
      log.success(t('All individual downloads were started.'));
      return;
    }
    const zip = new StoreZip();
    for (const entry of entries) await zip.addBlob(entry.name, entry.blob);
    saveBlob(zip.build(), zipFilename);
    log.success(t('ZIP download started.'));
  }

  const optimisePanel = h('section', { class: 'panel' },
    h('div', { class: 'panel__head' },
      h('div', null,
        h('h2', { class: 'panel__title' }, t('Trim')),
        h('p', { class: 'panel__hint' }, t('Tight cuts the empty margin away. Square centres the product in a 1:1 box and fills the overhang with the detected background. Off leaves every pixel alone and only changes the file format.'))),
      trimSwitch),

    h('div', { class: 'panel__head' },
      h('div', null,
        h('h2', { class: 'panel__title' }, t('Background')),
        h('p', { class: 'panel__hint' }, canCutOut
          ? t('Cut out leaves everything behind the product transparent, using a model that runs on this computer. Nothing is uploaded. The first run downloads about 16 MB.')
          : t('This browser cannot run the background model: it needs module workers and OffscreenCanvas.'))),
      backgroundSwitch),
  );

  // =========================================================================
  // Place
  // =========================================================================

  let presets = LEGACY_PRESET_KEYS.reduce(
    (fallback, key) => loadStored(key, isPresetList, fallback),
    BUILT_IN,
  );
  presets = loadStored(PRESET_KEY, isPresetList, presets);
  // A default can name a preset that has since been deleted or reset away, so
  // it is honoured only while it still exists.
  const opening = presets.find((preset) => preset.id === start.presetId) ?? presets[0];
  let presetId = opening?.id ?? 'top-product';
  let size = { w: opening?.w ?? 264, h: opening?.h ?? 248 };

  // Every loaded image, in the order it was chosen. Each item carries its own
  // scale and position; the canvas size and the background are shared.
  let items = carriedItems(carried);
  let index = Math.min(Math.max(Number(carried?.index) || 0, 0), Math.max(items.length - 1, 0));
  const current = () => items[index] ?? null;

  let applyTo = start.applyTo;
  /** The images an adjustment touches: all of them, or just the one on screen. */
  const targets = () => (applyTo === 'all' ? items : (current() ? [current()] : []));

  let transparent = start.transparent;
  let canvasColour = start.colour;

  // Set once the items have been handed to main.js's stash, which holds them
  // for whenever this tool is mounted again. Revoking their object URLs in
  // destroy would break the images the next instance restores.
  let handedOver = false;
  // Bumped by every load and by Start over, so a decode that finishes after
  // the set it belongs to has been replaced is dropped instead of appended.
  let loadToken = 0;

  const canvas = h('canvas', { width: size.w, height: size.h });
  const guideV = h('div', { class: 'guide guide--v' });
  const guideH = h('div', { class: 'guide guide--h' });
  guideV.hidden = true;
  guideH.hidden = true;

  const canvasWrap = h('div', { class: 'canvas-wrap' }, canvas, guideV, guideH);
  const errorLine = h('p', { class: 'error-text' });

  /** Paint one item, or just the background when there is none. */
  function paint(ctx, item, target) {
    ctx.clearRect(0, 0, target.w, target.h);
    if (!transparent) {
      ctx.fillStyle = canvasColour;
      ctx.fillRect(0, 0, target.w, target.h);
    }
    if (!item?.image) return;

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(
      item.image,
      item.position.x, item.position.y,
      item.image.width * item.scale, item.image.height * item.scale,
    );
  }

  function render() {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    paint(ctx, current(), size);
  }

  function syncCanvasBox() {
    canvas.width = size.w;
    canvas.height = size.h;
    canvasWrap.style.width = `min(100%, ${Math.min(PREVIEW_MAX, size.w)}px)`;
    canvasWrap.style.aspectRatio = String(size.w / size.h);
    render();
  }

  function syncScaleControls() {
    const item = current();
    const percent = Math.round((item?.scale ?? 1) * 100);
    scaleInput.value = String(percent);
    scaleLabel.textContent = `${percent}%`;
  }

  /** Fit shows the whole image; fill covers the canvas. */
  function frame(framing, item = current(), targetSize = size) {
    if (!item?.image) return;

    const source = item.image;
    const sw = source.naturalWidth || source.width;
    const sh = source.naturalHeight || source.height;
    if (!sw || !sh) return;

    const ratio = framing === 'cover'
      ? Math.max(targetSize.w / sw, targetSize.h / sh)
      : Math.min(targetSize.w / sw, targetSize.h / sh);

    item.scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, ratio));
    item.position = {
      x: (targetSize.w - sw * item.scale) / 2,
      y: (targetSize.h - sh * item.scale) / 2,
    };
    if (item === current()) {
      syncScaleControls();
      render();
    }
  }

  /** Fit or fill every loaded image. Used when the canvas itself changes. */
  function frameAll(framing) {
    for (const item of items) frame(framing, item);
    syncScaleControls();
    render();
  }

  /** What the Fit and Fill buttons do: whichever images are being adjusted. */
  function frameTargets(framing) {
    for (const item of targets()) frame(framing, item);
    syncScaleControls();
    render();
  }

  /** Keep the canvas centre fixed while the scale changes. */
  function rescale(next) {
    const clamped = Math.max(MIN_SCALE, Math.min(MAX_SCALE, next));
    scaleLabel.textContent = `${Math.round(clamped * 100)}%`;

    for (const item of targets()) {
      if (!Number.isFinite(item.scale) || item.scale <= 0) {
        item.scale = clamped;
        continue;
      }
      const cx = size.w / 2;
      const cy = size.h / 2;
      item.position = {
        x: cx - (cx - item.position.x) * (clamped / item.scale),
        y: cy - (cy - item.position.y) * (clamped / item.scale),
      };
      item.scale = clamped;
    }
    render();
  }

  function releaseItems() {
    for (const item of items) {
      if (item.objectUrl) URL.revokeObjectURL(item.objectUrl);
    }
  }

  /** Decode one file, or resolve null when it cannot be read as an image. */
  function decodeFile(file) {
    return new Promise((resolve) => {
      const objectUrl = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => resolve({
        image: img,
        baseName: file.name.replace(/\.[^/.]+$/, '') || 'image',
        objectUrl,
        scale: 1,
        position: { x: 0, y: 0 },
      });
      img.onerror = () => {
        URL.revokeObjectURL(objectUrl);
        resolve(null);
      };
      img.src = objectUrl;
    });
  }

  /**
   * Load a selection for placement. A new selection replaces the previous one,
   * exactly as a second image replaced the first before batches existed.
   */
  async function loadForPlacement(files) {
    errorLine.textContent = '';
    const token = ++loadToken;
    setBusy(true);

    // Large photos take a noticeable while to decode, and until they do there
    // is nothing on screen, so the count is shown as they arrive.
    let ready = 0;
    status.set({
      phase: 'processing',
      title: `${t('Loading')} ${plural(files.length, 'image', 'images')}`,
      summary: '',
      progress: 0,
    });

    let decoded;
    try {
      decoded = await Promise.all(files.map(async (file) => {
        const item = await decodeFile(file);
        ready += 1;
        if (loadToken === token) {
          status.set({
            title: `${t('Loading')} ${ready}/${files.length}`,
            progress: Math.round((ready / files.length) * 100),
          });
        }
        return item;
      }));
    } finally {
      if (loadToken === token) {
        setBusy(false);
        status.reset();
      }
    }

    // Start over, or another selection, landed while this one was decoding.
    if (loadToken !== token) {
      for (const item of decoded) {
        if (item?.objectUrl) URL.revokeObjectURL(item.objectUrl);
      }
      return;
    }

    releaseItems();
    items = decoded.filter(Boolean);
    index = 0;

    const failed = files.length - items.length;
    if (failed && files.length === 1) errorLine.textContent = t('The image could not be decoded.');
    else if (failed) {
      errorLine.textContent = tf('{count} of {total} files could not be decoded.', {
        count: failed, total: files.length,
      });
    }

    frameAll('contain');
    renderStrip();
    syncMode();
    render();
  }

  // --- dragging ----------------------------------------------------------

  let dragging = false;
  let dragStart = { clientX: 0, clientY: 0 };
  // Where each image being dragged started, so the whole set moves by the same
  // offset instead of jumping to the position of the one under the pointer.
  let dragFrom = [];

  canvas.addEventListener('pointerdown', (event) => {
    const item = current();
    if (!item) return;
    dragging = true;
    canvas.setPointerCapture(event.pointerId);
    dragStart = { clientX: event.clientX, clientY: event.clientY };
    dragFrom = targets().map((entry) => ({ item: entry, x: entry.position.x, y: entry.position.y }));
  });

  canvas.addEventListener('pointermove', (event) => {
    const item = current();
    if (!dragging || !item) return;

    const rect = canvas.getBoundingClientRect();
    const scaleX = rect.width ? size.w / rect.width : 1;
    const scaleY = rect.height ? size.h / rect.height : 1;

    let dx = (event.clientX - dragStart.clientX) * scaleX;
    let dy = (event.clientY - dragStart.clientY) * scaleY;

    // Snapping follows the image on screen; the rest move with it.
    const start = dragFrom.find((entry) => entry.item === item);
    const centredX = (size.w - item.image.width * item.scale) / 2;
    const centredY = (size.h - item.image.height * item.scale) / 2;
    const snapX = start ? Math.abs(start.x + dx - centredX) < SNAP_PX : false;
    const snapY = start ? Math.abs(start.y + dy - centredY) < SNAP_PX : false;

    if (snapX) dx = centredX - start.x;
    if (snapY) dy = centredY - start.y;

    guideV.hidden = !snapX;
    guideH.hidden = !snapY;

    for (const entry of dragFrom) entry.item.position = { x: entry.x + dx, y: entry.y + dy };
    render();
  });

  function endDrag(event) {
    if (!dragging) return;
    dragging = false;
    guideV.hidden = true;
    guideH.hidden = true;
    if (event?.pointerId !== undefined && canvas.hasPointerCapture?.(event.pointerId)) {
      canvas.releasePointerCapture(event.pointerId);
    }
  }

  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);

  // --- the loaded set ----------------------------------------------------

  const strip = h('div', { class: 'thumbs', role: 'group', 'aria-label': t('Loaded images') });
  const countLabel = h('span', { class: 'mono muted' });
  const stripRow = h('div', { class: 'row row--between' },
    h('span', { class: 'field__label' }, t('Loaded images')), countLabel);

  const applyHint = h('p', { class: 'panel__hint' });

  function syncApplyHint() {
    applyHint.textContent = t(applyTo === 'all'
      ? 'Fit, Fill, the scale slider and dragging move every loaded image together.'
      : 'Fit, Fill, the scale slider and dragging move only the image on screen. Click a thumbnail to work on another one.');
  }

  const applySwitch = segmented(t('Adjustments'), () => applyTo, (value) => {
    applyTo = value;
    syncApplyHint();
  }, [['all', 'All images'], ['one', 'This image']]);

  const applyRow = h('div', { class: 'row row--between' },
    h('span', { class: 'field__label' }, t('Adjustments')), applySwitch);

  function select(next) {
    if (next < 0 || next >= items.length) return;
    index = next;
    syncScaleControls();
    syncStrip();
    render();
  }

  function syncStrip() {
    countLabel.textContent = items.length ? `${index + 1} / ${items.length}` : '';
    Array.from(strip.children).forEach((button, position) => {
      button.setAttribute('aria-pressed', String(position === index));
      button.dataset.current = position === index ? 'true' : '';
    });
    const active = strip.children[index];
    active?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }

  function renderStrip() {
    clear(strip);
    items.forEach((item, position) => {
      strip.append(h('button', {
        type: 'button',
        class: 'thumb',
        title: item.baseName,
        onClick: () => select(position),
      }, item.objectUrl
        ? h('img', { src: item.objectUrl, alt: item.baseName })
        : h('span', { class: 'thumb__name' }, item.baseName)));
    });
    syncStrip();
  }

  // --- canvas size -------------------------------------------------------

  const presetSelect = h('select', {
    class: 'select',
    onChange: () => selectPreset(presetSelect.value),
  });

  function renderPresets() {
    clear(presetSelect);
    for (const preset of presets) {
      presetSelect.append(h('option', { value: preset.id }, `${preset.name} — ${preset.w}×${preset.h}`));
    }
    presetSelect.value = presetId;
    deleteButton.disabled = presets.length <= 1;
  }

  function selectPreset(id) {
    const preset = presets.find((entry) => entry.id === id);
    if (!preset) return;
    presetId = id;
    // Already true when the picker itself changed; not when Reset default did.
    presetSelect.value = id;
    size = { w: preset.w, h: preset.h };
    widthInput.value = String(preset.w);
    heightInput.value = String(preset.h);
    syncCanvasBox();
    frameAll('contain');
    syncDefaultButtons();
  }

  const widthInput = h('input', { class: 'input', type: 'number', min: '1', value: String(size.w), 'aria-label': t('Width') });
  const heightInput = h('input', { class: 'input', type: 'number', min: '1', value: String(size.h), 'aria-label': t('Height') });
  const nameInput = h('input', { class: 'input', type: 'text', placeholder: t('Preset name'), 'aria-label': t('Preset name') });

  const applySizeButton = h('button', {
    type: 'button', class: 'btn btn--ghost',
    onClick: () => {
      const w = Math.round(Number(widthInput.value));
      const hgt = Math.round(Number(heightInput.value));
      if (!(w >= 1 && hgt >= 1)) return;
      size = { w, h: hgt };
      syncCanvasBox();
      frameAll('contain');
    },
  }, t('Apply size'));

  const saveButton = h('button', {
    type: 'button', class: 'btn btn--ghost',
    onClick: () => {
      const name = nameInput.value.trim();
      const w = Math.round(Number(widthInput.value));
      const hgt = Math.round(Number(heightInput.value));
      if (!name || !(w >= 1) || !(hgt >= 1)) return;

      const preset = { id: `custom-${Date.now()}`, name, w, h: hgt };
      presets = [...presets, preset];
      saveStored(PRESET_KEY, presets);
      presetId = preset.id;
      size = { w, h: hgt };
      nameInput.value = '';
      renderPresets();
      syncCanvasBox();
      frameAll('contain');
      toast(t('Preset saved.'));
    },
  }, t('Save as preset'));

  // 2.4.1 allowed the last preset to be deleted, which left the picker empty
  // with no way back. The button is disabled at one remaining preset instead.
  const deleteButton = h('button', {
    type: 'button', class: 'btn btn--danger',
    onClick: () => {
      if (presets.length <= 1) return;
      if (!window.confirm(t('Delete this preset? This cannot be undone.'))) return;

      presets = presets.filter((preset) => preset.id !== presetId);
      saveStored(PRESET_KEY, presets);
      renderPresets();
      selectPreset(presets[0].id);
    },
  }, icon('trash', 14), t('Delete preset'));

  const resetPresetsButton = h('button', {
    type: 'button', class: 'btn btn--ghost btn--sm',
    onClick: () => {
      presets = BUILT_IN.slice();
      saveStored(PRESET_KEY, presets);
      renderPresets();
      selectPreset(presets[0].id);
      toast(t('Built-in presets restored.'));
    },
  }, t('Restore built-in presets'));

  const scaleInput = h('input', {
    class: 'range', type: 'range', min: String(MIN_SCALE * 100), max: String(MAX_SCALE * 100),
    step: '1', value: '100', 'aria-label': t('Scale'),
    onInput: () => rescale(Number(scaleInput.value) / 100),
  });
  const scaleLabel = h('span', { class: 'mono muted' }, '100%');

  const bgColorInput = h('input', {
    type: 'color', value: canvasColour, 'aria-label': t('Background colour'),
    onInput: () => {
      canvasColour = bgColorInput.value;
      transparent = false;
      syncControls();
      render();
    },
  });

  const canvasBgSwitch = segmented(t('Background'), () => (transparent ? 'transparent' : 'colour'), (value) => {
    transparent = value === 'transparent';
    render();
  }, [['transparent', 'Transparent'], ['colour', 'Colour']]);

  // --- export ------------------------------------------------------------

  function placedName(item, taken) {
    const base = `${safeName(item.baseName, 'image')}-${size.w}x${size.h}`;
    let name = `${base}.${ext()}`;
    let n = 2;
    while (taken.has(name)) {
      name = `${base}_${n}.${ext()}`;
      n += 1;
    }
    taken.add(name);
    return name;
  }

  /**
   * Encode every placed image at the shared format and quality, one at a time -
   * the canvas work is on the main thread either way - and hand the result over
   * the way the Download switch says.
   */
  async function exportPlaced() {
    if (busy || !items.length) return;

    setBusy(true);
    log.clear();
    status.set({
      phase: 'processing',
      title: `${t('Preparing')} ${plural(items.length, 'image', 'images')}`,
      summary: '',
      progress: 0,
    });

    const out = h('canvas', { width: size.w, height: size.h });
    const ctx = out.getContext('2d');
    const taken = new Set();
    const ready = [];
    const failures = [];

    try {
      if (!ctx) throw new Error(t('Canvas 2D context is unavailable'));

      for (const [position, item] of items.entries()) {
        status.set({
          title: `${t('Preparing')} ${position + 1}/${items.length}: ${item.baseName}`,
          progress: Math.round((position / items.length) * 90),
        });
        try {
          paint(ctx, item, size);
          const name = placedName(item, taken);
          ready.push({ name, blob: await encodeCanvas(out, mime(), QUALITY) });
          log.add(`${t('Prepared')}: ${name}`);
        } catch (error) {
          failures.push(`${item.baseName}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      if (!ready.length) {
        status.set({
          phase: 'error',
          title: t('No output generated'),
          summary: failures[0] ?? '',
          progress: 0,
        });
        return;
      }

      if (ready.length > 1 && packaging === 'zip') {
        status.set({ title: t('Building ZIP archive'), progress: 95 });
      }
      await packAndDeliver(ready, `resized-${size.w}x${size.h}.zip`);

      status.set({
        phase: 'success',
        title: t('Processing complete'),
        summary: `${plural(ready.length, 'file', 'files')} ${t('prepared')}${failures.length ? `; ${failures.length} ${t('skipped')}` : ''}.`,
        progress: 100,
      });
      if (failures.length) errorLine.textContent = failures.join(' · ');
    } catch (error) {
      status.set({
        phase: 'error',
        title: t('Processing failed'),
        summary: error instanceof Error ? error.message : String(error),
        progress: null,
      });
    } finally {
      out.width = 1;
      out.height = 1;
      setBusy(false);
    }
  }

  const downloadLabel = h('span', null, t('Download result'));
  const downloadButton = h('button', {
    type: 'button', class: 'btn',
    onClick: () => { exportPlaced(); },
  }, icon('download', 14), downloadLabel);

  const startOverButton = h('button', {
    type: 'button', class: 'btn btn--ghost',
    onClick: () => {
      if (busy) return;
      loadToken += 1;
      releaseItems();
      items = [];
      index = 0;
      errorLine.textContent = '';
      status.reset();
      renderStrip();
      syncMode();
      render();
    },
  }, t('Start over'));

  const fitButton = h('button', { type: 'button', onClick: () => frameTargets('contain') }, t('Fit'));
  const fillButton = h('button', { type: 'button', onClick: () => frameTargets('cover') }, t('Fill'));

  function setPlaceBusy(value) {
    downloadButton.disabled = value;
    startOverButton.disabled = value;
    fitButton.disabled = value;
    fillButton.disabled = value;
    scaleInput.disabled = value;
    bgColorInput.disabled = value;
    for (const input of [widthInput, heightInput, nameInput, presetSelect]) input.disabled = value;
    for (const button of [applySizeButton, saveButton, deleteButton, resetPresetsButton]) {
      button.disabled = value;
    }
    if (!value) deleteButton.disabled = presets.length <= 1;
  }

  const editor = h('div', { class: 'stack' },
    canvasWrap,
    h('div', { class: 'row row--between' },
      h('div', { class: 'segmented', role: 'group', 'aria-label': t('Placement') }, fitButton, fillButton),
      h('div', { class: 'row' }, startOverButton, downloadButton)),
    h('div', { class: 'field' }, applyRow, applyHint, stripRow, strip),
    h('div', { class: 'field' },
      h('div', { class: 'row row--between' },
        h('span', { class: 'field__label' }, t('Scale')), scaleLabel),
      scaleInput),
    h('div', { class: 'row' },
      h('span', { class: 'field__label' }, t('Background')),
      canvasBgSwitch,
      bgColorInput),
    errorLine,
  );

  const placePanel = h('section', { class: 'panel' },
    h('div', { class: 'panel__head' },
      h('div', null,
        h('h2', { class: 'panel__title' }, t('Canvas size')),
        h('p', { class: 'panel__hint' }, t('Presets are saved in this browser only.'))),
      resetPresetsButton),

    h('div', { class: 'row' },
      h('div', { class: 'field', style: { flex: '1 1 240px' } },
        h('label', { class: 'field__label' }, t('Preset')), presetSelect),
      h('div', { class: 'field', style: { width: '110px' } },
        h('label', { class: 'field__label' }, t('Width')), widthInput),
      h('div', { class: 'field', style: { width: '110px' } },
        h('label', { class: 'field__label' }, t('Height')), heightInput)),

    h('div', { class: 'row', style: { marginBlockStart: '12px' } },
      applySizeButton,
      h('div', { class: 'field', style: { flex: '1 1 200px' } }, nameInput),
      saveButton, deleteButton),

    editor,
  );

  // =========================================================================
  // Assembly
  // =========================================================================

  const DROP_HINT = {
    optimise: 'Drag images in, browse for them, or paste with Ctrl+V. The run starts as soon as they land. Originals on your disk are never modified.',
    place: 'Drag images in, browse for them, or paste with Ctrl+V. They open in the canvas below. Originals on your disk are never modified.',
  };

  const sharedPanel = h('section', { class: 'panel' },
    h('div', { class: 'panel__head' },
      h('div', null,
        h('h2', { class: 'panel__title' }, t('What to do')),
        h('p', { class: 'panel__hint' }, t('Optimise trims and converts a whole batch at once. Place puts each image by hand inside a canvas of a fixed size.'))),
      modeSwitch),

    h('div', { class: 'panel__head' },
      h('div', null,
        h('h2', { class: 'panel__title' }, t('File format')),
        h('p', { class: 'panel__hint' }, canWebp
          ? t('WebP is saved at quality 92, which looks the same and is a fraction of the size. PNG is lossless. Both keep transparency.')
          : t('This browser has no WebP encoder, so everything comes out as PNG.'))),
      formatSwitch),

    h('div', { class: 'panel__head' },
      h('div', null,
        h('h2', { class: 'panel__title' }, t('Download')),
        h('p', { class: 'panel__hint' }, t('How more than one file arrives. A single file always downloads on its own.'))),
      packagingSwitch),
  );

  const inputPanel = h('section', { class: 'panel' }, dropzone.el);

  const clearRow = h('div', { class: 'row' }, clearButton);

  /** Show the panel the current mode needs, and nothing else. */
  function syncMode() {
    const placing = mode === 'place';
    optimisePanel.hidden = placing;
    placePanel.hidden = !placing;

    // In Place the dropzone is the empty state: it steps aside once there is
    // something on the canvas, and Start over brings it back.
    const loaded = placing && items.length > 0;
    inputPanel.hidden = loaded;
    clearRow.hidden = placing;
    dropzone.setHint(t(DROP_HINT[mode]));
    dropzone.setTitle(t(placing ? 'Choose or drop images to place' : 'Choose or drop product images'));

    editor.hidden = !loaded;
    // A single image keeps the panel it has always had: no strip, and a
    // download button that names the one file it produces.
    const batch = items.length > 1;
    strip.hidden = !batch;
    stripRow.hidden = !batch;
    applyRow.hidden = !batch;
    applyHint.hidden = !batch;
    downloadLabel.textContent = batch ? t('Download all') : t('Download result');
  }

  /** Every choice on screen, in the shape a saved default takes. */
  function snapshot() {
    return {
      mode, format, packaging, trim, background, applyTo, presetId, transparent, colour: canvasColour,
    };
  }

  /** Put a whole configuration on screen at once: what Reset default does. */
  function applyConfig(next) {
    const config = possible(next);
    ({ mode, format, packaging, trim, background, applyTo, transparent } = config);
    canvasColour = config.colour;
    bgColorInput.value = canvasColour;
    syncApplyHint();
    // Changing the canvas size re-frames every loaded image, so it only
    // happens when the size really changes.
    if (config.presetId !== presetId && presets.some((preset) => preset.id === config.presetId)) {
      selectPreset(config.presetId);
    }
    syncControls();
    syncMode();
    render();
  }

  const head = pageHead('image', t('Images'),
    t('Trim and convert product photos in bulk, or place one inside a canvas of a fixed size.'));
  head.append(h('div', { class: 'page-head__actions' }, saveDefaultButton, resetDefaultButton));

  const root = h('div', { class: 'stack' },
    head,
    sharedPanel,
    optimisePanel,
    placePanel,
    inputPanel,
    status.el,
    clearRow,
    log.el,
  );

  document.addEventListener('paste', onPaste);

  renderPresets();
  // selectPreset re-frames every image, which would discard carried scales and
  // positions, so those are restored after it rather than before.
  const restore = items.map((item) => ({ scale: item.scale, position: { ...item.position } }));
  selectPreset(presetId);
  items.forEach((item, position) => {
    item.scale = restore[position].scale;
    item.position = { ...restore[position].position };
  });
  syncScaleControls();
  syncApplyHint();
  renderStrip();
  syncCanvasBox();
  syncControls();
  syncMode();

  return {
    el: root,
    getState() {
      handedOver = true;
      return { config: snapshot(), items, index };
    },
    // Unsaved choices survive the reload an update performs; the loaded images
    // cannot, as before.
    getPortableState() {
      return { config: snapshot() };
    },
    destroy() {
      runToken += 1;
      loadToken += 1;
      document.removeEventListener('paste', onPaste);
      if (!handedOver) releaseItems();
    },
  };
}
