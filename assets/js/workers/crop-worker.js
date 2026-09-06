
const alphaTolerance = 15;
const colorTolerance = 15;

function getPixel(data, w, x, y) {
  const i = (y * w + x) * 4;
  return { r: data[i], g: data[i + 1], b: data[i + 2], a: data[i + 3] };
}

function channelDistance(a, b) {
  return Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b);
}

function robustBackground(data, w, h) {
  const midX = Math.floor(w / 2);
  const midY = Math.floor(h / 2);
  const samples = [
    getPixel(data, w, 0, 0),
    getPixel(data, w, w - 1, 0),
    getPixel(data, w, 0, h - 1),
    getPixel(data, w, w - 1, h - 1),
    getPixel(data, w, midX, 0),
    getPixel(data, w, midX, h - 1),
    getPixel(data, w, 0, midY),
    getPixel(data, w, w - 1, midY),
  ];

  let best = samples[0];
  let bestScore = Infinity;
  for (const sample of samples) {
    let score = 0;
    for (const other of samples) score += channelDistance(sample, other);
    if (score < bestScore) {
      best = sample;
      bestScore = score;
    }
  }
  return best;
}

function findAlphaBounds(data, w, h, threshold) {
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const p = row + x;
      if (data[(p * 4) + 3] <= threshold) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return maxX === -1 ? null : { minX, minY, maxX, maxY };
}

function touchesEdge(bounds, w, h) {
  return bounds.minX === 0 || bounds.minY === 0 || bounds.maxX === w - 1 || bounds.maxY === h - 1;
}

function filterTinyEdgeComponents(data, w, h, threshold, rawBounds) {
  if (!rawBounds || !touchesEdge(rawBounds, w, h)) return rawBounds;

  const pixelCount = w * h;
  const minimumPixels = Math.max(4, Math.ceil(pixelCount * 0.000004));
  const state = new Uint8Array(pixelCount);
  const stack = new Int32Array(pixelCount);
  const component = new Int32Array(minimumPixels);
  let droppedPixels = 0;

  const hasContent = (p) => data[(p * 4) + 3] > threshold;

  // A component can only touch the image edge if it contains a border pixel, so
  // seeding from the border alone finds every candidate for removal. Interior
  // components are never traversed.
  const flood = (start) => {
    if (state[start] || !hasContent(start)) return;

    let sp = 0;
    let count = 0;
    state[start] = 1;
    stack[sp++] = start;

    while (sp) {
      const p = stack[--sp];
      if (count < minimumPixels) component[count] = p;
      count++;
      const px = p % w;
      const py = (p - px) / w;

      for (let ny = py - 1; ny <= py + 1; ny++) {
        if (ny < 0 || ny >= h) continue;
        const rowBase = ny * w;
        for (let nx = px - 1; nx <= px + 1; nx++) {
          if (nx < 0 || nx >= w || (nx === px && ny === py)) continue;
          const next = rowBase + nx;
          if (state[next] || !hasContent(next)) continue;
          state[next] = 1;
          stack[sp++] = next;
        }
      }
    }

    if (count < minimumPixels) {
      for (let i = 0; i < count; i++) state[component[i]] = 2;
      droppedPixels += count;
    }
  };

  for (let x = 0; x < w; x++) {
    flood(x);
    flood((h - 1) * w + x);
  }
  for (let y = 0; y < h; y++) {
    flood(y * w);
    flood(y * w + w - 1);
  }

  if (!droppedPixels) return rawBounds;

  let cleanMinX = w, cleanMinY = h, cleanMaxX = -1, cleanMaxY = -1;
  for (let y = rawBounds.minY; y <= rawBounds.maxY; y++) {
    const row = y * w;
    for (let x = rawBounds.minX; x <= rawBounds.maxX; x++) {
      const p = row + x;
      if (state[p] === 2 || !hasContent(p)) continue;
      if (x < cleanMinX) cleanMinX = x;
      if (x > cleanMaxX) cleanMaxX = x;
      if (y < cleanMinY) cleanMinY = y;
      if (y > cleanMaxY) cleanMaxY = y;
    }
  }

  return cleanMaxX === -1 ? rawBounds : { minX: cleanMinX, minY: cleanMinY, maxX: cleanMaxX, maxY: cleanMaxY };
}

function findColorBounds(data, w, h) {
  const bg = robustBackground(data, w, h);
  let minX = w, minY = h, maxX = -1, maxY = -1;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const differs =
        Math.abs(data[i] - bg.r) > colorTolerance ||
        Math.abs(data[i + 1] - bg.g) > colorTolerance ||
        Math.abs(data[i + 2] - bg.b) > colorTolerance;
      if (!differs) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return maxX === -1 ? null : { minX, minY, maxX, maxY };
}

self.onmessage = (event) => {
  const { id, width, height, buffer } = event.data;
  try {
    const data = new Uint8ClampedArray(buffer);
    const pixelCount = width * height;
    let transparentPixels = 0;
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] <= alphaTolerance) transparentPixels++;
    }

    const meaningfulTransparency = transparentPixels > Math.max(32, pixelCount * 0.005);
    let bounds = null;

    if (meaningfulTransparency) {
      let thresholdUsed = alphaTolerance;
      bounds = findAlphaBounds(data, width, height, thresholdUsed);
      if (!bounds) {
        thresholdUsed = 0;
        bounds = findAlphaBounds(data, width, height, thresholdUsed);
      }
      if (bounds) bounds = filterTinyEdgeComponents(data, width, height, thresholdUsed, bounds);
    }

    if (!bounds) bounds = findColorBounds(data, width, height);
    self.postMessage({ id, bounds });
  } catch (error) {
    self.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
};
