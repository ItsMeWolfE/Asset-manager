// Batch Cropper - trims the empty border off product photos, in bulk.

import { h, icon } from '../core/dom.js';
import { t, plural } from '../core/i18n.js';
import { loadStored, saveStored } from '../core/prefs.js';
import { createStatus, createLog, createDropzone, pageHead } from '../core/ui.js';
import { cropImage, uniqueName, mapLimit, OUTPUT_EXT } from '../core/image.js';
import { isSegmentationSupported, warmUpSegmentation } from '../core/segment.js';
import { StoreZip, saveBlob } from '../core/files.js';

const SHAPE_KEY = 'asset-manager-crop-shape-v1';
const LEGACY_SHAPE_KEY = 'bam-crop-shape-v1';
const BACKGROUND_KEY = 'asset-manager-crop-background-v1';
const isShape = (v) => v === 'square' || v === 'full';
const isBackground = (v) => v === 'keep' || v === 'remove';
const ZIP_NAME = 'tight_cropped.zip';

// ZIP mode can afford two decoders in flight. Individual downloads are kept
// sequential because browsers throttle rapid successive downloads.
const ZIP_CONCURRENCY = 2;

export function createCropper() {
  let phase = 'idle';
  let outputMode = 'zip';
  let shape = loadStored(SHAPE_KEY, isShape, loadStored(LEGACY_SHAPE_KEY, isShape, 'full'));
  // A browser without module workers or OffscreenCanvas cannot run the model at
  // all, so the stored preference is overridden rather than left to fail later.
  const canCutOut = isSegmentationSupported();
  let background = canCutOut ? loadStored(BACKGROUND_KEY, isBackground, 'keep') : 'keep';
  let runToken = 0;

  const status = createStatus();
  const log = createLog();

  const modeButtons = new Map();
  const shapeButtons = new Map();
  const backgroundButtons = new Map();

  const GROUPS = {
    mode: { current: () => outputMode, buttons: modeButtons },
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

  function syncButtons() {
    for (const { current, buttons } of Object.values(GROUPS)) {
      for (const [value, button] of buttons) {
        button.setAttribute('aria-pressed', String(current() === value));
      }
    }
  }

  function setBusy(busy) {
    for (const { buttons } of Object.values(GROUPS)) {
      for (const button of buttons.values()) button.disabled = busy;
    }
    // Stays disabled either way where the browser cannot run the model.
    const remove = backgroundButtons.get('remove');
    if (remove && !canCutOut) remove.disabled = true;
    dropzone.setBusy(busy);
    clearButton.disabled = busy;
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
    log.add(`${t('Started crop run with')} ${plural(images.length, 'image', 'images')}.`);

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

        status.set({
          title: `${cutOut ? t('Removing background') : t('Cropping')} ${index + 1}/${images.length}: ${file.name}`,
        });

        try {
          const blob = await cropImage(file, shape === 'square', cutOut);
          if (!blob) {
            skipped += 1;
            log.error(`${t('Skipped empty image')}: ${file.name}`);
          } else {
            const name = uniqueName(file.name, taken);
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
          summary: t('Every image was empty or failed to process. See the event log below.'),
          progress: 0,
        });
        return;
      }

      if (outputMode === 'zip') {
        status.set({ title: t('Building ZIP archive'), progress: 90 });
        // Store-only: WebP is already compressed, so deflating it just costs time.
        saveBlob(zip.build(), ZIP_NAME);
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
    pageHead('crop', t('Batch Cropper'), t('Remove empty borders from product images and export WebP files.')),

    h('section', { class: 'panel' },
      h('div', { class: 'panel__head' },
        h('div', null,
          h('h2', { class: 'panel__title' }, t('Output format')),
          h('p', { class: 'panel__hint' },
            `${t('Output is')} ${OUTPUT_EXT.toUpperCase()} ${t('with transparency preserved; only the download packaging differs.')}`)),
        h('div', { class: 'segmented', role: 'group', 'aria-label': t('Download mode') },
          segButton('mode', 'zip', 'ZIP archive', 'archive', (value) => { outputMode = value; syncButtons(); }),
          segButton('mode', 'single', 'Individual files', 'download', (value) => { outputMode = value; syncButtons(); }))),

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

  if (!canCutOut) {
    const remove = backgroundButtons.get('remove');
    if (remove) remove.disabled = true;
  }

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
