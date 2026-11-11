// SPDX-License-Identifier: MIT
import {rgbCoefficientSteps} from './photo-dct.mjs';
import {complete} from './bits.mjs';
import {reconstructDCT8RGB} from './reconstruct-dct8.mjs';
import {dct8Band} from './dct8-band.mjs';
import {toRGBA} from './rgb8-output.mjs';
import {ssimulacra2Reference} from './ssimulacra2.mjs';
import {photoNativeScores} from './photo-native-scores.mjs';
import {P3_TRANSFORM, linearFromTransformPlanes} from './color-transform.mjs';
import {photoReference} from './photo-reference.mjs';
import {gammaRGBA, nativeRGBA, nativeGammaRGBA} from './photo-output.mjs';

import {webpTarget} from './photo-quality-table.mjs';

export const SLOPE = 1, MARGIN = 1;
export const SMALLEST = 64;

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

export function prepareCropScores(data, width, r, crops = [r], dx = 0, dy = 0, exactRects = [], colorSpace = 'srgb', frameQuality,
  {cacheBytes = 16 << 20} = {}) {
  if (!Number.isSafeInteger(cacheBytes) || cacheBytes < 0 || cacheBytes > (16 << 20))
    throw new RangeError('Photo crop reference cacheBytes must be a nonnegative integer at most 16 MiB.');
  const height = data.length / 4 / width, rx1 = r.x + r.width, ry1 = r.y + r.height;
  const parts = crops.map(c => { const x = Math.max(c.x, r.x), y = Math.max(c.y, r.y); return {x, y, width: Math.min(c.x + c.width, rx1) - x, height: Math.min(c.y + c.height, ry1) - y}; })
    .filter(c => c.width >= SMALLEST && c.height >= SMALLEST);
  let pixels = data, left = cacheBytes, destroyed = false;
  data = null;
  let references = parts.map(c => {
    const reference = () => {
      const source = cut(pixels, width, c.x, c.y, c.width, c.height);
      return photoReference(source, c.width, c.height, colorSpace === 'display-p3' ? P3_TRANSFORM : null);
    };
    const prepared = ssimulacra2Reference(reference, c.width, c.height, {immutable: true, cacheBytes: left});
    left -= prepared.reservedBytes;
    return prepared;
  });
  const x0 = ((Math.min(...parts.map(c => c.x)) + dx) & ~63) - dx, y0 = ((Math.min(...parts.map(c => c.y)) + dy) & ~63) - dy;
  const x1 = Math.min(width, ((Math.max(...parts.map(c => c.x + c.width)) + dx + 63) & ~63) - dx), y1 = Math.min(height, ((Math.max(...parts.map(c => c.y + c.height)) + dy + 63) & ~63) - dy);
  const w = x1 - x0, h = y1 - y0;
  const scores = quality => {
    if (destroyed) throw new Error('Photo crop scorer is destroyed.');
    if (!parts.length) return [];
    const area = {x: r.x - x0, y: r.y - y0, width: r.width, height: r.height, quality};
    const gamma = reconstructDCT8RGB(complete(rgbCoefficientSteps(cutReplicated(pixels, width, x0, y0, w, h),
      w, h, frameQuality === undefined ? quality : frameQuality, colorSpace, [area])), dct8Band(), {planes: true});
    for (const e of exactRects) {
      if (e.solidText === true) continue;
      const ex0 = Math.max(e.x, x0), ey0 = Math.max(e.y, y0), ex1 = Math.min(e.x + e.width, x1), ey1 = Math.min(e.y + e.height, y1);
      for (let y = ey0; y < ey1; y++) for (let x = ex0; x < ex1; x++) {
        const from = (y * width + x) * 4, at = (y - y0) * w + x - x0;
        for (let c = 0; c < 3; c++) gamma[c][at] = pixels[from + c] / 255;
      }
    }
    const linear = colorSpace === 'display-p3' ? linearFromTransformPlanes(gamma, w * h, P3_TRANSFORM) : null;
    const coded = [null, null];
    return parts.map((c, i) => photoNativeScores({outputs: function* () {
      coded[0] ??= linear ? toRGBA(linear, w, h) : gammaRGBA(gamma, w, h);
      yield {kind: 'package', rgba: cut(coded[0], w, c.x - x0, c.y - y0, c.width, c.height)};
      coded[1] ??= linear ? nativeRGBA(linear, w, h, {x: x0, y: y0}) : nativeGammaRGBA(gamma, w, h, {x: x0, y: y0});
      yield {kind: 'native', rgba: cut(coded[1], w, c.x - x0, c.y - y0, c.width, c.height)};
    }}, null, c.width, c.height, {reference: references[i]}).minimum);
  };
  Object.defineProperties(scores, {
    cacheBytes: {get: () => references.reduce((sum, reference) => sum + reference.cacheBytes, 0)},
    reservedBytes: {value: cacheBytes - left},
    cacheAllowanceBytes: {value: cacheBytes},
  });
  scores.destroy = () => { destroyed = true; pixels = null; for (const reference of references) reference.release(); references = []; };
  return scores;
}

export function cropScores(data, width, r, quality, crops = [r], dx = 0, dy = 0, exactRects = [], colorSpace = 'srgb', frameQuality = quality) {
  const scores = prepareCropScores(data, width, r, crops, dx, dy, exactRects, colorSpace, frameQuality);
  try { return scores(quality); }
  finally { scores.destroy(); }
}

export const held = (r, boxes, width, height) => {
  const inside = boxes.map(b => { const x = Math.max(0, Math.round(b.x)), y = Math.max(0, Math.round(b.y)); return {x, y, width: Math.min(width, Math.round(b.x + b.width)) - x, height: Math.min(height, Math.round(b.y + b.height)) - y}; })
    .filter(b => b.width >= SMALLEST && b.height >= SMALLEST && b.x + b.width / 2 >= r.x && b.x + b.width / 2 < r.x + r.width && b.y + b.height / 2 >= r.y && b.y + b.height / 2 < r.y + r.height);
  return inside.length || boxes.length ? inside : [r];
};

export function lookQuality(data, width, r, reading, webp, dx = 0, dy = 0, exactRects = [], colorSpace = 'srgb', frameQuality = reading, boxes = [], {slope = SLOPE, margin = MARGIN} = {}) {
  if (r.width < SMALLEST || r.height < SMALLEST || reading >= 100) return reading;
  const scores = cropScores(data, width, r, reading, held(r, boxes, width, data.length / 4 / width), dx, dy, exactRects, colorSpace, frameQuality);
  return lookFromScores(reading, webp, scores, {slope, margin});
}

export function lookFromScores(reading, webp, scores, {slope = SLOPE, margin = MARGIN} = {}) {
  if (!scores.length) return reading;
  const worst = Math.min(...scores), T = webpTarget(webp), step = Math.floor((worst - T - margin) / slope);
  return Math.max(1, Math.min(99, reading - (step < 0 && worst >= T ? 0 : step)));
}

