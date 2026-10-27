// SPDX-License-Identifier: MIT
import {memoryPlan} from './memory-plan.mjs';
import {fault} from './fault.mjs';
import {exactPow} from './exact-math.mjs';
import {complete} from './bits.mjs';
import {QUANT_SHAPE, transformDCT8, dct8Basis} from './photo-dct.mjs';
import {photoXYBSteps, gaborishPlanes} from './photo-xyb.mjs';

const DEFAULT_DCT8 = [[3150.0, 0.0, -0.4, -0.4, -0.4, -2.0], [560.0, 0.0, -0.3, -0.3, -0.3, -0.3], [512.0, -2.0, -1.0, 0.0, -1.0, -2.0]];
function defaultWeight(c, x, y) {
  const p = DEFAULT_DCT8[c], bands = [p[0]];
  for (let i = 1; i < p.length; i++) bands.push(bands[i - 1] * (p[i] > 0 ? 1 + p[i] : 1 / (1 - p[i])));
  const dx = x / 7, dy = y / 7, at = Math.sqrt(dx * dx + dy * dy) * (bands.length - 1) / 1.4142135623730951;
  const i = Math.min(bands.length - 2, Math.floor(at));
  return bands[i] * exactPow(bands[i + 1] / bands[i], at - i);
}
const baseStep = (c, k) => [0.84, 7, 5.6][c] * QUANT_SHAPE[k] * (1 + [1, 0, 5][c] * Math.sqrt(((k & 7) * (k & 7) + (k >> 3) * (k >> 3)) / 98));
const LUMA = (1 / defaultWeight(1, 1, 0)) / baseStep(1, 1);
const CHROMA = Float64Array.from({length: 192}, (_, i) => {
  const c = i >> 6, k = i & 63; return k ? (1 / defaultWeight(c, k & 7, k >> 3)) / baseStep(c, k) / LUMA : 1;
});

export const V6 = {
  tune: (c, k) => {
    const r = Math.sqrt(((k & 7) * (k & 7) + (k >> 3) * (k >> 3)) / 98);
    return CHROMA[c * 64 + k] * [1.3, 1, 1.675][c] * (1 + [0.45, 0.45, 0][c] * r) * (1 + [-0.15, 0.05, 0][c] * r * r);
  },
  deadzone: [0.72, 0.76, 0.485, 0.575, 0.54, 0.6], epfScale: 3, filterAlways: true, dcScale: [1.675, 1.35, 1.675], cflScale: 0.7,
};
export const GABORISH = {gaborish: {strength: 1, tilt: 1}, epfScale: 2};

export function prepareV6(rgba, width, height, color = {}, memory = {}) {
  const inputBytes = rgba.buffer?.byteLength ?? rgba.byteLength;
  if (memory?.inputBytes !== undefined && memory.inputBytes < inputBytes) throw fault('JXL_MEMORY', 'Memory reservation omits retained input bytes.');
  const plan = memoryPlan(width * height, {...memory, inputBytes: memory?.inputBytes ?? inputBytes, width, height}), cache = plan.dct;
  if (plan.known && !plan.fits) throw fault('JXL_MEMORY', 'Photo encoding exceeds the supplied memory reservation.');
  return {rgba, width, height, color, memory: plan, pre: gaborishPlanes(rgba, width, height, {...V6, ...GABORISH, ...color}), dct: cache ? {} : null, dctPlain: cache ? {} : null};
}

export function photoV6Image(prepared, quality) {
  const {rgba, width, height, pre, color, dct} = prepared;
  return complete(photoXYBSteps(rgba, width, height, quality, {...V6, ...GABORISH, ...color, pre, dctCache: dct}));
}

export function* photoV6Steps(data, width, height, quality, effort, encodeCoefficients, search, color, gpu, memory) {
  if (gpu && effort <= 7 && !color) {
    const image = yield {gpu: {kind: 'v6image', data, width, height, quality, options: {...V6, ...GABORISH}, lib: {complete, photoXYBSteps, transformDCT8, dct8Basis}}};
    if (image) return yield* encodeCoefficients(image, effort);
  }
  const prepared = prepareV6(data, width, height, color, memory), image = photoV6Image(prepared, quality);
  if (effort <= 7 || !search || color || width < 8 || height < 8) return yield* encodeCoefficients(image, effort);
  return yield* search(prepared, image, quality, effort);
}

