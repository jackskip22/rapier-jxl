// SPDX-License-Identifier: MIT
import {reconstructRGB, reconstructYCbCr, toRGBA} from './reconstruct-planes.mjs';
import {srgbToLinear, ssimulacra2Reference} from './ssimulacra2.mjs';
import {photoNativeScores} from './photo-native-scores.mjs';
import {P3_TRANSFORM, linearFromTransformPlanes} from './color-transform.mjs';
import {photoReference} from './photo-reference.mjs';
import {gammaRGBA, nativeRGBA, nativeGammaRGBA} from './photo-output.mjs';
import {webpTarget} from './photo-quality-table.mjs';

const check = signal => { if (signal?.aborted) throw signal.reason; };

export function gammaPicture(image, {reference, exact, pixels, mask}) {
  const n = image.width * image.height;
  image = image.lazyStrategy ? image.lazyStrategy.materialize() : image;
  const planes = (image.ycbcr ? reconstructYCbCr : reconstructRGB)(image, {planes: true});
  for (let p = 0; p < n; p++) if (exact?.[p] || mask && pixels[p * 4 + 3] < 128)
    for (let c = 0; c < 3; c++) planes[c][p] = reference[p * 4 + c] / 255;
  return planes;
}
export function linearPicture(image, options) {
  const planes = gammaPicture(image, options);
  return options.colorSpace === 'display-p3' ? linearFromTransformPlanes(planes, image.width * image.height, P3_TRANSFORM)
    : planes.map(p => Float64Array.from(p, srgbToLinear));
}
export function* pictureOutputs(image, options, origin) {
  if (options.colorSpace === 'display-p3') {
    const linear = linearPicture(image, options);
    yield {kind: 'package', rgba: toRGBA(linear, image.width, image.height)};
    yield {kind: 'native', rgba: nativeRGBA(linear, image.width, image.height, origin)};
  } else {
    const gamma = gammaPicture(image, options);
    yield {kind: 'package', rgba: gammaRGBA(gamma, image.width, image.height)};
    yield {kind: 'native', rgba: nativeGammaRGBA(gamma, image.width, image.height, origin)};
  }
}
const clip = (r, width, height) => {
  const x = Math.max(0, r.x), y = Math.max(0, r.y);
  return {x, y, width: Math.min(width, r.x + r.width) - x, height: Math.min(height, r.y + r.height) - y};
};
export function cropGuard(width, height, crops, webp, mask, project, signal, colorSpace, origin = {x: 0, y: 0}) {
  const seen = new Set(), measured = [];
  const checks = (crops?.length ? crops : [{x: 0, y: 0, width, height}]).map(r => clip(r, width, height))
    .filter(r => {
      if (r.width < 8 || r.height < 8) return false;
      const key = [r.x, r.y, r.width, r.height].join(',');
      if (seen.has(key)) return false;
      seen.add(key); return true;
    }).map(r => ({...r, data: null, done: false, nextRow: r.y}));
  let failed = checks.length === 0, missed = false, held = 0;
  const limit = 128 << 20, pictures = webp === undefined ? 5 : 3;
  const clear = () => { held = 0; for (const r of checks) r.data = null; };
  const add = (pixels, image, plain, top, reference = pixels, exact = null) => {
    if (failed) return;
    const current = checks.filter(r => !r.done && r.y < top + image.height && r.y + r.height > top);
    if (!current.length) return;
    let planned = held;
    for (const r of current) {
      if (Math.max(top, r.y) !== r.nextRow) { failed = true; clear(); return; }
      const bytes = r.width * r.height * 4 * pictures;
      if (!r.data) {
        if (planned + bytes > limit) { failed = true; clear(); return; }
        planned += bytes;
      }
      if (r.y + r.height <= top + image.height) planned -= bytes;
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
    if (webp === undefined)
      for (const output of pictureOutputs(plain, options, position)) copy(output.rgba, output.kind === 'package' ? 3 : 4);
    for (const r of current) {
      check(signal);
      const y1 = Math.min(top + image.height, r.y + r.height);
      r.nextRow = y1;
      if (y1 === r.y + r.height) {
        const n = r.width * r.height;
        const ref = photoReference(r.data[0], r.width, r.height, colorSpace === 'display-p3' ? P3_TRANSFORM : null);
        const prepared = ssimulacra2Reference(ref, r.width, r.height,
          {native: true, immutable: true, cacheBytes: Math.min(16 << 20, n * 48)});
        const score = first => photoNativeScores({outputs: [
          {kind: 'package', rgba: r.data[first]}, {kind: 'native', rgba: r.data[first + 1]},
        ]}, null, r.width, r.height, {reference: prepared}).minimum;
        let own, threshold;
        try { own = score(1); threshold = webp === undefined ? score(3) : webpTarget(webp); }
        finally { prepared.release(); }
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
export function qualifyPhotoImage(image, {rows, referenceRows = rows, exactRows = null, crops, readingWebp: webp,
  mask = false, project = null, signal, colorSpace, origin = {x: 0, y: 0}}) {
  if (image.strategyData || image.lazyStrategy) throw new Error('An existing photo floor must be DCT8.');
  const {width, height} = image, guard = cropGuard(width, height, crops, webp, mask, project, signal, colorSpace, origin);
  for (let top = 0; top < height && guard.passed(); top += 256) {
    check(signal);
    const count = Math.min(256, height - top), sub = dct8Band(image, top, count);
    guard.add(rows(top, count), sub, sub, top, referenceRows(top, count), exactRows?.(top, count));
  }
  return {passed: guard.complete(), measurements: guard.measurements()};
}
