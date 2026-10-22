// SPDX-License-Identifier: MIT
const GRAPHICS_HISTOGRAM_LIMIT = 65536;
export const GRAPHICS_EDGE_RANGE = 32;
const graphicsRGB = (rgba, at) => rgba[at] + rgba[at + 1] * 256 + rgba[at + 2] * 65536;

export function* graphicsProtectionSteps(rgba, width, height, preserveEdges, protectedMask) {
  const mask = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const pixel = y * width + x, at = pixel * 4;
      if (rgba[at + 3] !== 255 || protectedMask?.[pixel]) { mask[pixel] = 1; continue; }
      if (!preserveEdges) continue;
      if (!x || !y || x === width - 1 || y === height - 1) { mask[pixel] = 1; continue; }
      let protectedEdge = false;
      for (let c = 0; c < 3 && !protectedEdge; c++) {
        let low = 255, high = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const neighbor = at + (dy * width + dx) * 4;
          if (rgba[neighbor + 3] !== 255) { protectedEdge = true; break; }
          low = Math.min(low, rgba[neighbor + c]); high = Math.max(high, rgba[neighbor + c]);
        }
        protectedEdge ||= high - low >= GRAPHICS_EDGE_RANGE;
      }
      mask[pixel] = +protectedEdge;
    }
    if ((y & 31) === 31 || y === height - 1) if (yield (y + 1) / height) return null;
  }
  return mask;
}

function graphicsFits(color, reference, at, error) {
  return Math.abs((color & 255) - reference[at]) <= error &&
    Math.abs(((color >>> 8) & 255) - reference[at + 1]) <= error &&
    Math.abs((color >>> 16) - reference[at + 2]) <= error;
}

export function* graphicsPaletteSteps(rgba, width, height, mask, error, paletteColors, reference = rgba, centroid = true) {
  const frequency = new Map(), count = width * height;
  for (let pixel = 0; pixel < count; pixel++) {
    if (!mask[pixel]) {
      const color = graphicsRGB(rgba, pixel * 4), previous = frequency.get(color);
      if (previous === undefined && frequency.size === GRAPHICS_HISTOGRAM_LIMIT)
        return rgba === reference ? null : rgba;
      frequency.set(color, (previous || 0) + 1);
    }
    if ((pixel & 16383) === 16383 || pixel === count - 1) if (yield (pixel + 1) / (3 * count)) return null;
  }
  const ordered = [...frequency].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  const membership = new Map(), grid = new Map(), clusters = [], cell = 2 * error + 1;
  const bucket = center => Math.floor(center[0] / cell) + Math.floor(center[1] / cell) * 256 + Math.floor(center[2] / cell) * 65536;
  const insert = (key, index) => { if (!grid.has(key)) grid.set(key, []); grid.get(key).push(index); };
  for (let i = 0; i < ordered.length; i++) {
    const [color, uses] = ordered[i], values = [color & 255, (color >>> 8) & 255, color >>> 16];
    const [r, g, b] = values, cr = Math.floor(r / cell), cg = Math.floor(g / cell), cb = Math.floor(b / cell);
    let selected = -1, distance = Infinity;
    for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const x = cr + dx, y = cg + dy, z = cb + dz;
      if (x < 0 || y < 0 || z < 0 || x > 255 || y > 255 || z > 255) continue;
      for (const index of grid.get(x + y * 256 + z * 65536) || []) {
        const cluster = clusters[index];
        if (centroid ? values.some((v, c) => {
          const low = Math.min(v, cluster.low[c]), high = Math.max(v, cluster.high[c]);
          if (high - low > 2 * error) return true;
          const center = Math.floor((cluster.sums[c] + v * uses) / (cluster.uses + uses) + .5);
          return center < high - error || center > low + error;
        }) : values.some((v, c) => Math.abs(v - cluster.center[c]) > error)) continue;
        const dr = r - cluster.center[0], dg = g - cluster.center[1], db = b - cluster.center[2];
        const cost = dr * dr + 2 * dg * dg + db * db;
        if (cost < distance || cost === distance && index < selected) { distance = cost; selected = index; }
      }
    }
    if (selected === -1 && clusters.length < paletteColors) {
      selected = clusters.length;
      clusters.push({low: values.slice(), high: values.slice(), sums: values.map(v => v * uses), uses, center: values.slice()});
      insert(bucket(values), selected);
    } else if (selected !== -1) {
      const cluster = clusters[selected], previous = bucket(cluster.center);
      cluster.uses += uses;
      for (let c = 0; c < 3; c++) {
        cluster.low[c] = Math.min(cluster.low[c], values[c]); cluster.high[c] = Math.max(cluster.high[c], values[c]);
        cluster.sums[c] += values[c] * uses;
        if (centroid) cluster.center[c] = Math.max(cluster.high[c] - error,
          Math.min(cluster.low[c] + error, Math.floor(cluster.sums[c] / cluster.uses + .5)));
      }
      const next = bucket(cluster.center);
      if (previous !== next) {
        const old = grid.get(previous); old.splice(old.indexOf(selected), 1);
        if (!old.length) grid.delete(previous);
        insert(next, selected);
      }
    }
    membership.set(color, selected);
    if ((i & 511) === 511 || i === ordered.length - 1) if (yield (1 + (i + 1) / ordered.length) / 3) return null;
  }
  const representatives = clusters.map(({center}) => center[0] + center[1] * 256 + center[2] * 65536);
  const output = new Uint8Array(rgba); let changed = false;
  for (let pixel = 0; pixel < count; pixel++) {
    const at = pixel * 4;
    if (!mask[pixel]) {
      const index = membership.get(graphicsRGB(rgba, at)), color = index >= 0 ? representatives[index] : undefined;
      if (color !== undefined && graphicsFits(color, reference, at, error)) {
        output[at] = color & 255; output[at + 1] = (color >>> 8) & 255; output[at + 2] = color >>> 16;
      }
    }
    changed ||= output[at] !== reference[at] || output[at + 1] !== reference[at + 1] || output[at + 2] !== reference[at + 2];
    if ((pixel & 16383) === 16383 || pixel === count - 1) if (yield (2 + (pixel + 1) / count) / 3) return null;
  }
  return changed ? output : null;
}

export function* graphicsUnditherSteps(rgba, width, height, mask, error) {
  const output = new Uint8Array(rgba); let changed = false;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const pixel = y * width + x, at = pixel * 4;
      if (mask[pixel]) continue;
      for (let c = 0; c < 3; c++) {
        let sum = 0, count = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const neighbor = (ny * width + nx) * 4;
          if (rgba[neighbor + 3] !== 255) continue;
          const weight = (dx === 0 ? 2 : 1) * (dy === 0 ? 2 : 1);
          sum += rgba[neighbor + c] * weight; count += weight;
        }
        const value = Math.max(rgba[at + c] - error, Math.min(rgba[at + c] + error, Math.floor(sum / count + .5)));
        output[at + c] = value; changed ||= value !== rgba[at + c];
      }
    }
    if ((y & 31) === 31 || y === height - 1) if (yield (y + 1) / height) return null;
  }
  return changed ? output : null;
}
