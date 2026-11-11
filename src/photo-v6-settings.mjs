// SPDX-License-Identifier: MIT
import {exactPow} from './exact-math.mjs';
import {QUANT_SHAPE} from './photo-dct.mjs';
import {flatSamples} from './screen-samples.mjs';
import {readEach, journalFact, JOIN} from './step-journal.mjs';

const DEFAULT_DCT8 = [[3150.0, 0.0, -0.4, -0.4, -0.4, -2.0], [560.0, 0.0, -0.3, -0.3, -0.3, -0.3], [512.0, -2.0, -1.0, 0.0, -1.0, -2.0]];
function defaultWeight(c, x, y) {
  const p = DEFAULT_DCT8[c], bands = [p[0]];
  for (let i = 1; i < p.length; i++) bands.push(bands[i - 1] * (p[i] > 0 ? 1 + p[i] : 1 / (1 - p[i])));
  const dx = x / 7, dy = y / 7, at = Math.sqrt(dx * dx + dy * dy) * (bands.length - 1) / 1.4142135623730951;
  const i = Math.min(bands.length - 2, Math.floor(at));
  return bands[i] * exactPow(bands[i + 1] / bands[i], at - i);
}
const baseStep = (c, k) => [0.84, 7, 5.6][c] * QUANT_SHAPE[k] * (1 + [1, 0, 5][c] * Math.sqrt(((k & 7) * (k & 7) + (k >> 3) * (k >> 3)) / 98));
let chroma;
function chromaTable() {
  if (!chroma) {
    const luma = (1 / defaultWeight(1, 1, 0)) / baseStep(1, 1);
    chroma = Float64Array.from({length: 192}, (_, i) => {
      const c = i >> 6, k = i & 63; return k ? (1 / defaultWeight(c, k & 7, k >> 3)) / baseStep(c, k) / luma : 1;
    });
  }
  return chroma;
}

export const V6 = {
  tune: (c, k) => {
    const r = Math.sqrt(((k & 7) * (k & 7) + (k >> 3) * (k >> 3)) / 98);
    return chromaTable()[c * 64 + k] * [1.3, 1, 1.675][c] * (1 + [0.45, 0.45, 0][c] * r) * (1 + [-0.15, 0.05, 0][c] * r * r);
  },
  deadzone: [0.72, 0.76, 0.485, 0.575, 0.54, 0.6], epfScale: 3, filterAlways: true, dcScale: [1.675, 1.35, 1.675], cflScale: 0.7,
};
export const SMALL_SIDE = 128;
export const smallPicture = (width, height) => Math.min(width, height) < SMALL_SIDE;
export const SMALL_V6 = {...V6, tune: (c, k) => c === 2 ? 0.5 * baseStep(1, k) * V6.tune(1, k) / baseStep(2, k) : V6.tune(c, k),
  dcScale: [1.675, 1.35, 0.4], deadzone: [0.72, 0.76, 0.485, 0.575, 0.485, 0.575], epfScale: 1.5, smallFloor: true};
export const v6For = (width, height) => smallPicture(width, height) ? SMALL_V6 : V6;
export const GABORISH = {gaborish: {strength: 1, tilt: 1}, epfScale: 2};
const E7_GRAIN = Object.freeze({epfScale: 1.5});
export function grainRegime(data, width, height) {
  const {flatShare, curvature} = grainSample(data, width, height);
  return flatShare < 0.25 && curvature < 0.95 ? E7_GRAIN : null;
}
export function grainSample(data, width, height) {
  let curvature = 0, gradient = 0, flat = 0, total = 0;
  const stepY = Math.max(1, Math.floor((height - 2) / 64)), stepX = Math.max(1, Math.floor((width - 2) / 64)), row = width * 4;
  const luma = i => 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  if (journalFact(data, JOIN)) { const at = []; for (let y = 1; y < height - 1; y += stepY) at.push(y); readEach(at.map(y => () => data.subarray((y - 1) * row, (y + 2) * row)[JOIN])); }
  for (let y = 1; y < height - 1; y += stepY) for (let x = 1; x < width - 1; x += stepX) {
    const i = (y * width + x) * 4, c = luma(i), l = luma(i - 4), r = luma(i + 4), u = luma(i - row), d = luma(i + row);
    const g = Math.abs(r - l) + Math.abs(d - u);
    curvature += Math.abs(4 * c - l - r - u - d); gradient += g; total++;
    if (g < 2) flat++;
  }
  return total > 0 ? {flatShare: flat / total, curvature: curvature / (gradient + 1e-9)} : {flatShare: 1, curvature: 0};
}

const uploadTune = (c, k, q) => {
  const base = V6.tune(c, k);
  if (q <= 50) return base;
  const kx = k & 7, ky = k >> 3, is90 = q >= 85;
  const [lx, ly, lb] = is90 ? [0.64, 0.60, 0.60] : [0.58, 0.58, 0.54];
  const b2 = is90 ? 0.78 : 0.68;
  const low = k && kx < 2 && ky < 2 ? [lx, ly, lb][c]
    : c === 2 && k && kx < 3 && ky < 3 ? b2 : 1;
  const scale = q < 70 ? 1 + (low - 1) * (q - 50) / 20 : low;
  const r = Math.sqrt((kx * kx + ky * ky) / 98);
  const hi = is90 && k && (kx >= 2 || ky >= 2) ? 1 + (c === 1 ? 0.04 : 0.06) * r : 1;
  return base * scale * hi;
};
const UPLOAD_DEADZONE = [0.68, 0.72, 0.455, 0.545, 0.50, 0.56];
export const UPLOAD_GAB_90 = {...GABORISH.gaborish, iterations: 2, boost: 1.4,
  weights: [[0.075, 0.028], [0.075, 0.028], [0.075, 0.028]]};
export const UPLOAD_PICTURE = {...V6, ...GABORISH, deadzone: UPLOAD_DEADZONE, cflScale: 0.75, tune: uploadTune,
  calibrationRow: 'upload', gaborish: {...GABORISH.gaborish, iterations: 2, boost: 1.6}, fastGaborish: true};
const EFFORT2_DEADZONE = [0.70, 0.74, 0.470, 0.560, 0.520, 0.580];
export const EFFORT2_PICTURE = {...V6, deadzone: EFFORT2_DEADZONE, cflScale: 0.72, epfScale: 2.4, tune: V6.tune,
  calibrationRow: 'e2', gaborish: {strength: 1, tilt: 1, iterations: 1, boost: 1.25,
    weights: [[0.075, 0.028], [0.075, 0.028], [0.075, 0.028]]}, fastGaborish: true};
export const UPLOAD_FLAT_PICTURE = {...UPLOAD_PICTURE, deadzone: V6.deadzone, cflScale: V6.cflScale, tune: V6.tune, calibrationRow: false};
export const uploadFlat = (data, width, height) => flatSamples(data, width, height, 33) > 32;
export const uploadBandPicture = (flat, grain, quality) => flat ? UPLOAD_FLAT_PICTURE : {
  ...UPLOAD_PICTURE, uploadGrain: !!grain,
  epfScale: quality >= 85 ? (grain ? 1.0 : 1.5) : (grain ? 1.5 : 2.0),
  gaborish: quality >= 85 ? UPLOAD_GAB_90 : UPLOAD_PICTURE.gaborish,
};
export const uploadGrain = (data, width, height) => !uploadFlat(data, width, height) && !!grainRegime(data, width, height);
export const uploadPicture = (data, width, height, quality) =>
  uploadBandPicture(uploadFlat(data, width, height), !!grainRegime(data, width, height), quality);
export const SMALL_PIXELS = 2e6;
export const SMALL_CLUSTERS = {maxClusters: 64, newClusterCost: 100, seeds: 64, passes: 1, mapLz: false};
export const UPLOAD_CLUSTERS = {maxClusters: 64, newClusterCost: 85, seeds: 128, passes: 1, switchCost: 5, mapLz: true};
