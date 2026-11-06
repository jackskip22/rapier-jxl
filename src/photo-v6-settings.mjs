// SPDX-License-Identifier: MIT
import {exactPow} from './exact-math.mjs';
import {QUANT_SHAPE} from './photo-dct.mjs';
import {flatSamples} from './screen-samples.mjs';

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
export const GABORISH = {gaborish: {strength: 1, tilt: 1}, epfScale: 2};
const UPLOAD_LOW = [0.62, 0.62, 0.58];
const uploadTune = (c, k, q) => {
  const base = V6.tune(c, k);
  if (q <= 50 || q >= 95) return base;
  const low = k && (k & 7) < 2 && k < 16 ? UPLOAD_LOW[c]
    : c === 2 && k && (k & 7) < 3 && k < 24 ? 0.72 : 1;
  return base * (q < 70 ? 1 + (low - 1) * (q - 50) / 20 : q <= 90 ? low : low + (1 - low) * ((q - 90) / 5) ** 2);
};
export const UPLOAD_PICTURE = {...V6, ...GABORISH, tune: uploadTune, calibrationRow: 'upload',
  gaborish: {...GABORISH.gaborish, iterations: 2, boost: 1.6}, fastGaborish: true};
export const UPLOAD_FLAT_PICTURE = {...UPLOAD_PICTURE, tune: V6.tune, calibrationRow: false};
export const uploadFlat = (data, width, height) => flatSamples(data, width, height, 33) > 32;
export const uploadPicture = (data, width, height) => uploadFlat(data, width, height) ? UPLOAD_FLAT_PICTURE : UPLOAD_PICTURE;
export const SMALL_PIXELS = 2e6, SMALL_CLUSTERS = {maxClusters: 64, newClusterCost: 100, seeds: 64, passes: 1, mapLz: false};
export const UPLOAD_CLUSTERS = {maxClusters: 64, newClusterCost: 100, seeds: 128, passes: 1, mapLz: false};
