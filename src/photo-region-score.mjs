// SPDX-License-Identifier: MIT
import {reconstructRGB, reconstructYCbCr, toRGBA} from './reconstruct-planes.mjs';
import {ssimulacra2Reference} from './ssimulacra2.mjs';
import {captureLinearPlanes} from './capture-kernels.mjs';
import {photoNativeScores} from './photo-native-scores.mjs';
import {P3_TRANSFORM, linearFromTransformPlanes} from './color-transform.mjs';
import {photoReference} from './photo-reference.mjs';
import {gammaRGBA, nativeRGBA, nativeGammaRGBA} from './photo-output.mjs';
import {measuredTarget, djxlResidual} from './photo-browser-margin.mjs';
import {askedLook, measuredLook} from './photo-quality-table.mjs';
import {fault} from './fault.mjs';

const check = signal => { if (signal?.aborted) throw signal.reason; };

export const PHOTO_PAD_SIDE = 256;
export const PHOTO_REGION_OFFSETS = Object.freeze([
  [0.50, 6.27, 4.21, 2.46],
  [0.60, 5.81, 3.44, 2.77],
  [0.70, 5.00, 3.37, 2.22],
  [0.80, 3.33, 3.13, 1.85],
  [0.85, 2.00, 2.37, 1.77],
  [0.90, 0.39, 1.35, 0.99],
  [0.92, 0.21, 1.294, 0.922],
].map(Object.freeze));
export function photoRegionTarget(quality, side = PHOTO_PAD_SIDE, measured = false) {
  const base = measured ? measuredLook(quality) : askedLook(quality);
  if (quality >= 1 || !(side < PHOTO_PAD_SIDE)) return base;
  const col = (side < 64 ? 0 : side < 128 ? 1 : 2) + 1, rows = PHOTO_REGION_OFFSETS;
  if (quality <= rows[0][0]) return Math.min(100, base + rows[0][col]);
  if (quality >= rows[rows.length - 1][0]) return Math.min(100, base + rows[rows.length - 1][col]);
  let i = 0;
  while (i + 2 < rows.length && quality >= rows[i + 1][0]) i++;
  const [q0] = rows[i], [q1] = rows[i + 1], v0 = rows[i][col], v1 = rows[i + 1][col];
  return Math.min(100, base + v0 + (v1 - v0) * (quality - q0) / (q1 - q0));
}
export function padPhotoCrop(src, w, h, side = PHOTO_PAD_SIDE) {
  const pw = Math.max(side, w), ph = Math.max(side, h);
  if (pw === w && ph === h) return {rgba: src, width: w, height: h};
  const ox = (pw - w) >> 1, oy = (ph - h) >> 1;
  const out = new Uint32Array(pw * ph);
  const s32 = src.byteOffset & 3 ? new Uint32Array(src.slice().buffer) : new Uint32Array(src.buffer, src.byteOffset, w * h);
  const fold = (i, n) => {
    if (n <= 1) return 0;
    const p = 2 * n;
    i = ((i % p) + p) % p;
    return i < n ? i : p - 1 - i;
  };
  const xMap = new Int32Array(pw);
  for (let x = 0; x < pw; x++) xMap[x] = fold(x - ox, w);
  for (let y = 0; y < ph; y++) {
    const sy = fold(y - oy, h) * w, dy = y * pw;
    for (let x = 0; x < pw; x++) out[dy + x] = s32[sy + xMap[x]];
  }
  return {rgba: new Uint8Array(out.buffer), width: pw, height: ph};
}

export function gammaPicture(image, {reference, exact, pixels, mask}) {
  const n = image.width * image.height;
  image = image.lazyStrategy ? image.lazyStrategy.materialize() : image;
  const planes = (image.ycbcr ? reconstructYCbCr : reconstructRGB)(image, {planes: true});
  for (let p = 0; p < n; p++) if (exact?.[p] || mask && pixels[p * 4 + 3] < 128)
    for (let c = 0; c < 3; c++) planes[c][p] = reference[p * 4 + c] / 255;
  return planes;
}
export function linearPicture(image, options, gamma = null) {
  const planes = gamma ?? gammaPicture(image, options);
  return options.colorSpace === 'display-p3' ? linearFromTransformPlanes(planes, image.width * image.height, P3_TRANSFORM)
    : captureLinearPlanes(planes);
}
export function* pictureOutputs(image, options, origin, gamma = null) {
  if (options.colorSpace === 'display-p3') {
    const linear = linearPicture(image, options, gamma);
    yield {kind: 'package', rgba: toRGBA(linear, image.width, image.height)};
    yield {kind: 'native', rgba: nativeRGBA(linear, image.width, image.height, origin)};
  } else {
    const planes = gamma ?? gammaPicture(image, options);
    yield {kind: 'package', rgba: gammaRGBA(planes, image.width, image.height)};
    yield {kind: 'native', rgba: nativeGammaRGBA(planes, image.width, image.height, origin)};
  }
}
const clip = (r, width, height) => {
  const x = Math.max(0, r.x), y = Math.max(0, r.y);
  return {x, y, width: Math.min(width, r.x + r.width) - x, height: Math.min(height, r.y + r.height) - y};
};
export function cropGuard(width, height, crops, intent, mask, project, signal, colorSpace, origin = {x: 0, y: 0}, look = undefined, readingArithmetic) {
  const seen = new Set(), measured = [];
  const checks = (crops?.length ? crops : [{x: 0, y: 0, width, height}]).map(r => clip(r, width, height))
    .filter(r => {
      if (r.width < 8 || r.height < 8) return false;
      const key = [r.x, r.y, r.width, r.height].join(',');
      if (seen.has(key)) return false;
      seen.add(key); return true;
    }).map(r => ({...r, data: null, done: false, nextRow: r.y}));
  let failed = checks.length === 0, missed = false, held = 0;
  const pictures = intent === undefined ? 5 : 3;
  const clear = () => { held = 0; for (const r of checks) r.data = null; };
  const add = (pixels, image, plain, top, reference = pixels, exact = null) => {
    if (failed) return;
    const current = checks.filter(r => !r.done && r.y < top + image.height && r.y + r.height > top);
    if (!current.length) return;
    for (const r of current) {
      if (Math.max(top, r.y) !== r.nextRow) { failed = true; clear(); return; }
    }
    const options = {colorSpace, reference, exact, pixels, mask}, position = {x: origin.x, y: origin.y + top};
    for (const r of current) {
      check(signal);
      if (!r.data) {
        const size = r.width * r.height * 4;
        r.data = Array.from({length: pictures}, () => new Uint8Array(size)); held += size * pictures;
      }
    }
    const copy = (rgba, index) => {
      for (const r of current) {
        check(signal);
        const y0 = Math.max(top, r.y), y1 = Math.min(top + image.height, r.y + r.height);
        for (let y = y0; y < y1; y++) {
          const from = ((y - top) * width + r.x) * 4, to = ((y - r.y) * r.width) * 4;
          r.data[index].set(rgba.subarray(from, from + r.width * 4), to);
        }
      }
    };
    copy(reference, 0);
    for (const output of pictureOutputs(image, options, position)) copy(output.rgba, output.kind === 'package' ? 1 : 2);
    if (intent === undefined)
      for (const output of pictureOutputs(plain, options, position)) copy(output.rgba, output.kind === 'package' ? 3 : 4);
    for (const r of current) {
      check(signal);
      const y1 = Math.min(top + image.height, r.y + r.height);
      r.nextRow = y1;
      if (y1 === r.y + r.height) {
        const refPad = padPhotoCrop(r.data[0], r.width, r.height);
        const n = refPad.width * refPad.height;
        const ref = photoReference(refPad.rgba, refPad.width, refPad.height, colorSpace === 'display-p3' ? P3_TRANSFORM : null);
        let own = Infinity, threshold = -Infinity;
        for (const arithmetic of readingArithmetic && readingArithmetic !== 'binary64' ? ['binary64', readingArithmetic] : ['binary64']) {
          const prepared = ssimulacra2Reference(ref, refPad.width, refPad.height,
            {immutable: true, cacheBytes: Math.min(16 << 20, n * 48), arithmetic});
          const score = first => {
            const scores = photoNativeScores({outputs: [
              {kind: 'package', rgba: padPhotoCrop(r.data[first], r.width, r.height).rgba},
              {kind: 'native', rgba: padPhotoCrop(r.data[first + 1], r.width, r.height).rgba},
            ]}, null, refPad.width, refPad.height, {reference: prepared});
            return look === undefined ? scores.minimum : Math.min(scores.package, scores.native - djxlResidual(scores.native, n));
          };
          try {
            own = Math.min(own, score(1));
            threshold = Math.max(threshold, intent === undefined ? score(3) : measuredTarget(photoRegionTarget(intent, Math.min(r.width, r.height), true)));
          } finally { prepared.release(); }
        }
        if (!(own >= threshold)) missed = true;
        measured.push({metric: 'ssimulacra2', score: own, floor: threshold, domain: 'encoder-reconstruction',
          region: {x: origin.x + r.x, y: origin.y + r.y, width: r.width, height: r.height}});
        held -= r.data[0].length * pictures; r.data = null; r.done = true;
      }
    }
    if (failed) clear();
  };
  const state = () => ({checks, failed, missed, held, measured});
  const restore = saved => {
    if (saved.checks === checks) return;
    checks.splice(0, checks.length, ...saved.checks); measured.splice(0, measured.length, ...saved.measured);
    failed = saved.failed; missed = saved.missed ?? false; held = saved.held;
  };
  return {add, passed: () => !failed && !missed, complete: () => !failed && !missed && checks.every(r => r.done), measurements: () => measured, state, restore};
}

function dct8Band(image, top, height) {
  const stride = image.components[0].stride, first = top / 8 * stride, count = Math.ceil(height / 8) * stride;
  const {cfl} = image;
  return {...image, height,
    components: image.components.map(c => ({...c, rows: Math.ceil(height / 8),
      coeffs: c.coeffs.subarray(first * 64, (first + count) * 64),
      ...(c.dc && {dc: c.dc.subarray(first, first + count)})})),
    quantFields: image.quantFields?.subarray(first, first + count),
    alpha: image.alpha?.subarray(top * image.width * 4, (top + height) * image.width * 4),
    ...(cfl && {cfl: {...cfl,
      x: cfl.x.subarray(top / 64 * cfl.width, Math.ceil((top + height) / 64) * cfl.width),
      b: cfl.b.subarray(top / 64 * cfl.width, Math.ceil((top + height) / 64) * cfl.width)}})};
}
export function qualifyPhotoImage(image, {rows, referenceRows = rows, exactRows = null, crops, readingIntent: intent, readingLook, readingArithmetic,
  mask = false, project = null, signal, colorSpace, origin = {x: 0, y: 0}}) {
  if (image.strategyData || image.lazyStrategy) throw fault('JXL_INTERNAL', 'An existing photo floor must be DCT8.');
  const {width, height} = image, guard = cropGuard(width, height, crops, intent, mask, project, signal, colorSpace, origin, readingLook, readingArithmetic);
  for (let top = 0; top < height && guard.passed(); top += 256) {
    check(signal);
    const count = Math.min(256, height - top), sub = dct8Band(image, top, count);
    guard.add(rows(top, count), sub, sub, top, referenceRows(top, count), exactRows?.(top, count));
  }
  return {passed: guard.complete(), measurements: guard.measurements()};
}
