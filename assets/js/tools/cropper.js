// Image Optimiser - converts product photos to WebP or PNG, in bulk, trimming
// the empty border off them on the way through unless cropping is turned off.

import { h, icon } from '../core/dom.js';
import { t, plural } from '../core/i18n.js';
import { loadStored, saveStored } from '../core/prefs.js';
import { createStatus, createLog, createDropzone, pageHead } from '../core/ui.js';
import { processImage, uniqueName, mapLimit, FORMATS, isFormatSupported } from '../core/image.js';
import { isSegmentationSupported, warmUpSegmentation } from '../core/segment.js';
import { StoreZip, saveBlob } from '../core/files.js';

const SHAPE_KEY = 'asset-manager-crop-shape-v1';
const LEGACY_SHAPE_KEY = 'bam-crop-shape-v1';
const BACKGROUND_KEY = 'asset-manager-crop-background-v1';
const MODE_KEY = 'asset-manager-crop-mode-v1';
const CROP_KEY = 'asset-manager-crop-enabled-v1';
const FORMAT_KEY = 'asset-manager-output-format-v1';
const isShape = (v) => v === 'square' || v === 'full';
const isBackground = (v) => v === 'keep' || v === 'remove';
const isMode = (v) => v === 'zip' || v === 'single';
const isCrop = (v) => v === 'on' || v === 'off';
const isFormat = (v) => v === 'webp' || v === 'png';
const zipName = (cropping) => (cropping ? 'tight_cropped.zip' : 'converted_images.zip');

// ZIP mode can afford two decoders in flight. Individual downloads are kept
// sequential because browsers throttle rapid successive downloads.
const ZIP_CONCURRENCY = 2;

// What every run encodes at. 92 is visually indistinguishable from lossless on
// product photography while being a fraction of the size - a lossless WebP of an
// already-lossy JPEG comes out roughly twice as big as the JPEG, because it has
// to preserve the JPEG's own compression noise exactly.
//
// It reaches WebP only. PNG has no lossy mode, so a PNG is lossless whatever is
// passed, and either format keeps its alpha channel intact.
const QUALITY = 0.92;

export function createCropper() {
  let phase = 'idle';
  let outputMode = loadStored(MODE_KEY, isMode, 'zip');
  let shape = loadStored(SHAPE_KEY, isShape, loadStored(LEGACY_SHAPE_KEY, isShape, 'full'));
  let cropping = loadStored(CROP_KEY, isCrop, 'on');
  // Same override as the background model below: a browser with no WebP canvas
  // encoder cannot honour the stored preference, so it is not pretended it can.
  const canWebp = isFormatSupported('webp');
  let format = canWebp ? loadStored(FORMAT_KEY, isFormat, 'webp') : 'png';
  // A browser without module workers or OffscreenCanvas cannot run the model at
  // all, so the stored preference is overridden rather than left to fail later.
  const canCutOut = isSegmentationSupported();
  let background = canCutOut ? loadStored(BACKGROUND_KEY, isBackground, 'keep') : 'keep';
  let runToken = 0;

  const status = createStatus();
  const log = createLog();

  const modeButtons = new Map();
  const formatButtons = new Map();
  const cropButtons = new Map();
  const shapeButtons = new Map();
  const backgroundButtons = new Map();

  const GROUPS = {
    mode: { current: () => outputMode, buttons: modeButtons },
    format: { current: () => format, buttons: formatButtons },
    crop: { current: () => cropping, buttons: cropButtons },
    shape: { current: () => shape, buttons: shapeButtons },
    background: { current: () => background, buttons: backgroundButtons },
  };

  function segButton(group, value, label, iconName, onPick) {
    const button = h('button', {
      type: 'button',
      'aria-pressed': String(GROUPS[group].current() === value),
      onClick: () => onPick(value),
    }, iconName ? icon(iconName, 14) : null, t(label));

    GROUPS[group].buttons.set(value, button);
    return button;
  }

  let busy = false;

  /**
   * The single place that decides which controls are live, so a run finishing
   * cannot re-enable something the browser or the current settings rule out.
   */
  function syncButtons() {
    for (const { current, buttons } of Object.values(GROUPS)) {
      for (const [value, button] of buttons) {
        button.setAttribute('aria-pressed', String(current() === value));
        button.disabled = busy;
      }
    }

    // Crop mode only means anything while cropping is on.
    for (const button of shapeButtons.values()) {
      button.disabled = busy || cropping === 'off';
    }

    const remove = backgroundButtons.get('remove');
    if (remove && !canCutOut) remove.disabled = true;
    const webp = formatButtons.get('webp');
    if (webp && !canWebp) webp.disabled = true;
  }

  function setBusy(value) {
    busy = value;
    syncButtons();
    dropzone.setBusy(value);
    clearButton.disabled = value;
  }

  const dropzone = createDropzone({
    iconName: 'image',
    title: t('Choose or drop product images'),
    hint: t('Drag images in, browse for them, or paste with Ctrl+V while this panel is open. Originals on your disk are never modified.'),
    buttonLabel: t('Select images'),
    accept: 'image/*',
    multiple: true,
    onFiles: (files) => run(files),
  });

  const clearButton = h('button', {
    type: 'button',
    class: 'btn btn--ghost btn--sm',
    onClick: () => {
      if (phase === 'processing') return;
      phase = 'idle';
      status.reset();
      log.clear();
    },
  }, t('Clear completed state'));

  async function run(files) {
    const images = files.filter((file) => file.type.startsWith('image/'));
    if (!images.length || phase === 'processing') return;

    const token = ++runToken;
    phase = 'processing';
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
    const crop = cropping === 'on';
    const { mime, ext } = FORMATS[format];
    log.add(`${t('Started a run with')} ${plural(images.length, 'image', 'images')}, ${t('output')} ${ext.toUpperCase()}${crop ? `, ${t('cropping on')}` : `, ${t('cropping off')}`}.`);

    const zip = new StoreZip();
    const taken = new Set();
    const cutOut = background === 'remove';
    let done = 0;
    let produced = 0;
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
      const concurrency = cutOut ? 1 : (outputMode === 'zip' ? ZIP_CONCURRENCY : 1);

      await mapLimit(images, concurrency, async (file, index) => {
        if (runToken !== token) return;

        const verb = cutOut ? t('Removing background') : (crop ? t('Cropping') : t('Converting'));
        status.set({
          title: `${verb} ${index + 1}/${images.length}: ${file.name}`,
        });

        try {
          const blob = await processImage(file, {
            crop,
            square: crop && shape === 'square',
            removeBackground: cutOut,
            mime,
            quality: QUALITY,
          });
          if (!blob) {
            skipped += 1;
            log.error(`${t('Skipped empty image')}: ${file.name}`);
          } else {
            const name = uniqueName(file.name, taken, ext);
            if (outputMode === 'single') {
              saveBlob(blob, name);
              log.add(`${t('Download started')}: ${name}`);
            } else {
              await zip.addBlob(name, blob);
              log.add(`${t('Prepared')}: ${name}`);
            }
            produced += 1;
          }
        } catch (error) {
          skipped += 1;
          log.error(`${file.name}: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
          done += 1;
          status.set({ progress: Math.round((done / images.length) * (outputMode === 'zip' ? 80 : 100)) });
        }
      });

      if (runToken !== token) return;

      if (!produced) {
        phase = 'error';
        status.set({
          phase: 'error',
          title: t('No output generated'),
          summary: t('Every image failed to process, or was empty and cropped away to nothing. See the event log below.'),
          progress: 0,
        });
        return;
      }

      if (outputMode === 'zip') {
        status.set({ title: t('Building ZIP archive'), progress: 90 });
        // Store-only: both output formats are already compressed, so deflating
        // them again just costs time.
        saveBlob(zip.build(), zipName(crop));
        log.success(t('ZIP download started.'));
      } else {
        log.success(t('All individual downloads were started.'));
      }

      phase = 'success';
      status.set({
        phase: 'success',
        title: t('Processing complete'),
        summary: `${plural(produced, 'file', 'files')} ${t('prepared')}${skipped ? `; ${skipped} ${t('skipped')}` : ''}.`,
        progress: 100,
      });
    } catch (error) {
      phase = 'error';
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

  function onPaste(event) {
    if (phase === 'processing' || !event.clipboardData) return;
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
      run(files);
    }
  }

  const root = h('div', { class: 'stack' },
    pageHead('crop', t('Image Optimiser'), t('Convert product images to WebP or PNG, trimming the empty border off them unless you turn cropping off.')),

    h('section', { class: 'panel' },
      h('div', { class: 'panel__head' },
        h('div', null,
          h('h2', { class: 'panel__title' }, t('File format')),
          h('p', { class: 'panel__hint' }, canWebp
            ? t('WebP is saved at quality 92, which looks the same and is a fraction of the size. PNG is lossless. Both keep transparency.')
            : t('This browser has no WebP encoder, so everything comes out as PNG.'))),
        h('div', { class: 'segmented', role: 'group', 'aria-label': t('File format') },
          segButton('format', 'webp', 'Product images (WebP)', 'image', (value) => { format = value; saveStored(FORMAT_KEY, value); syncButtons(); }),
          segButton('format', 'png', 'Page images (PNG)', 'fileText', (value) => { format = value; saveStored(FORMAT_KEY, value); syncButtons(); }))),

      h('div', { class: 'panel__head' },
        h('div', null,
          h('h2', { class: 'panel__title' }, t('Crop')),
          h('p', { class: 'panel__hint' }, t('With cropping off the pixels are left exactly as they are and only the file format changes.'))),
        h('div', { class: 'segmented', role: 'group', 'aria-label': t('Crop') },
          segButton('crop', 'on', 'On', 'crop', (value) => { cropping = value; saveStored(CROP_KEY, value); syncButtons(); }),
          segButton('crop', 'off', 'Off', 'image', (value) => { cropping = value; saveStored(CROP_KEY, value); syncButtons(); }))),

      h('div', { class: 'panel__head' },
        h('div', null,
          h('h2', { class: 'panel__title' }, t('Download mode')),
          h('p', { class: 'panel__hint' }, t('Only the download packaging differs; the files themselves are identical either way.'))),
        h('div', { class: 'segmented', role: 'group', 'aria-label': t('Download mode') },
          segButton('mode', 'zip', 'ZIP archive', 'archive', (value) => { outputMode = value; saveStored(MODE_KEY, value); syncButtons(); }),
          segButton('mode', 'single', 'Individual files', 'download', (value) => { outputMode = value; saveStored(MODE_KEY, value); syncButtons(); }))),

      h('div', { class: 'panel__head' },
        h('div', null,
          h('h2', { class: 'panel__title' }, t('Crop mode')),
          h('p', { class: 'panel__hint' }, t('Square mode centres the product and fills any overhang with the detected background.'))),
        h('div', { class: 'segmented', role: 'group', 'aria-label': t('Crop mode') },
          segButton('shape', 'full', 'Full crop', 'crop', (value) => { shape = value; saveStored(SHAPE_KEY, value); syncButtons(); }),
          segButton('shape', 'square', 'Square (1:1)', 'layers', (value) => { shape = value; saveStored(SHAPE_KEY, value); syncButtons(); }))),

      h('div', { class: 'panel__head' },
        h('div', null,
          h('h2', { class: 'panel__title' }, t('Background')),
          h('p', { class: 'panel__hint' }, canCutOut
            ? t('Remove cuts the product out and leaves everything behind it transparent, using a model that runs on this computer. Nothing is uploaded. The first run downloads about 16 MB.')
            : t('This browser cannot run the background model: it needs module workers and OffscreenCanvas.'))),
        h('div', { class: 'segmented', role: 'group', 'aria-label': t('Background') },
          segButton('background', 'keep', 'Keep', 'image', (value) => { background = value; saveStored(BACKGROUND_KEY, value); syncButtons(); }),
          segButton('background', 'remove', 'Remove', 'wand', (value) => { background = value; saveStored(BACKGROUND_KEY, value); syncButtons(); }))),

      dropzone.el,
      h('div', { class: 'row', style: { marginBlockStart: '16px' } }, clearButton),
    ),

    status.el,
    log.el,
  );

  // Applies the browser-capability overrides and the crop-mode dependency to the
  // buttons that were just built.
  syncButtons();

  // Bound to the document, not to `root`: a paste with nothing focused targets
  // <body>, which never bubbles through the tool container.
  document.addEventListener('paste', onPaste);

  return {
    el: root,
    destroy() {
      runToken += 1;
      document.removeEventListener('paste', onPaste);
    },
  };
}
