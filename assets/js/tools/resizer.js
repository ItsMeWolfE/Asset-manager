// Smart Resizer - place one image precisely inside a fixed output canvas.

import { h, icon, clear } from '../core/dom.js';
import { t } from '../core/i18n.js';
import { loadStored, saveStored } from '../core/prefs.js';
import { createDropzone, pageHead, toast } from '../core/ui.js';
import { encodeCanvas, OUTPUT_EXT } from '../core/image.js';
import { saveBlob, safeName } from '../core/files.js';

const PRESET_KEY = 'asset-manager-resizer-presets-v1';
const LEGACY_PRESET_KEYS = ['bam-resizer-presets-v3', 'devtools-resizer-presets-v2'];
const SELECTED_KEY = 'asset-manager-resizer-preset-v1';
const BACKGROUND_KEY = 'asset-manager-resizer-background-v1';

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

  let image = carried?.image ?? null;
  let baseName = carried?.baseName ?? 'image';
  let scale = carried?.scale ?? 1;
  let position = carried?.position ? { ...carried.position } : { x: 0, y: 0 };
  const storedBackground = loadStored(BACKGROUND_KEY, isBackground, null);
  let transparent = storedBackground ? storedBackground.transparent : true;
  let background = storedBackground ? storedBackground.colour : '#ffffff';
  let objectUrl = carried?.objectUrl ?? null;
  // Set once the object URL has been handed to main.js's stash, which holds it
  // for whenever this tool is mounted again. Revoking it in destroy would break
  // the image the next instance restores. At most one is ever live: loading
  // another image revokes the previous one, as does starting over.
  let handedOver = false;

  const canvas = h('canvas', { width: size.w, height: size.h });
  const guideV = h('div', { class: 'guide guide--v' });
  const guideH = h('div', { class: 'guide guide--h' });
  guideV.hidden = true;
  guideH.hidden = true;

  const canvasWrap = h('div', { class: 'canvas-wrap' }, canvas, guideV, guideH);
  const errorLine = h('p', { class: 'error-text' });

  // --- rendering ---------------------------------------------------------

  function render() {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, size.w, size.h);
    if (!transparent) {
      ctx.fillStyle = background;
      ctx.fillRect(0, 0, size.w, size.h);
    }
    if (image) {
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(image, position.x, position.y, image.width * scale, image.height * scale);
    }
  }

  function syncCanvasBox() {
    canvas.width = size.w;
    canvas.height = size.h;
    canvasWrap.style.width = `min(100%, ${Math.min(PREVIEW_MAX, size.w)}px)`;
    canvasWrap.style.aspectRatio = String(size.w / size.h);
    render();
  }

  /** Fit shows the whole image; fill covers the canvas. */
  function frame(mode, targetSize = size, source = image) {
    if (!source) return;

    const sw = source.naturalWidth || source.width;
    const sh = source.naturalHeight || source.height;
    if (!sw || !sh) return;

    const ratio = mode === 'cover'
      ? Math.max(targetSize.w / sw, targetSize.h / sh)
      : Math.min(targetSize.w / sw, targetSize.h / sh);

    scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, ratio));
    position = {
      x: (targetSize.w - sw * scale) / 2,
      y: (targetSize.h - sh * scale) / 2,
    };
    scaleInput.value = String(Math.round(scale * 100));
    scaleLabel.textContent = `${Math.round(scale * 100)}%`;
    render();
  }

  /** Keep the canvas centre fixed while the scale changes. */
  function rescale(next) {
    const clamped = Math.max(MIN_SCALE, Math.min(MAX_SCALE, next));
    if (!Number.isFinite(scale) || scale <= 0) { scale = clamped; render(); return; }

    const cx = size.w / 2;
    const cy = size.h / 2;
    position = {
      x: cx - (cx - position.x) * (clamped / scale),
      y: cy - (cy - position.y) * (clamped / scale),
    };
    scale = clamped;
    scaleLabel.textContent = `${Math.round(scale * 100)}%`;
    render();
  }

  // --- image loading -----------------------------------------------------

  function loadFile(file) {
    if (!file || !file.type.startsWith('image/')) {
      errorLine.textContent = t('Choose a supported image file.');
      return;
    }
    errorLine.textContent = '';

    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = URL.createObjectURL(file);

    const img = new Image();
    img.onload = () => {
      image = img;
      baseName = file.name.replace(/\.[^/.]+$/, '') || 'image';
      frame('contain');
      updateLoadedState();
    };
    img.onerror = () => {
      errorLine.textContent = t('The image could not be decoded.');
      if (objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = null; }
    };
    img.src = objectUrl;
  }

  function onPaste(event) {
    if (!event.clipboardData) return;
    if (event.target.closest('input, textarea, [contenteditable="true"]')) return;

    const item = Array.from(event.clipboardData.items).find((entry) => entry.type.startsWith('image/'));
    const file = item?.getAsFile();
    if (file) {
      event.preventDefault();
      loadFile(file);
    }
  }

  // --- dragging ----------------------------------------------------------

  let dragging = false;
  let dragStart = { clientX: 0, clientY: 0, x: 0, y: 0 };

  canvas.addEventListener('pointerdown', (event) => {
    if (!image) return;
    dragging = true;
    canvas.setPointerCapture(event.pointerId);
    dragStart = { clientX: event.clientX, clientY: event.clientY, x: position.x, y: position.y };
  });

  canvas.addEventListener('pointermove', (event) => {
    if (!dragging || !image) return;

    const rect = canvas.getBoundingClientRect();
    const scaleX = rect.width ? size.w / rect.width : 1;
    const scaleY = rect.height ? size.h / rect.height : 1;

    let x = dragStart.x + (event.clientX - dragStart.clientX) * scaleX;
    let y = dragStart.y + (event.clientY - dragStart.clientY) * scaleY;

    const centredX = (size.w - image.width * scale) / 2;
    const centredY = (size.h - image.height * scale) / 2;
    const snapX = Math.abs(x - centredX) < SNAP_PX;
    const snapY = Math.abs(y - centredY) < SNAP_PX;

    if (snapX) x = centredX;
    if (snapY) y = centredY;

    guideV.hidden = !snapX;
    guideH.hidden = !snapY;

    position = { x, y };
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
    frame('contain');
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
      frame('contain');
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
      frame('contain');
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

  const downloadButton = h('button', {
    type: 'button', class: 'btn',
    onClick: async () => {
      if (!image) return;
      const blob = await encodeCanvas(canvas);
      saveBlob(blob, `${safeName(baseName, 'image')}-${size.w}x${size.h}.${OUTPUT_EXT}`);
    },
  }, icon('download', 14), t('Download result'));

  const startOverButton = h('button', {
    type: 'button', class: 'btn btn--ghost',
    onClick: () => {
      image = null;
      errorLine.textContent = '';
      if (objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = null; }
      updateLoadedState();
      render();
    },
  }, t('Start over'));

  const dropzone = createDropzone({
    iconName: 'image',
    title: t('Choose or drop an image'),
    hint: t('Drag an image in, browse for it, or paste with Ctrl+V.'),
    buttonLabel: t('Select image'),
    accept: 'image/*',
    multiple: false,
    onFiles: (files) => loadFile(files[0]),
  });

  const editor = h('div', { class: 'stack' },
    canvasWrap,
    h('div', { class: 'row row--between' },
      h('div', { class: 'segmented', role: 'group', 'aria-label': t('Placement') },
        h('button', { type: 'button', onClick: () => frame('contain') }, t('Fit')),
        h('button', { type: 'button', onClick: () => frame('cover') }, t('Fill'))),
      h('div', { class: 'row' }, startOverButton, downloadButton)),
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
    dropzone.el.hidden = Boolean(image);
    editor.hidden = !image;
  }

  const root = h('div', { class: 'stack' },
    pageHead('resize', t('Smart Resizer'), t('Place an image precisely inside a fixed output canvas.')),

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
  );

  document.addEventListener('paste', onPaste);

  renderPresets();
  // selectPreset re-frames the image, which would discard a carried scale and
  // position, so those are restored after it rather than before.
  selectPreset(presetId);
  if (image) {
    scale = carried.scale;
    position = { ...carried.position };
    scaleInput.value = String(Math.round(scale * 100));
    scaleLabel.textContent = `${Math.round(scale * 100)}%`;
  }
  syncCanvasBox();
  updateLoadedState();

  return {
    el: root,
    getState() {
      handedOver = true;
      return { image, baseName, scale, position, objectUrl };
    },
    destroy() {
      document.removeEventListener('paste', onPaste);
      if (objectUrl && !handedOver) URL.revokeObjectURL(objectUrl);
    },
  };
}
