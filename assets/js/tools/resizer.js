// Smart Resizer - place images precisely inside a fixed output canvas.
//
// One image or many: the images loaded in a run share the canvas size and the
// background, each keeps its own scale and position, and the run exports as a
// single file or as one ZIP.

import { h, icon, clear } from '../core/dom.js';
import { t, tf, plural } from '../core/i18n.js';
import { loadStored, saveStored } from '../core/prefs.js';
import { createDropzone, createStatus, pageHead, toast } from '../core/ui.js';
import { encodeCanvas, OUTPUT_EXT } from '../core/image.js';
import { StoreZip, saveBlob, safeName } from '../core/files.js';

const PRESET_KEY = 'asset-manager-resizer-presets-v1';
const LEGACY_PRESET_KEYS = ['bam-resizer-presets-v3', 'devtools-resizer-presets-v2'];
const SELECTED_KEY = 'asset-manager-resizer-preset-v1';
const BACKGROUND_KEY = 'asset-manager-resizer-background-v1';
const APPLY_KEY = 'asset-manager-resizer-apply-v1';

const BUILT_IN = [
  { id: 'top-product', name: 'Top Product', w: 264, h: 248 },
  { id: 'square-sm', name: 'Square Small', w: 100, h: 100 },
  { id: 'square-lg', name: 'Square Large', w: 500, h: 500 },
  { id: 'hd', name: 'HD 1080p', w: 1920, h: 1080 },
  { id: 'insta-story', name: 'Story', w: 1080, h: 1920 },
];

const SNAP_PX = 10;
const MIN_SCALE = 0.1;
const MAX_SCALE = 5;
const PREVIEW_MAX = 680;

const isPresetId = (value) => typeof value === 'string' && value.length > 0;

// Whether Fit, Fill, the scale slider and dragging move every loaded image or
// only the one on screen.
const isApply = (value) => value === 'all' || value === 'one';

// Stored as one object so the swatch and the transparent/colour choice can
// never disagree after a partial write.
const isBackground = (value) => value && typeof value === 'object' &&
  typeof value.transparent === 'boolean' &&
  typeof value.colour === 'string' && /^#[0-9a-f]{6}$/i.test(value.colour);

const isPresetList = (value) => Array.isArray(value) && value.every((preset) =>
  preset && typeof preset === 'object' &&
  typeof preset.id === 'string' && typeof preset.name === 'string' &&
  Number.isInteger(preset.w) && Number.isInteger(preset.h) &&
  preset.w > 0 && preset.h > 0);

/**
 * Both shapes the stash can hand back: the batch one this version writes, and
 * the single image 3.x left behind.
 */
function carriedItems(carried) {
  if (Array.isArray(carried?.items)) {
    return carried.items
      .filter((entry) => entry?.image)
      .map((entry) => ({
        image: entry.image,
        baseName: entry.baseName ?? 'image',
        objectUrl: entry.objectUrl ?? null,
        scale: entry.scale ?? 1,
        position: entry.position ? { ...entry.position } : { x: 0, y: 0 },
      }));
  }
  if (!carried?.image) return [];
  return [{
    image: carried.image,
    baseName: carried.baseName ?? 'image',
    objectUrl: carried.objectUrl ?? null,
    scale: carried.scale ?? 1,
    position: carried.position ? { ...carried.position } : { x: 0, y: 0 },
  }];
}

export function createResizer(carried = null) {
  let presets = LEGACY_PRESET_KEYS.reduce(
    (fallback, key) => loadStored(key, isPresetList, fallback),
    BUILT_IN,
  );
  presets = loadStored(PRESET_KEY, isPresetList, presets);
  // A stored id can name a preset that has since been deleted or reset away,
  // so it is honoured only while it still exists.
  const storedId = loadStored(SELECTED_KEY, isPresetId, null);
  const opening = presets.find((preset) => preset.id === storedId) ?? presets[0];
  let presetId = opening?.id ?? 'top-product';
  let size = { w: opening?.w ?? 264, h: opening?.h ?? 248 };

  // Every loaded image, in the order it was chosen. Each item carries its own
  // scale and position; the canvas size and the background are shared.
  let items = carriedItems(carried);
  let index = Math.min(Math.max(Number(carried?.index) || 0, 0), Math.max(items.length - 1, 0));
  const current = () => items[index] ?? null;

  let applyTo = loadStored(APPLY_KEY, isApply, 'all');
  /** The images an adjustment touches: all of them, or just the one on screen. */
  const targets = () => (applyTo === 'all' ? items : (current() ? [current()] : []));

  const storedBackground = loadStored(BACKGROUND_KEY, isBackground, null);
  let transparent = storedBackground ? storedBackground.transparent : true;
  let background = storedBackground ? storedBackground.colour : '#ffffff';

  // Set once the items have been handed to main.js's stash, which holds them
  // for whenever this tool is mounted again. Revoking their object URLs in
  // destroy would break the images the next instance restores.
  let handedOver = false;
  // Bumped by every load and by Start over, so a decode that finishes after
  // the set it belongs to has been replaced is dropped instead of appended.
  let loadToken = 0;
  let exporting = false;

  const canvas = h('canvas', { width: size.w, height: size.h });
  const guideV = h('div', { class: 'guide guide--v' });
  const guideH = h('div', { class: 'guide guide--h' });
  guideV.hidden = true;
  guideH.hidden = true;

  const canvasWrap = h('div', { class: 'canvas-wrap' }, canvas, guideV, guideH);
  const errorLine = h('p', { class: 'error-text' });
  const status = createStatus();
  status.el.hidden = true;

  // --- rendering ---------------------------------------------------------

  /** Paint one item, or just the background when there is none. */
  function paint(ctx, item, target) {
    ctx.clearRect(0, 0, target.w, target.h);
    if (!transparent) {
      ctx.fillStyle = background;
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
  function frame(mode, item = current(), targetSize = size) {
    if (!item?.image) return;

    const source = item.image;
    const sw = source.naturalWidth || source.width;
    const sh = source.naturalHeight || source.height;
    if (!sw || !sh) return;

    const ratio = mode === 'cover'
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
  function frameAll(mode) {
    for (const item of items) frame(mode, item);
    syncScaleControls();
    render();
  }

  /** What the Fit and Fill buttons do: whichever images are being adjusted. */
  function frameTargets(mode) {
    for (const item of targets()) frame(mode, item);
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

  // --- image loading -----------------------------------------------------

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
   * Load a selection. A new selection replaces the previous one, exactly as a
   * second image replaced the first before batches existed.
   */
  async function loadFiles(fileList) {
    if (exporting) return;

    const files = Array.from(fileList || []).filter((file) => file?.type?.startsWith('image/'));
    if (!files.length) {
      errorLine.textContent = t('Choose a supported image file.');
      return;
    }

    errorLine.textContent = '';
    const token = ++loadToken;
    dropzone.setBusy(true);

    // Large photos take a noticeable while to decode, and until they do there
    // is nothing on screen, so the count is shown as they arrive.
    let ready = 0;
    status.el.hidden = false;
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
        dropzone.setBusy(false);
        status.reset();
        status.el.hidden = true;
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
    updateLoadedState();
    render();
  }

  function onPaste(event) {
    if (exporting || !event.clipboardData) return;
    if (event.target.closest('input, textarea, [contenteditable="true"]')) return;

    const files = [];
    Array.from(event.clipboardData.items).forEach((entry, position) => {
      if (!entry.type.startsWith('image/')) return;
      const file = entry.getAsFile();
      if (file) {
        files.push(new File([file], `pasted_${Date.now()}_${position}.png`, { type: file.type || 'image/png' }));
      }
    });

    if (files.length) {
      event.preventDefault();
      loadFiles(files);
    }
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

  function applyChoiceButton(value, label) {
    return h('button', {
      type: 'button',
      'aria-pressed': String(applyTo === value),
      onClick: () => {
        applyTo = value;
        saveStored(APPLY_KEY, value);
        syncApplyButtons();
      },
    }, t(label));
  }

  const applyAllButton = applyChoiceButton('all', 'All images');
  const applyOneButton = applyChoiceButton('one', 'This image');

  const applyRow = h('div', { class: 'row row--between' },
    h('span', { class: 'field__label' }, t('Adjustments')),
    h('div', { class: 'segmented', role: 'group', 'aria-label': t('Adjustments') },
      applyAllButton, applyOneButton));

  function syncApplyButtons() {
    applyAllButton.setAttribute('aria-pressed', String(applyTo === 'all'));
    applyOneButton.setAttribute('aria-pressed', String(applyTo === 'one'));
    applyHint.textContent = applyTo === 'all'
      ? t('Fit, Fill, the scale slider and dragging move every loaded image together.')
      : t('Fit, Fill, the scale slider and dragging move only the image on screen. Click a thumbnail to work on another one.');
  }

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

  // --- controls ----------------------------------------------------------

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
    saveStored(SELECTED_KEY, id);
    size = { w: preset.w, h: preset.h };
    widthInput.value = String(preset.w);
    heightInput.value = String(preset.h);
    syncCanvasBox();
    frameAll('contain');
  }

  const widthInput = h('input', { class: 'input', type: 'number', min: '1', value: String(size.w), 'aria-label': t('Width') });
  const heightInput = h('input', { class: 'input', type: 'number', min: '1', value: String(size.h), 'aria-label': t('Height') });
  const nameInput = h('input', { class: 'input', type: 'text', placeholder: t('Preset name'), 'aria-label': t('Preset name') });

  const applyButton = h('button', {
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
      saveStored(SELECTED_KEY, preset.id);
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
    type: 'color', value: background, 'aria-label': t('Background colour'),
    onInput: () => { background = bgColorInput.value; transparent = false; saveBackground(); syncBgButtons(); render(); },
  });

  const transparentButton = h('button', {
    type: 'button', 'aria-pressed': String(transparent),
    onClick: () => { transparent = true; saveBackground(); syncBgButtons(); render(); },
  }, t('Transparent'));

  const colourButton = h('button', {
    type: 'button', 'aria-pressed': String(!transparent),
    onClick: () => { transparent = false; saveBackground(); syncBgButtons(); render(); },
  }, t('Colour'));

  function saveBackground() {
    saveStored(BACKGROUND_KEY, { transparent, colour: background });
  }

  function syncBgButtons() {
    transparentButton.setAttribute('aria-pressed', String(transparent));
    colourButton.setAttribute('aria-pressed', String(!transparent));
  }

  // --- export ------------------------------------------------------------

  function outputName(item, taken) {
    const base = `${safeName(item.baseName, 'image')}-${size.w}x${size.h}`;
    let name = `${base}.${OUTPUT_EXT}`;
    let n = 2;
    while (taken.has(name)) {
      name = `${base}_${n}.${OUTPUT_EXT}`;
      n += 1;
    }
    taken.add(name);
    return name;
  }

  /**
   * One image downloads on its own, as it always has. A batch is encoded one
   * at a time - the canvas work is on the main thread either way - and leaves
   * as a single ZIP, because browsers throttle long runs of downloads.
   */
  async function exportItems() {
    if (exporting || !items.length) return;

    if (items.length === 1) {
      const blob = await encodeCanvas(canvas);
      saveBlob(blob, outputName(items[0], new Set()));
      return;
    }

    exporting = true;
    setExportBusy(true);
    status.el.hidden = false;
    status.set({
      phase: 'processing',
      title: `${t('Preparing')} ${plural(items.length, 'image', 'images')}`,
      summary: '',
      progress: 0,
    });

    const out = h('canvas', { width: size.w, height: size.h });
    const ctx = out.getContext('2d');
    const zip = new StoreZip();
    const taken = new Set();
    const failures = [];

    try {
      if (!ctx) throw new Error(t('Canvas 2D context is unavailable'));

      for (const [position, item] of items.entries()) {
        status.set({
          title: `${t('Preparing')} ${position + 1}/${items.length}: ${item.baseName}`,
          progress: Math.round((position / items.length) * 80),
        });
        try {
          paint(ctx, item, size);
          await zip.addBlob(outputName(item, taken), await encodeCanvas(out));
        } catch (error) {
          failures.push(`${item.baseName}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      if (!zip.size) {
        status.set({
          phase: 'error',
          title: t('No output generated'),
          summary: failures[0] ?? '',
          progress: 0,
        });
        return;
      }

      status.set({ title: t('Building ZIP archive'), progress: 90 });
      saveBlob(zip.build(), `resized-${size.w}x${size.h}.zip`);
      status.set({
        phase: 'success',
        title: t('Processing complete'),
        summary: `${plural(zip.size, 'file', 'files')} ${t('prepared')}${failures.length ? `; ${failures.length} ${t('skipped')}` : ''}.`,
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
      exporting = false;
      setExportBusy(false);
    }
  }

  const downloadLabel = h('span', null, t('Download result'));
  const downloadButton = h('button', {
    type: 'button', class: 'btn',
    onClick: () => { exportItems(); },
  }, icon('download', 14), downloadLabel);

  const startOverButton = h('button', {
    type: 'button', class: 'btn btn--ghost',
    onClick: () => {
      if (exporting) return;
      loadToken += 1;
      releaseItems();
      items = [];
      index = 0;
      errorLine.textContent = '';
      status.reset();
      status.el.hidden = true;
      renderStrip();
      updateLoadedState();
      render();
    },
  }, t('Start over'));

  const fitButton = h('button', { type: 'button', onClick: () => frameTargets('contain') }, t('Fit'));
  const fillButton = h('button', { type: 'button', onClick: () => frameTargets('cover') }, t('Fill'));

  function setExportBusy(busy) {
    downloadButton.disabled = busy;
    startOverButton.disabled = busy;
    fitButton.disabled = busy;
    fillButton.disabled = busy;
    scaleInput.disabled = busy;
    dropzone.setBusy(busy);
  }

  const dropzone = createDropzone({
    iconName: 'image',
    title: t('Choose or drop images'),
    hint: t('Drag images in, browse for them, or paste with Ctrl+V. Originals on your disk are never modified.'),
    buttonLabel: t('Select images'),
    accept: 'image/*',
    multiple: true,
    onFiles: (files) => loadFiles(files),
  });

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
      h('div', { class: 'segmented', role: 'group', 'aria-label': t('Background') },
        transparentButton, colourButton),
      bgColorInput),
    errorLine,
  );

  function updateLoadedState() {
    const loaded = items.length > 0;
    const batch = items.length > 1;
    dropzone.el.hidden = loaded;
    editor.hidden = !loaded;
    // A single image keeps the panel it has always had: no strip, and a
    // download button that names the one file it produces.
    strip.hidden = !batch;
    stripRow.hidden = !batch;
    applyRow.hidden = !batch;
    applyHint.hidden = !batch;
    downloadLabel.textContent = batch ? t('Download all') : t('Download result');
  }

  const root = h('div', { class: 'stack' },
    pageHead('resize', t('Smart Resizer'), t('Place images precisely inside a fixed output canvas.')),

    h('section', { class: 'panel' },
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
        applyButton,
        h('div', { class: 'field', style: { flex: '1 1 200px' } }, nameInput),
        saveButton, deleteButton)),

    h('section', { class: 'panel' }, dropzone.el, editor),
    status.el,
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
  syncApplyButtons();
  renderStrip();
  syncCanvasBox();
  updateLoadedState();

  return {
    el: root,
    getState() {
      handedOver = true;
      const item = current();
      return {
        items,
        index,
        // The single-image fields 3.x wrote, so an older build reading this
        // stash still finds the image that is on screen.
        image: item?.image ?? null,
        baseName: item?.baseName ?? 'image',
        scale: item?.scale ?? 1,
        position: item ? { ...item.position } : { x: 0, y: 0 },
        objectUrl: item?.objectUrl ?? null,
      };
    },
    destroy() {
      loadToken += 1;
      document.removeEventListener('paste', onPaste);
      if (!handedOver) releaseItems();
    },
  };
}
