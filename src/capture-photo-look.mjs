// SPDX-License-Identifier: MIT
import {rgbCoefficientSteps} from './photo-dct.mjs';
import {complete} from './bits.mjs';
import {scorer, reconstruct} from './ssimulacra2-kernel.mjs';

export const TARGETS = [[0.3, 50.79], [0.4, 57.42], [0.5, 62.22], [0.6, 65.5], [0.7, 69.29], [0.75, 70.83], [0.8, 75.66],
  [0.85, 79.82], [0.9, 84.17], [0.92, 85.51], [0.95, 87.31], [0.98, 88.38]];
export function target(q) {
  if (q <= TARGETS[0][0]) return TARGETS[0][1];
  let i = 0;
  while (i + 2 < TARGETS.length && TARGETS[i + 1][0] < q) i++;
  const [q0, t0] = TARGETS[i], [q1, t1] = TARGETS[i + 1];
  return q >= q1 ? t1 : t0 + (q - q0) / (q1 - q0) * (t1 - t0);
}
export const SLOPE = 1, MARGIN = 1;
const SMALLEST = 64;

const cut = (src, sw, x0, y0, w, h) => {
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) out.set(src.subarray(((y0 + y) * sw + x0) * 4, ((y0 + y) * sw + x0 + w) * 4), y * w * 4);
  return out;
};
const cutReplicated = (src, sw, x0, y0, w, h) => {
  if (x0 >= 0 && y0 >= 0) return cut(src, sw, x0, y0, w, h);
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const sy = Math.max(0, y0 + y);
    for (let x = 0; x < w; x++) out.set(src.subarray((sy * sw + Math.max(0, x0 + x)) * 4, (sy * sw + Math.max(0, x0 + x)) * 4 + 4), (y * w + x) * 4);
  }
  return out;
};

export function cropScores(data, width, r, quality, crops = [r], dx = 0, dy = 0, exactRects = [], colorSpace = 'srgb', frameQuality = quality) {
  const height = data.length / 4 / width, rx1 = r.x + r.width, ry1 = r.y + r.height;
  const parts = crops.map(c => { const x = Math.max(c.x, r.x), y = Math.max(c.y, r.y); return {x, y, width: Math.min(c.x + c.width, rx1) - x, height: Math.min(c.y + c.height, ry1) - y}; })
    .filter(c => c.width >= SMALLEST && c.height >= SMALLEST);
  if (!parts.length) return [];
  const x0 = ((Math.min(...parts.map(c => c.x)) + dx) & ~63) - dx, y0 = ((Math.min(...parts.map(c => c.y)) + dy) & ~63) - dy;
  const x1 = Math.min(width, ((Math.max(...parts.map(c => c.x + c.width)) + dx + 63) & ~63) - dx), y1 = Math.min(height, ((Math.max(...parts.map(c => c.y + c.height)) + dy + 63) & ~63) - dy);
  const w = x1 - x0, h = y1 - y0, area = {x: r.x - x0, y: r.y - y0, width: r.width, height: r.height, quality};
  const coded = reconstruct(complete(rgbCoefficientSteps(cutReplicated(data, width, x0, y0, w, h), w, h, frameQuality, colorSpace, [area]))).slice();
  return parts.map(c => {
    const ours = cut(coded, w, c.x - x0, c.y - y0, c.width, c.height);
    for (const e of exactRects) {
      if (e.solidText === true) continue;
      const ex0 = Math.max(e.x, c.x), ey0 = Math.max(e.y, c.y), ex1 = Math.min(e.x + e.width, c.x + c.width), ey1 = Math.min(e.y + e.height, c.y + c.height);
      for (let y = ey0; y < ey1; y++) for (let x = ex0; x < ex1; x++) {
        const s = (y * width + x) * 4, d = ((y - c.y) * c.width + x - c.x) * 4;
        ours[d] = data[s]; ours[d + 1] = data[s + 1]; ours[d + 2] = data[s + 2];
      }
    }
    return scorer(cut(data, width, c.x, c.y, c.width, c.height), c.width, c.height)(ours);
  });
}

const held = (r, boxes, width, height) => {
  const inside = boxes.map(b => { const x = Math.max(0, Math.round(b.x)), y = Math.max(0, Math.round(b.y)); return {x, y, width: Math.min(width, Math.round(b.x + b.width)) - x, height: Math.min(height, Math.round(b.y + b.height)) - y}; })
    .filter(b => b.width >= SMALLEST && b.height >= SMALLEST && b.x + b.width / 2 >= r.x && b.x + b.width / 2 < r.x + r.width && b.y + b.height / 2 >= r.y && b.y + b.height / 2 < r.y + r.height);
  return inside.length || boxes.length ? inside : [r];
};

export function lookQuality(data, width, r, reading, webp, dx = 0, dy = 0, exactRects = [], colorSpace = 'srgb', frameQuality = reading, boxes = [], {slope = SLOPE, margin = MARGIN} = {}) {
  if (r.width < SMALLEST || r.height < SMALLEST || reading >= 100) return reading;
  const scores = cropScores(data, width, r, reading, held(r, boxes, width, data.length / 4 / width), dx, dy, exactRects, colorSpace, frameQuality);
  if (!scores.length) return reading;
  const worst = Math.min(...scores), T = target(webp), step = Math.floor((worst - T - margin) / slope);
  return Math.max(1, Math.min(99, reading - (step < 0 && worst >= T ? 0 : step)));
}
