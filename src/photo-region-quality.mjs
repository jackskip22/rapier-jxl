// SPDX-License-Identifier: MIT
import {rgbCoefficientSteps} from './photo-dct.mjs';
import {complete} from './bits.mjs';
import {reconstructDCT8RGB} from './color-band.mjs';
import {dct8Band} from './dct8-band.mjs';
import {captureLinearRGBA as toRGBA} from './capture-kernels.mjs';
import {ssimulacra2Reference} from './ssimulacra2.mjs';
import {photoNativeScores} from './photo-native-scores.mjs';
import {P3_TRANSFORM, linearFromTransformPlanes} from './color-transform.mjs';
import {photoReference} from './photo-reference.mjs';
import {nativeRGBA, nativeGammaRGBA} from './photo-output.mjs';
import {colorPixels} from './color-band.mjs';
import {PHOTO_PAD_SIDE, padPhotoCrop, photoRegionTarget, clipPhotoRect, cutPhotoRGBA} from './photo-region-score.mjs';
import {fault} from './fault.mjs';

const SLOPE = 1, MARGIN = 1;
export const SMALLEST = 64;

const cutReplicated = (src, sw, x0, y0, w, h) => {
  if (x0 >= 0 && y0 >= 0) return cutPhotoRGBA(src, sw, x0, y0, w, h);
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
    throw fault('JXL_INTERNAL', 'photo-region-quality:cacheBytes');
  const height = data.length / 4 / width, rx1 = r.x + r.width, ry1 = r.y + r.height;
  const parts = crops.map(c => clipPhotoRect(c, rx1, ry1, r.x, r.y))
    .filter(c => c.width >= SMALLEST && c.height >= SMALLEST);
  let pixels = data, left = cacheBytes, destroyed = false;
  data = null;
  let references = parts.map(c => {
    const pw = Math.max(PHOTO_PAD_SIDE, c.width), ph = Math.max(PHOTO_PAD_SIDE, c.height);
    const reference = () => {
      const source = padPhotoCrop(cutPhotoRGBA(pixels, width, c.x, c.y, c.width, c.height), c.width, c.height);
      return photoReference(source.rgba, source.width, source.height, colorSpace === 'display-p3' ? P3_TRANSFORM : null);
    };
    const prepared = ssimulacra2Reference(reference, pw, ph, {immutable: true, cacheBytes: left});
    left -= prepared.reservedBytes;
    return prepared;
  });
  const x0 = ((Math.min(...parts.map(c => c.x)) + dx) & ~63) - dx, y0 = ((Math.min(...parts.map(c => c.y)) + dy) & ~63) - dy;
  const x1 = Math.min(width, ((Math.max(...parts.map(c => c.x + c.width)) + dx + 63) & ~63) - dx), y1 = Math.min(height, ((Math.max(...parts.map(c => c.y + c.height)) + dy + 63) & ~63) - dy);
  const w = x1 - x0, h = y1 - y0;
  const scores = quality => {
    if (destroyed) throw fault('JXL_INTERNAL', 'photo-region-quality:destroyed');
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
    return parts.map((c, i) => {
      const pw = Math.max(PHOTO_PAD_SIDE, c.width), ph = Math.max(PHOTO_PAD_SIDE, c.height);
      return photoNativeScores({outputs: function* () {
        coded[0] ??= linear ? toRGBA(linear, w, h) : colorPixels(gamma, w, h, w, 0);
        yield {kind: 'package', rgba: padPhotoCrop(cutPhotoRGBA(coded[0], w, c.x - x0, c.y - y0, c.width, c.height), c.width, c.height).rgba};
        coded[1] ??= linear ? nativeRGBA(linear, w, h, {x: x0, y: y0}) : nativeGammaRGBA(gamma, w, h, {x: x0, y: y0});
        yield {kind: 'native', rgba: padPhotoCrop(cutPhotoRGBA(coded[1], w, c.x - x0, c.y - y0, c.width, c.height), c.width, c.height).rgba};
      }}, null, pw, ph, {reference: references[i]}).minimum;
    });
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

export function lookQuality(data, width, r, reading, intent, dx = 0, dy = 0, exactRects = [], colorSpace = 'srgb', frameQuality = reading, boxes = [], {slope = SLOPE, margin = MARGIN} = {}) {
  if (r.width < SMALLEST || r.height < SMALLEST || reading >= 100) return reading;
  const crops = held(r, boxes, width, data.length / 4 / width);
  const scores = cropScores(data, width, r, reading, crops, dx, dy, exactRects, colorSpace, frameQuality);
  const sides = crops.map(c => Math.min(c.width, c.height));
  return lookFromScores(reading, intent, scores, {slope, margin, side: sides.length ? Math.min(...sides) : Math.min(r.width, r.height), sides});
}

export function lookFromScores(reading, intent, scores, {slope = SLOPE, margin = MARGIN, side = PHOTO_PAD_SIDE, sides = null, measured = false} = {}) {
  if (!scores.length) return reading;
  if (scores.some(score => !Number.isFinite(score))) throw fault('JXL_INPUT', 'score: finite number');
  const room = Math.min(...scores.map((s, i) => s - photoRegionTarget(intent, sides?.[i] ?? side, measured))), step = Math.floor((room - margin) / slope);
  return Math.max(1, Math.min(99, reading - (step < 0 && room >= 0 ? 0 : step)));
}

