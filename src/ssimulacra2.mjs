// SPDX-License-Identifier: MIT
import {exactPow} from './exact-math.mjs';
import {fault} from './fault.mjs';
import {S2_WEIGHTS, finalCurve} from './ssimulacra2-weights.mjs';
import {GAUSS} from './ssimulacra2-constants.mjs';
import {S2_REFERENCE, SCALES, s2Colors} from './ssimulacra2-reference.mjs';
import {s2Dimensions, s2Samples, s2Pad} from './ssimulacra2-input.mjs';
import {gaussianCoefficients, downsample as down, scaleSums, openMetricArena, referenceArena, useReferenceArena} from './ssimulacra2-arithmetic.mjs';
export {ssimulacra2Reference} from './ssimulacra2-reference.mjs';
export {recursiveGaussian, gaussianTaps} from './ssimulacra2-gaussian.mjs';
export {finalCurve};
export {S2_WEIGHTS as SSIMULACRA2_WEIGHTS};
export const GAUSS32 = gaussianCoefficients(GAUSS);

export function scaleNorm(per,c,sums,n) {
  const [ss1,ss4,a1,a4,l1,l4] = sums, inverse = 1 / n, mean = value => inverse * value;
  per.ssim[c * 2] = mean(ss1); per.ssim[c * 2 + 1] = Math.sqrt(Math.sqrt(mean(ss4)));
  per.edge[c * 4] = mean(a1); per.edge[c * 4 + 1] = Math.sqrt(Math.sqrt(mean(a4)));
  per.edge[c * 4 + 2] = mean(l1); per.edge[c * 4 + 3] = Math.sqrt(Math.sqrt(mean(l4)));
}
export function scoreNorms(norms) {
  let sum = 0, i = 0;
  for (let c = 0; c < 3; c++) for (let s = 0; s < norms.length; s++) for (let k = 0; k < 2; k++) {
    sum += S2_WEIGHTS[i++] * Math.abs(norms[s].ssim[c * 2 + k]);
    sum += S2_WEIGHTS[i++] * Math.abs(norms[s].edge[c * 4 + k]);
    sum += S2_WEIGHTS[i++] * Math.abs(norms[s].edge[c * 4 + k + 2]);
  }
  const score = finalCurve(sum);
  if (!Number.isFinite(score)) throw fault('JXL_INPUT','SSIMULACRA2 samples exceed the metric arithmetic range.');
  return {score,sum};
}

export const SRGB_TO_LINEAR = Float64Array.from({length: 256}, (_, i) => {
  const v = i / 255; return v <= 0.04045 ? v / 12.92 : exactPow((v + 0.055) / 1.055, 2.4);
});
export function srgbToLinear(v) {
  const a = Math.abs(v), l = a <= 0.04045 ? a / 12.92 : exactPow((a + 0.055) / 1.055, 2.4);
  return v < 0 ? -l : l;
}

export function linearFromRGBA(rgba, pixels) {
  const planes = [new Float64Array(pixels), new Float64Array(pixels), new Float64Array(pixels)];
  for (let i = 0; i < pixels; i++) for (let c = 0; c < 3; c++) planes[c][i] = SRGB_TO_LINEAR[rgba[i * 4 + c]];
  return planes;
}


export function downsample(input,width,height) {
  const close = openMetricArena();
  try { return down(input,width,height); } finally { close(); }
}

export function ssimulacra2(reference, distorted, width, height, {wantMap = false} = {}) {
  const pixels = s2Dimensions(width, height), originalWidth = width, originalHeight = height;
  const fixed = reference?.[S2_REFERENCE];
  if (fixed && (fixed.width !== width || fixed.height !== height)) {
    throw new RangeError('SSIMULACRA2 reference size differs.');
  }
  if (fixed?.busy) throw new Error('SSIMULACRA2 reference is already in use.');
  if (fixed?.released) throw new Error('SSIMULACRA2 reference is released.');
  let lastSourceScale = -1;
  if (fixed) for (let s = 0; s < fixed.scales.length; s++) if (!fixed.scales[s] || fixed.scales[s].length < 3) lastSourceScale = s;
  let a = reference, b = distorted;
  if (fixed && !fixed.arena && fixed.scales.some(Boolean)) fixed.arena = referenceArena(fixed.sizes);
  const close = fixed?.arena ? useReferenceArena(fixed.arena) : openMetricArena();
  if (fixed) fixed.busy = true;
  try {
    if (fixed) a = lastSourceScale < 0 ? null : typeof fixed.reference === 'function' ? fixed.reference() : fixed.reference;
    if (!fixed || lastSourceScale >= 0) a = s2Pad(s2Samples(a, pixels), width, height);
    b = s2Pad(s2Samples(b, pixels), width, height);
    width = Math.max(8, width); height = Math.max(8, height);
    let w = width, h = height;
    const norms = [], map = wantMap ? new Float64Array(width * height) : null, colors = a?.rgba || b?.rgba ? s2Colors() : null;
    let scales = 0;
    for (let sw = width, sh = height; scales < SCALES; scales++) {
      if (sw < 8 || sh < 8) break;
      if (scales) { sw = (sw + 1) >> 1; sh = (sh + 1) >> 1; }
    }
    const pyramid = {a: [null, null], b: [null, null]}, half = ((width + 1) >> 1) * ((height + 1) >> 1);
    const Plane = Float32Array;
    const level = (set, s, n) => set[s & 1] ??= [new Plane(n), new Plane(n), new Plane(n)];
    const termPlanes = wantMap ? {d: new Float64Array(width * height), dd: new Float64Array(width * height)} : null;
    let sharePlane = null;
    for (let scale = 0; scale < SCALES; scale++) {
      if (w < 8 || h < 8) break;
      if (scale) {
        const n = ((w + 1) >> 1) * ((h + 1) >> 1);
        if (a) a = down(a, w, h, level(pyramid.a, scale, n)).planes;
        const db = down(b, w, h, level(pyramid.b, scale, n)); b = db.planes; w = db.width; h = db.height;
      }
      const n = w * h, per = {ssim: new Float64Array(6), edge: new Float64Array(12)};
      const channels = fixed?.scales[scale];
      const share = wantMap ? scale ? (sharePlane ??= new Float64Array(half)).subarray(0, n).fill(0) : map : null;
      const terms = wantMap ? {d: termPlanes.d.subarray(0, n), dd: termPlanes.dd.subarray(0, n)} : null;
      const sums = wantMap ? null : scaleSums(a, b, w, h, GAUSS32, channels, !!channels, colors, null, null, scale);
      for (let c = 0; c < 3; c++) {
        const result = sums ? sums[c] : scaleSums(a, b, w, h, GAUSS32, channels, !!channels, colors, c, terms, scale)[c];
        if (result.reference) {
          channels[c] = result.reference;
          fixed.cacheBytes += result.reference.bytes;
        }
        scaleNorm(per,c,result.sums,n);
        if (wantMap) shareChannel(share, n, scales, scale, c, per, terms);
      }
      if (fixed && scale === lastSourceScale) a = null;
      norms.push(per);
      if (wantMap && scale) spreadScale(map, width, height, scale, w, h, share);
    }
    const {score,sum} = scoreNorms(norms);
    if (fixed && fixed.scales.every(channels => channels?.length === 3)) { fixed.reference = null; fixed.inputBytes = 0; }
    let resultMap = map;
    if (map && (originalWidth !== width || originalHeight !== height)) {
      resultMap = new Float64Array(pixels);
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++)
        resultMap[Math.min(y, originalHeight - 1) * originalWidth + Math.min(x, originalWidth - 1)] += map[y * width + x];
    }
    return {score, sum, norms, map: resultMap};
  } finally {
    a = null; b = null;
    if (fixed) fixed.busy = false;
    close();
  }
}


function shareChannel(share, n, scales, s, c, per, {d, dd}) {
  const base = c * scales * 6 + s * 6, wt = k => S2_WEIGHTS[base + k];
  const terms = [[0, wt(0), wt(3), per.ssim[c * 2 + 1]], [1, wt(1), wt(4), per.edge[c * 4 + 1]], [-1, wt(2), wt(5), per.edge[c * 4 + 3]]];
  for (const [sign, w1, w4, norm4] of terms) {
    if (!w1 && !w4) continue;
    const k4 = norm4 > 0 ? w4 / (n * norm4 * norm4 * norm4) : 0;
    if (sign === 0) for (let i = 0; i < n; i++) { const v = d[i]; share[i] += w1 / n * v + k4 * v * v * v * v; }
    else if (sign > 0) for (let i = 0; i < n; i++) { const v = Math.max(dd[i], 0); share[i] += w1 / n * v + k4 * v * v * v * v; }
    else for (let i = 0; i < n; i++) { const v = Math.max(-dd[i], 0); share[i] += w1 / n * v + k4 * v * v * v * v; }
  }
}
function spreadScale(map, width, height, s, w, h, share) {
  const f = 1 << s;
  for (let y = 0; y < height; y++) {
    const sy = Math.min(h - 1, y >> s);
    for (let x = 0; x < width; x++) map[y * width + x] += share[sy * w + Math.min(w - 1, x >> s)] / (f * f);
  }
}

