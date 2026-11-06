// SPDX-License-Identifier: MIT
import {kernelModule, compileKernels} from './kernel-runtime.mjs';
import {exactExp} from './exact-math.mjs';
import {fault} from './fault.mjs';
import {BA_MEMORY, butteraugliLayout, butteraugliRowsLayout} from './butteraugli-memory.mjs';
export const prepareButteraugli = compileKernels;
const f32 = Math.fround;
const GAUSSIAN = Float32Array.from([1.2, 7.15593339443, 3.22489901262, 1.56416327805, 2.7].flatMap(value => {
  const sigma = f32(value), radius = Math.trunc(f32(2.25 * sigma)), scale = -1 / (2 * sigma * sigma);
  const kernel = Array.from({length:radius * 2 + 1}, (_, i) => f32(exactExp(scale * (i - radius) * (i - radius))));
  const inverse = f32(1 / kernel.reduce((sum, value) => f32(sum + value), 0));
  return [...kernel, ...kernel.slice(0, radius + 1).map(value => f32(value * inverse))];
}));
const gaussian = BA_MEMORY.gaussian;
function arena(plan) {
  let memory;
  const pages = Math.ceil(plan.residentBytes / 65536);
  try { memory = new WebAssembly.Memory({initial:pages, maximum:pages}); }
  catch (cause) { throw Object.assign(fault('JXL_MEMORY', 'Cannot allocate Butteraugli work memory.'), {cause}); }
  const k = new WebAssembly.Instance(kernelModule(), {env:{memory}}).exports;
  k.s2MetricInit(BA_MEMORY.linear);
  new Float32Array(memory.buffer, gaussian, GAUSSIAN.length).set(GAUSSIAN);
  const view = (at, length) => new Float32Array(memory.buffer, at, length);
  return {k, view, memory};
}
function writeInput(owner, input, at, pixels) {
  const {view} = owner;
  if (input.rgba) {
    const table = view(BA_MEMORY.linear, 256), rgba = input.rgba;
    for (let c = 0; c < 3; c++) {
      const plane = view(at + c * pixels * 4, pixels);
      for (let i = 0; i < pixels; i++) plane[i] = table[rgba[i * 4 + c]];
    }
  } else for (let c = 0; c < 3; c++) {
    const target = view(at + c * pixels * 4, pixels); target.set(input[c]);
    for (const value of target) if (!Number.isFinite(value))
      throw fault('JXL_INPUT', 'Butteraugli samples must be finite binary32 values.');
  }
}
export function nativeButteraugliTable() {
  const owned = arena({residentBytes:Math.ceil(BA_MEMORY.base / 65536) * 65536});
  return owned.view(BA_MEMORY.linear, 256).slice();
}
export function nativeButteraugliReference(input, width, height, cacheBytes) {
  const plan = butteraugliLayout(width, height, {operation:'reference', cacheBytes});
  const owned = arena(plan), {k, view} = owned, {input:source, reference:bands, scratch, cache} = plan;
  writeInput(owned, input, source, plan.pixels);
  const levels = [];
  const prepare = (w, h, rgb, output, level) => {
    const n = w * h;
    k.baMetricBands(w, h, rgb, output, scratch, gaussian);
    const saved = view(output, n * 10).slice();
    let mask = null;
    if (plan.cacheMask & (1 << level)) {
      k.baMetricMask(w, h, output, scratch, cache, gaussian); mask = view(cache, n * 3).slice();
    }
    levels.push({width:w, height:h, bands:saved, mask});
  };
  prepare(width, height, source, bands, 0);
  if (plan.halfPixels) {
    k.baMetricDown(width, height, source, bands);
    prepare(plan.halfWidth, plan.halfHeight, bands, source, 1);
  }
  return {width, height, levels, referenceBytes:plan.referenceBytes, cacheBytes:plan.cacheBytes};
}
export function nativeButteraugliScore(reference, input) {
  const {width, height, levels} = reference;
  const plan = butteraugliLayout(width, height, {cacheBytes:reference.cacheBytes});
  const owned = arena(plan), {k, view} = owned, {input:source, reference:ref, distorted:dist, scratch, output, cache} = plan;
  writeInput(owned, input, source, plan.pixels);
  const compare = (level, rgb, bands, map) => {
    const n = level.width * level.height;
    view(ref, n * 10).set(level.bands);
    if (level.mask) view(cache, n * 3).set(level.mask);
    k.baMetricBands(level.width, level.height, rgb, bands, scratch, gaussian);
    k.baMetricDiff(level.width, level.height, ref, bands, scratch, map, gaussian, level.mask ? cache : 0);
  };
  compare(levels[0], source, dist, output);
  if (levels[1]) {
    k.baMetricDown(width, height, source, dist);
    compare(levels[1], dist, source, dist);
    k.baMetricMix(width, height, output, dist);
  }
  return view(output, plan.pixels).slice();
}
function writeRows(owner, read, at, width, y0, height) {
  const n = width * height;
  for (let y = 0; y < height; y++) for (let c = 0; c < 3; c++) {
    const row = read(c, y0 + y);
    if (!(row instanceof Float32Array || row instanceof Float64Array) || row.length < width
        || !(row.buffer instanceof ArrayBuffer)) throw fault('JXL_INPUT', 'Butteraugli needs a complete, nonshared linear row.');
    const target = owner.view(at + (c * n + y * width) * 4, width);
    for (let x = 0; x < width; x++) {
      const value = f32(row[x]);
      if (!Number.isFinite(value)) throw fault('JXL_INPUT', 'Butteraugli row samples must be finite binary32 values.');
      target[x] = value;
    }
  }
}
export function nativeButteraugliRows(reference, distorted, width, height, onRow) {
  const maximum = butteraugliRowsLayout(width, height), owned = arena(maximum), {k, view} = owned;
  for (let y = 0; y < height; y += maximum.coreRows) {
    const end = Math.min(height, y + maximum.coreRows), top = Math.max(0, y - maximum.halo);
    const bottom = Math.min(height, end + maximum.halo), h = bottom - top;
    const plan = butteraugliLayout(width, h, {operation:'rows'});
    const {input, reference:ref, distorted:dist, scratch, output, halfReference} = plan;
    writeRows(owned, reference, input, width, top, h);
    k.baMetricBands(width, h, input, ref, scratch, gaussian);
    if (plan.halfPixels) {
      k.baMetricDown(width, h, input, dist);
      k.baMetricBands(plan.halfWidth, plan.halfHeight, dist, halfReference, scratch, gaussian);
    }
    writeRows(owned, distorted, input, width, top, h);
    k.baMetricBands(width, h, input, dist, scratch, gaussian);
    k.baMetricDiff(width, h, ref, dist, scratch, output, gaussian, 0);
    if (plan.halfPixels) {
      k.baMetricDown(width, h, input, dist);
      k.baMetricBands(plan.halfWidth, plan.halfHeight, dist, input, scratch, gaussian);
      k.baMetricDiff(plan.halfWidth, plan.halfHeight, halfReference, input, scratch, dist, gaussian, 0);
      k.baMetricMix(width, h, output, dist);
    }
    for (let row = y; row < end; row++) {
      onRow(row, view(output + (row - top) * width * 4, width).slice());
    }
  }
}
