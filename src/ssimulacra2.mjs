// SPDX-License-Identifier: MIT
import {fault} from './fault.mjs';
import {srgbLevels} from './srgb-levels.mjs';
import {linearFromTransform} from './color-bytes.mjs';
import {S2_WEIGHTS, finalCurve} from './ssimulacra2-weights.mjs';
import {GAUSS} from './ssimulacra2-constants.mjs';
import {S2_REFERENCE, SCALES} from './ssimulacra2-reference.mjs';
import {s2Dimensions, s2Samples, s2Pad} from './ssimulacra2-input.mjs';
import {gaussianCoefficients, downsample as down, scaleComplete, scaleSums, scoreBands, scoreScale0Bands, openMetricArena, referenceArena, useReferenceArena} from './ssimulacra2-arithmetic.mjs';
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

export const s2Weight = (c, s, k, t, scales, toolWeights) => S2_WEIGHTS[toolWeights ? c * scales * 6 + s * 6 + 3 * k + t : c * 36 + s * 6 + 3 * k + t];
export function scoreNorms(norms, toolWeights = false) {
  let sum = 0;
  const n = norms.length;
  for (let c = 0; c < 3; c++) for (let s = 0; s < n; s++) for (let k = 0; k < 2; k++) {
    sum += s2Weight(c, s, k, 0, n, toolWeights) * Math.abs(norms[s].ssim[c * 2 + k]);
    sum += s2Weight(c, s, k, 1, n, toolWeights) * Math.abs(norms[s].edge[c * 4 + k]);
    sum += s2Weight(c, s, k, 2, n, toolWeights) * Math.abs(norms[s].edge[c * 4 + k + 2]);
  }
  const score = finalCurve(sum);
  if (!Number.isFinite(sum) || !Number.isFinite(score)) throw fault('JXL_INPUT','samples: overflow');
  return {score,sum};
}

let SRGB_TRANSFORM = null;
export function linearFromRGBA(rgba, pixels) {
  if (pixels === 0) return [new Float64Array(0), new Float64Array(0), new Float64Array(0)];
  const levels = srgbLevels();
  return linearFromTransform(new Uint8Array(rgba.buffer, rgba.byteOffset, pixels * 4), pixels, SRGB_TRANSFORM ??= {lms: null, tables: [levels, levels, levels]});
}

export function downsample(input,width,height) {
  const close = openMetricArena();
  try { return down(input,width,height); } finally { close(); }
}

const ZERO_PER = {ssim: new Float64Array(6), edge: new Float64Array(12)};
const normsFromBandResults = list => list.map(({n, sums}) => {
  const per = {ssim: new Float64Array(6), edge: new Float64Array(12)};
  for (let c = 0; c < 3; c++) scaleNorm(per, c, sums.subarray(c * 6, c * 6 + 6), n);
  return per;
});

export function ssimulacra2(reference, distorted, width, height, options = {}) {
  for (const key of Object.keys(options ?? {})) if (key !== 'wantMap' && key !== 'arithmetic')
    throw fault('JXL_OPTIONS', 'unknown option: ' + key);
  let {wantMap = false, arithmetic} = options ?? {};
  if ((typeof __RAPIER_JXL_CAPTURE_PHOTO__ !== 'undefined' && __RAPIER_JXL_CAPTURE_PHOTO__ === true)) wantMap = false;
  return scoreOne(reference, distorted, width, height, wantMap, arithmetic, false);
}

export function ssimulacra2Score(reference, distorted, width, height, arithmetic, options = null) {
  return scoreOne(reference, distorted, width, height, false, arithmetic, true, options);
}

function openS2(reference, width, height, arithmetic) {
  const pixels = s2Dimensions(width, height), fixed = reference?.[S2_REFERENCE];
  arithmetic ??= fixed?.arithmetic ?? 'binary64';
  if (arithmetic !== 'binary64' && arithmetic !== 'libjxl') throw fault('JXL_INPUT', 'arithmetic: binary64 or libjxl');
  if (fixed && arithmetic !== fixed.arithmetic) throw fault('JXL_INPUT', 'arithmetic: reference mismatch');
  if (fixed && (fixed.width !== width || fixed.height !== height)) throw fault('JXL_INTERNAL', 'ssimulacra2:size');
  if (fixed?.busy) throw fault('JXL_INTERNAL', 'ssimulacra2:busy');
  if (fixed?.released) throw fault('JXL_INTERNAL', 'ssimulacra2:released');
  let needRef = !fixed;
  if (fixed) for (let i = 0; i < fixed.scales.length; i++) if (!scaleComplete(fixed.scales[i])) { needRef = true; break; }
  if (fixed && !fixed.arena && fixed.scales.some(Boolean)) fixed.arena = referenceArena(fixed.sizes);
  const close = fixed?.arena ? useReferenceArena(fixed.arena) : openMetricArena();
  if (fixed) fixed.busy = true;
  return {pixels, fixed, libjxl: arithmetic === 'libjxl', needRef, close};
}
function loadS2Ref(reference, fixed, needRef, pixels, width, height) {
  const raw = fixed ? (!needRef ? null : typeof fixed.reference === 'function' ? fixed.reference() : fixed.reference) : reference;
  return needRef ? s2Pad(s2Samples(raw, pixels), width, height) : raw;
}
function countS2Scales(width, height) {
  let scales = 0;
  for (let sw = width, sh = height; scales < SCALES && sw >= 8 && sh >= 8; scales++) if (scales) { sw = (sw + 1) >> 1; sh = (sh + 1) >> 1; }
  return scales;
}
function keepRefChannel(fixed, channels, c, res) {
  if (!res.reference) return;
  if (channels[c]) fixed.cacheBytes -= channels[c].bytes;
  channels[c] = res.reference;
  fixed.cacheBytes += res.reference.bytes;
}
function settleS2Ref(fixed) {
  if (fixed && fixed.scales.every(scaleComplete)) { fixed.reference = null; fixed.inputBytes = 0; }
}

function scoreOne(reference, distorted, width, height, wantMap, arithmetic, allowSparse0, extra = null) {
  const originalWidth = width, originalHeight = height, minScore = extra?.minScore;
  const {pixels, fixed, libjxl, needRef, close} = openS2(reference, width, height, arithmetic);
  let a = null, b = distorted;
  try {
    a = loadS2Ref(reference, fixed, needRef, pixels, width, height);
    b = s2Pad(s2Samples(b, pixels), width, height);
    width = Math.max(8, width); height = Math.max(8, height);
    const scales = countS2Scales(width, height);
    const sparse0 = allowSparse0 && !wantMap && scales === SCALES;
    if (!wantMap && minScore !== undefined && scales === SCALES) {
      const coarseNorms = normsFromBandResults(scoreBands(a, b, null, width, height, GAUSS32, fixed, libjxl, false, 1));
      const upperCoarse = scoreNorms([ZERO_PER, ...coarseNorms]).score + 1e-11;
      if (upperCoarse < minScore) {
        return {score: upperCoarse - 1e-11, sum: 0, norms: [ZERO_PER, ...coarseNorms], map: null, skippedScale0: true};
      }
      const ch0 = fixed?.scales[0], keep0 = fixed ? fixed.sizes[0].keep : false, n0 = width * height;
      const canStageY = !libjxl && (scaleComplete(ch0) || keep0 !== true);
      if (canStageY) {
        const ySums = scoreScale0Bands(scaleComplete(ch0) ? null : a, b, null, width, height, GAUSS32, fixed, false, true, true);
        const perY = {ssim: new Float64Array(6), edge: new Float64Array(12)};
        scaleNorm(perY, 1, ySums.subarray(6, 12), n0);
        const upperY = scoreNorms([perY, ...coarseNorms]).score + 1e-11;
        if (upperY < minScore) {
          settleS2Ref(fixed);
          return {score: upperY - 1e-11, sum: 0, norms: [perY, ...coarseNorms], map: null, skippedChroma0: true};
        }
        const xbSums = scoreScale0Bands(scaleComplete(ch0) ? null : a, b, null, width, height, GAUSS32, fixed, false, true, false, 5);
        for (const c of [0, 2]) scaleNorm(perY, c, xbSums.subarray(c * 6, c * 6 + 6), n0);
        const norms = [perY, ...coarseNorms], {score, sum} = scoreNorms(norms);
        settleS2Ref(fixed);
        return {score, sum, norms, map: null};
      }
      const useSparse = sparse0 && (scaleComplete(ch0) || keep0 !== true);
      const sums0 = scoreScale0Bands(scaleComplete(ch0) ? null : a, b, null, width, height, GAUSS32, fixed, libjxl, useSparse);
      const per0 = {ssim: new Float64Array(6), edge: new Float64Array(12)};
      for (let c = 0; c < 3; c++) scaleNorm(per0, c, sums0.subarray(c * 6, c * 6 + 6), n0);
      const norms = [per0, ...coarseNorms], {score, sum} = scoreNorms(norms);
      settleS2Ref(fixed);
      return {score, sum, norms, map: null};
    }

    if (!wantMap) {
      const norms = normsFromBandResults(scoreBands(a, b, null, width, height, GAUSS32, fixed, libjxl, sparse0, 0));
      const {score, sum} = scoreNorms(norms);
      if (fixed && fixed.scales.every(scaleComplete)) { fixed.reference = null; fixed.inputBytes = 0; }
      return {score, sum, norms, map: null};
    }

    let w = width, h = height;
    const norms = [], map = new Float64Array(width * height);
    const pyramid = {a: [null, null], b: [null, null]}, half = ((width + 1) >> 1) * ((height + 1) >> 1);
    const level = (set, s, n) => set[s & 1] ??= [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
    const termPlanes = {d: new Float64Array(width * height), dd: new Float64Array(width * height)};
    let sharePlane = null, lastSourceScale = -1;
    if (fixed) for (let s = 0; s < fixed.scales.length; s++) if (!scaleComplete(fixed.scales[s])) lastSourceScale = s;
    for (let scale = 0; scale < SCALES; scale++) {
      if (w < 8 || h < 8) break;
      if (scale) {
        const n = ((w + 1) >> 1) * ((h + 1) >> 1);
        if (a) a = down(a, w, h, level(pyramid.a, scale, n), libjxl).planes;
        const db = down(b, w, h, level(pyramid.b, scale, n), libjxl); b = db.planes; w = db.width; h = db.height;
      }
      const n = w * h, per = {ssim: new Float64Array(6), edge: new Float64Array(12)};
      const channels = fixed?.scales[scale], keepMode = fixed ? fixed.sizes[scale].keep : false;
      const refArg = scaleComplete(channels) ? null : a;
      const share = scale ? (sharePlane ??= new Float64Array(half)).subarray(0, n).fill(0) : map;
      const terms = {d: termPlanes.d.subarray(0, n), dd: termPlanes.dd.subarray(0, n)};
      for (let c = 0; c < 3; c++) {
        const result = scaleSums(refArg, b, w, h, GAUSS32, channels, keepMode, null, c, terms, scale, libjxl, false)[c];
        keepRefChannel(fixed, channels, c, result);
        scaleNorm(per, c, result.sums, n);
        shareChannel(share, n, scales, scale, c, per, terms);
      }
      if (fixed && scale === lastSourceScale) a = null;
      norms.push(per);
      if (scale) spreadScale(map, width, height, scale, w, h, share);
    }
    const {score,sum} = scoreNorms(norms);
    settleS2Ref(fixed);
    let resultMap = map;
    if (originalWidth !== width || originalHeight !== height) {
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

export function ssimulacra2Pair(reference, distorted0, distorted1, width, height, options = {}) {
  const {minScore} = options;
  const {pixels, fixed, libjxl, needRef, close} = openS2(reference, width, height, options.arithmetic);
  let a = null, b0 = distorted0, b1 = distorted1;
  try {
    a = loadS2Ref(reference, fixed, needRef, pixels, width, height);
    b0 = s2Pad(s2Samples(b0, pixels), width, height);
    b1 = s2Pad(s2Samples(b1, pixels), width, height);
    width = Math.max(8, width); height = Math.max(8, height);
    const scales = countS2Scales(width, height);
    const sparse0 = scales === SCALES;

    if (scales === SCALES && minScore !== undefined) {
      const [cRes0, cRes1] = scoreBands(a, b0, b1, width, height, GAUSS32, fixed, libjxl, false, 1);
      const coarse0 = normsFromBandResults(cRes0), coarse1 = normsFromBandResults(cRes1);
      const hi0 = scoreNorms([ZERO_PER, ...coarse0]).score + 1e-11;
      const hi1 = scoreNorms([ZERO_PER, ...coarse1]).score + 1e-11;
      if (Math.min(hi0, hi1) < minScore) {
        const out = [{score: hi0 - 1e-11, sum: 0}, {score: hi1 - 1e-11, sum: 0}];
        out.skippedScale0 = true;
        return out;
      }
      const ch0 = fixed?.scales[0], keep0 = fixed ? fixed.sizes[0].keep : false, n0 = width * height;
      if (!libjxl && (scaleComplete(ch0) || keep0 !== true)) {
        const [y0, y1] = scoreScale0Bands(scaleComplete(ch0) ? null : a, b0, b1, width, height, GAUSS32, fixed, false, true, true);
        const per0 = {ssim: new Float64Array(6), edge: new Float64Array(12)};
        const per1 = {ssim: new Float64Array(6), edge: new Float64Array(12)};
        scaleNorm(per0, 1, y0.subarray(6, 12), n0);
        scaleNorm(per1, 1, y1.subarray(6, 12), n0);
        const up0 = scoreNorms([per0, ...coarse0]).score + 1e-11;
        const up1 = scoreNorms([per1, ...coarse1]).score + 1e-11;
        if (Math.min(up0, up1) < minScore) {
          settleS2Ref(fixed);
          const out = [{score: up0 - 1e-11, sum: 0}, {score: up1 - 1e-11, sum: 0}];
          out.skippedChroma0 = true;
          return out;
        }
        const [xb0, xb1] = scoreScale0Bands(scaleComplete(ch0) ? null : a, b0, b1, width, height, GAUSS32, fixed, false, true, false, 5);
        for (const c of [0, 2]) {
          scaleNorm(per0, c, xb0.subarray(c * 6, c * 6 + 6), n0);
          scaleNorm(per1, c, xb1.subarray(c * 6, c * 6 + 6), n0);
        }
        settleS2Ref(fixed);
        return [scoreNorms([per0, ...coarse0]), scoreNorms([per1, ...coarse1])];
      }
      const useSparse = sparse0 && (scaleComplete(ch0) || keep0 !== true);
      const [s0, s1] = scoreScale0Bands(scaleComplete(ch0) ? null : a, b0, b1, width, height, GAUSS32, fixed, libjxl, useSparse);
      const per0 = {ssim: new Float64Array(6), edge: new Float64Array(12)};
      const per1 = {ssim: new Float64Array(6), edge: new Float64Array(12)};
      for (let c = 0; c < 3; c++) {
        scaleNorm(per0, c, s0.subarray(c * 6, c * 6 + 6), n0);
        scaleNorm(per1, c, s1.subarray(c * 6, c * 6 + 6), n0);
      }
      settleS2Ref(fixed);
      return [scoreNorms([per0, ...coarse0]), scoreNorms([per1, ...coarse1])];
    }

    const [res0, res1] = scoreBands(a, b0, b1, width, height, GAUSS32, fixed, libjxl, sparse0, 0);
    const out = [scoreNorms(normsFromBandResults(res0)), scoreNorms(normsFromBandResults(res1))];
    if (fixed && fixed.scales.every(scaleComplete)) { fixed.reference = null; fixed.inputBytes = 0; }
    return out;
  } finally {
    a = null; b0 = null; b1 = null;
    if (fixed) fixed.busy = false;
    close();
  }
}

function shareChannel(share, n, scales, s, c, per, {d, dd}) {
  const wt = k => s2Weight(c, s, k > 2 ? 1 : 0, k % 3, scales, false);
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
