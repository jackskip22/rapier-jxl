// SPDX-License-Identifier: MIT
import {exactPow} from './exact-math.mjs';
import {fault} from './fault.mjs';
import {s2Samples, s2RGBA} from './ssimulacra2-input.mjs';
import {butteraugliDimensions} from './butteraugli-memory.mjs';
import {nativeButteraugliReference, nativeButteraugliScore, nativeButteraugliRows, nativeButteraugliTable} from './butteraugli-arithmetic.mjs';
export {prepareButteraugli} from './butteraugli-arithmetic.mjs';
export {butteraugliAllocation, butteraugliWorkBytes, butteraugliRowsLayout} from './butteraugli-memory.mjs';

const references = new WeakMap();
export function butteraugliReference(input, width, height, {cacheBytes = 0} = {}) {
  const n = butteraugliDimensions(width, height);
  const state = nativeButteraugliReference(s2Samples(input, n), width, height, cacheBytes);
  const handle = Object.freeze({width, height, referenceBytes:state.referenceBytes,
    cacheBytes:state.cacheBytes, reservedBytes:state.cacheBytes});
  references.set(handle, state); return handle;
}
export function butteraugli(reference, input) {
  const state = references.get(reference);
  if (!state) throw fault('JXL_INPUT', 'Butteraugli needs a reference made by butteraugliReference.');
  const map = nativeButteraugliScore(state, s2Samples(input, state.width * state.height));
  let score = 0;
  for (const value of map) score = Math.max(score, value);
  return {score, pnorm3:pnorm(map, 3), map};
}
export function pnorm(map, p) {
  const sums = [0, 0, 0];
  for (const value of map) {
    let d = p === 3 ? value * (value * value) : exactPow(value, p);
    sums[0] += d; d *= d; sums[1] += d; d *= d; sums[2] += d;
  }
  return sums.reduce((sum, value, i) => sum + exactPow(value / map.length, 1 / (p * (1 << i))), 0) / 3;
}
export function butteraugliRows(reference, distorted, width, height, onRow) {
  butteraugliDimensions(width, height);
  if ([reference, distorted, onRow].some(fn => typeof fn !== 'function'))
    throw fault('JXL_INPUT', 'Butteraugli rows need two row readers and an output callback.');
  nativeButteraugliRows(reference, distorted, width, height, onRow);
}
export const butteraugliLinearTable = nativeButteraugliTable;
export function butteraugliLinearFromRGBA(rgba, pixels) {
  const input = s2RGBA(rgba, pixels), table = nativeButteraugliTable();
  const planes = [0, 1, 2].map(() => new Float32Array(pixels));
  for (let i = 0; i < pixels; i++) for (let c = 0; c < 3; c++) planes[c][i] = table[input[i * 4 + c]];
  return planes;
}
