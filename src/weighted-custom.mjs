// SPDX-License-Identifier: MIT
import {fault} from './admit.mjs';
import {packSigned} from './bits.mjs';
import {countToken, writeHybrid} from './prefix.mjs';
import {LZ77, RESIDUAL_CONFIG, writeTransform} from './modular.mjs';

const CUSTOM_WEIGHTED_DEFAULTS = [16, 10, 7, 7, 7, 0, 0, 13, 12, 12, 12];
const CUSTOM_WEIGHTED_DIVISORS = Uint32Array.from({length: 64}, (_, i) => Math.floor(16777216 / (i + 1)));
export function admitWeightedPredictor(value) {
  if (value === undefined) return {values: CUSTOM_WEIGHTED_DEFAULTS, custom: false};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fault('JXL_INPUT', 'weightedPredictor is an object.');
  for (const key of Object.keys(value)) if (!['p1', 'p2', 'p3', 'weights'].includes(key)) throw fault('JXL_INPUT', 'Unknown weighted predictor field: ' + key + '.');
  const vector = (input, count, fallback, maximum, label) => {
    if (input === undefined) return fallback;
    if (!input || typeof input !== 'object' || input.length !== count) throw fault('JXL_INPUT', label + ' contains ' + count + ' integers.');
    const result = Array.from({length: count}, (_, i) => input[i]);
    if (result.some(x => !Number.isInteger(x) || x < 0 || x > maximum)) throw fault('JXL_INPUT', label + ' values are from zero through ' + maximum + '.');
    return result;
  };
  const values = [value.p1 ?? 16, value.p2 ?? 10, ...vector(value.p3, 5, [7, 7, 7, 0, 0], 31, 'p3'),
    ...vector(value.weights, 4, [13, 12, 12, 12], 15, 'weights')];
  if (values.slice(0, 2).some(x => !Number.isInteger(x) || x < 0 || x > 31)) throw fault('JXL_INPUT', 'p1 and p2 are integers from zero through 31.');
  return {values, custom: true};
}

export function writePlanarModularHeader(writer, {useGlobalTree = true, transforms = [], weighted} = {}) {
  writer.write(1, useGlobalTree ? 1 : 0);
  writer.write(1, weighted?.custom ? 0 : 1);
  if (weighted?.custom) weighted.values.forEach((value, i) => writer.write(i < 7 ? 5 : 4, value));
  writer.writeU32([[0, 0], [0, 1], [4, 2], [8, 18]], transforms.length);
  for (const transform of transforms) writeTransform(writer, transform);
}

function customErrorWeight(sum, maximum) {
  sum >>>= 0;
  let factor = 1, n = sum + 1;
  while (n >= 64) { n = Math.floor(n / 2); factor *= 2; }
  return 4 + Math.floor(maximum * CUSTOM_WEIGHTED_DIVISORS[Math.floor(sum / factor)] / factor);
}
function customWeightedAverage(sum, reciprocal) {
  const high = Math.floor(sum / 16777216), low = sum - high * 16777216;
  return high * reciprocal + Math.floor(low * reciprocal / 16777216);
}

function* customWeightedSteps(writer, target, plane, width, height, weighted, residuals) {
  const p = weighted.values, stride = width + 2, rowBatch = Math.max(1, Math.floor(16384 / Math.max(1, width)));
  const predictionErrors = Array.from({length: 4}, () => new Uint32Array(stride * 2));
  const errors = new Int32Array(stride * 2), predictions = new Float64Array(4), weights = new Uint32Array(4);
  let run = 0;
  const emit = (value, config = RESIDUAL_CONFIG, base = 0) => writer ? writeHybrid(writer, target, config, value, base) : countToken(config, value, target, base);
  const flush = () => {
    if (run > LZ77.minLength) { emit(0); emit(run - LZ77.minLength - 1, LZ77.lengthConfig, LZ77.minSymbol); }
    else for (let i = 0; i < run; i++) emit(0);
    run = 0;
  };
  for (let y = 0, index = 0; y < height; y++) {
    const current = y & 1 ? 0 : stride, previous = y & 1 ? stride : 0;
    for (let x = 0; x < width; x++, index++) {
      const left = x ? plane[index - 1] : y ? plane[index - width] : 0, top = y ? plane[index - width] : left;
      const northEast = x + 1 < width && y ? plane[index - width + 1] : top;
      const northWest = x && y ? plane[index - width - 1] : left, northNorth = y > 1 ? plane[index - width * 2] : top;
      const n = previous + x, ne = x + 1 < width ? n + 1 : n, nw = x ? n - 1 : n;
      const eW = x ? errors[current + x - 1] : 0, eN = errors[n], eNW = errors[nw], eNE = errors[ne], adjacent = eN + eW;
      const N = top * 8, W = left * 8, NE = northEast * 8;
      predictions[0] = W + NE - N;
      predictions[1] = N - Math.floor((adjacent + eNE) * p[0] / 32);
      predictions[2] = W - Math.floor((adjacent + eNW) * p[1] / 32);
      predictions[3] = N - Math.floor((eNW * p[2] + eN * p[3] + eNE * p[4] + (northNorth * 8 - N) * p[5] + (northWest * 8 - W) * p[6]) / 32);
      let total = 0;
      for (let i = 0; i < 4; i++) {
        const e = predictionErrors[i]; weights[i] = customErrorWeight(e[n] + e[ne] + e[nw], p[i + 7]); total += weights[i];
      }
      const shift = 27 - Math.clz32(total); total = 0;
      for (let i = 0; i < 4; i++) { weights[i] >>>= shift; total += weights[i]; }
      let sum = (total >> 1) - 1;
      for (let i = 0; i < 4; i++) sum += predictions[i] * weights[i];
      let guess = customWeightedAverage(sum, CUSTOM_WEIGHTED_DIVISORS[total - 1]);
      if (((eN ^ eW) | (eN ^ eNW)) <= 0) guess = Math.max(Math.min(W, NE, N), Math.min(Math.max(W, NE, N), guess));
      const value = plane[index], residual = (value - Math.floor((guess + 3) / 8)) | 0;
      if (residuals) residuals[index] = residual;
      else if (residual === 0) run++; else { flush(); emit(packSigned(residual)); }
      const scaled = value * 8; errors[current + x] = guess - scaled;
      for (let i = 0; i < 4; i++) {
        const error = Math.floor((Math.abs(predictions[i] - scaled) + 3) / 8), e = predictionErrors[i];
        e[current + x] = error; e[previous + x + 1] += error;
      }
    }
    if (residuals && ((y + 1) % rowBatch === 0 || y + 1 === height)) yield (y + 1) / height;
  }
  flush();
}

export function codeCustomWeighted(writer, target, plane, width, height, weighted) {
  const steps = customWeightedSteps(writer, target, plane, width, height, weighted);
  while (!steps.next().done) {}
}
export function* customWeightedResiduals(plane, width, height, weighted, residuals) {
  yield* customWeightedSteps(null, null, plane, width, height, weighted, residuals);
}
