// SPDX-License-Identifier: MIT
import {inverseScaledDCT} from './decode-strategies.mjs';
import {decodeKernels} from './decode-kernels.mjs';
import {AFV_BASIS} from './afv-basis.mjs';

const scaledBases = new Map();
export function scaledBasis(n) {
  let b = scaledBases.get(n);
  if (!b) {
    b = new Float64Array(n * n);
    for (let u = 0; u < n; u++) { const impulse = new Float64Array(n); impulse[u] = 1; b.set(inverseScaledDCT(impulse, n, 1), u * n); }
    scaledBases.set(n, b);
  }
  return b;
}
const AFV_AT = 3540096, SMALL_SCRATCH = 4 * 65536 * 8;
export function inverseBlock(kernels, at, shape) {
  const id = shape.id;
  if (id === 0 || id >= 4 && id <= 11 || id >= 18)
    return kernels.idct(at, shape.width, shape.height, kernels.basis(shape.width, () => scaledBasis(shape.width)), kernels.basis(shape.height, () => scaledBasis(shape.height)));
  if (!kernels.afvLoaded) { new Float64Array(kernels.buffer, AFV_AT, 256).set(AFV_BASIS); kernels.afvLoaded = true; }
  kernels.small(at, id, kernels.output.byteOffset, SMALL_SCRATCH, kernels.basis(4, () => scaledBasis(4)), kernels.basis(8, () => scaledBasis(8)), AFV_AT);
}

export function restorationStages(filter) {
  const stages = [];
  if (filter?.gaborish) stages.push({radius: 1});
  const iters = filter?.epf?.iters;
  for (const step of iters === 3 ? [0, 1, 2] : iters === 2 ? [1, 2] : iters ? [1] : []) stages.push({radius: step === 0 ? 3 : step === 1 ? 2 : 1, step});
  return stages;
}

export function restoreRows(planes, top, width, height, filter, sigma, output, outTop, a, b, scratch) {
  const kernels = decodeKernels(), K = scratch.kernel, stages = restorationStages(filter), epf = filter?.epf, i32 = kernels.i32;
  if (stages.length && planes.some(p => p.buffer !== kernels.buffer)) throw new Error('Restoration reads the kernels\' memory.');
  let source = planes, sourceTop = top, after = stages.reduce((n, s) => n + s.radius, 0);
  for (let i = 0; i < stages.length; i++) {
    const stage = stages[i]; after -= stage.radius;
    const y0 = Math.max(0, a - after), y1 = Math.min(height, b + after), last = i === stages.length - 1;
    const target = last ? K.final : scratch[i], targetTop = last ? a : y0;
    if (stage.step === undefined) for (let c = 0; c < 3; c++) {
      const [side, diagonal] = filter.gaborish === true ? [.115169525, .061248592] : filter.gaborish[c];
      kernels.gabRows(source[c].byteOffset, sourceTop, target[c].byteOffset, targetTop, width, height, y0, y1, side, diagonal, 1 / (1 + 4 * side + 4 * diagonal));
    } else {
      const channelScale = epf.channelScale || [40, 5, 3.5], step = stage.step;
      for (let c = 0; c < 3; c++) { i32[K.args / 4 + c] = source[c].byteOffset; i32[K.args / 4 + 3 + c] = target[c].byteOffset; }
      kernels.epf(step, K.args, K.args + 12, width, height, sourceTop, targetTop, y0, y1, sigma ? K.sigma : 0, Math.ceil(width / 8), K.ring, K.up, K.down,
        channelScale[0], channelScale[1], channelScale[2], step === 0 ? epf.pass0SigmaScale ?? .9 : step === 2 ? epf.pass2SigmaScale ?? 6.5 : 1,
        epf.borderSadMul ?? 2 / 3, epf.sigmaForModular ?? 1);
    }
    source = target; sourceTop = targetTop;
  }
  if (!stages.length) for (let c = 0; c < output.length; c++) output[c].set(planes[c].subarray((a - top) * width, (b - top) * width), (a - outTop) * width);
  else if (source[0].byteOffset !== output[0].byteOffset || source[0].buffer !== output[0].buffer)
    for (let c = 0; c < output.length; c++) output[c].set(source[c].subarray(0, (b - a) * width), (a - outTop) * width);
}

export function restorationSizes(width, height, filter, rows) {
  const stages = restorationStages(filter), radius = stages.reduce((n, s) => n + s.radius, 0), held = Math.min(height, rows + 2 * radius) * width * 4;
  return [...Array(3 * Math.max(1, stages.length)).fill(held), ...Array(3).fill(Math.min(height, rows) * width * 4), 21 * width * 8, width * 8, width * 8,
    Math.ceil(width / 8) * Math.ceil(height / 8) * 4, 32];
}
export function restorationRegions(kernels, at, from, width, height, filter, rows) {
  const stages = restorationStages(filter), radius = stages.reduce((n, s) => n + s.radius, 0), held = Math.min(height, rows + 2 * radius) * width;
  const planes = (k, n) => [0, 1, 2].map(c => new Float32Array(kernels.buffer, at[k + c], n));
  const scratch = [];
  for (let i = 0; i < stages.length - 1; i++) scratch[i] = planes(from + 3 + 3 * i, held);
  const k = from + 3 * Math.max(1, stages.length);
  scratch.kernel = {final: planes(k, Math.min(height, rows) * width), ring: at[k + 3], up: at[k + 4], down: at[k + 5], sigma: at[k + 6], args: at[k + 7]};
  return {source: planes(from, held), scratch, next: k + 8};
}

export function restoreFilters(planes, width, height, filter, sigma = null) {
  if (!filter || !restorationStages(filter).length) return planes;
  const kernels = decodeKernels(), rows = 128, radius = restorationStages(filter).reduce((n, s) => n + s.radius, 0);
  const at = kernels.reserve(restorationSizes(width, height, filter, rows)), {source, scratch} = restorationRegions(kernels, at, 0, width, height, filter, rows);
  if (sigma) new Float32Array(kernels.buffer, scratch.kernel.sigma, sigma.length).set(sigma);
  const output = planes.map(p => new Float32Array(p.length));
  for (let a = 0; a < height; a += rows) {
    const b = Math.min(height, a + rows), lo = Math.max(0, a - radius), hi = Math.min(height, b + radius);
    for (let c = 0; c < 3; c++) source[c].set(planes[c].subarray(lo * width, hi * width));
    restoreRows(source, lo, width, height, filter, sigma, output, 0, a, b, scratch);
  }
  return output;
}
