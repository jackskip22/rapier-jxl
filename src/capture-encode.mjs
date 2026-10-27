// SPDX-License-Identifier: MIT
import {LIMITS} from './bits.mjs';
import {admitPixels, fault} from './admit.mjs';
import {encodeLossless, inspectPixels} from './lossless.mjs';
import {screenLike, screenPlan, screenFrameSteps, frequencyPlan} from './screen.mjs';
import {configureKernels} from './kernels.mjs';
import {graphicsPaletteSteps} from './graphics-quantize.mjs';

export {LIMITS};

let kernelsReady = false;
function ensureKernels() {
  if (kernelsReady) return;
  kernelsReady = true;
  try { configureKernels('auto'); } catch { /* JavaScript screen path */ }
}

function finish(steps) {
  let step = steps.next();
  while (!step.done) step = steps.next(false);
  return step.value;
}

// Short palettes are flat UI. Long palettes are antialiased text and want shorter copies.
// A gradient has no palette; extra predictors do not shrink it.
function searchFor(kind, colors) {
  if (kind === 'palette' && colors <= 2048) return {predictors: [1, 5], minLength: 7, codeBudget: 15};
  if (kind === 'palette') return {predictors: [1, 5], minLength: 4, codeBudget: 4};
  return {predictors: [5], minLength: 7, codeBudget: 4};
}

// Order-0 gradient residual entropy on a coarse grid. Used only to decide whether the
// screen file is already far smaller than a core exact encode.
function estimateExactBytes(rgba, width, height) {
  const step = 24, hist = new Uint32Array(512);
  let samples = 0;
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const i = (y * width + x) * 4;
      const left = x >= step ? i - step * 4 : i;
      const up = y >= step ? i - step * width * 4 : i;
      const upLeft = x >= step && y >= step ? up - step * 4 : left;
      for (let c = 0; c < 3; c++) {
        const l = rgba[left + c], u = rgba[up + c], g = l + u - rgba[upLeft + c];
        const pred = Math.max(Math.min(l, u), Math.min(Math.max(l, u), g));
        let delta = rgba[i + c] - pred;
        delta = delta < 0 ? -delta * 2 - 1 : delta * 2;
        hist[delta < 512 ? delta : 511]++;
        samples++;
      }
    }
  }
  if (!samples) return width * height;
  let bits = 0;
  for (let s = 0; s < hist.length; s++) if (hist[s]) bits -= hist[s] * Math.log2(hist[s] / samples);
  return bits / samples * width * height * 3 / 8 + 128;
}

function quantize(rgba, width, height, error) {
  // Keep smooth colour exact. Only high-contrast neighbourhoods, where antialiased text lives, may move.
  const mask = new Uint8Array(width * height), edge = 32;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const pixel = y * width + x, at = pixel * 4;
    if (rgba[at + 3] !== 255 || x === 0 || y === 0 || x === width - 1 || y === height - 1) { mask[pixel] = 1; continue; }
    let smooth = 1;
    for (let c = 0; c < 3 && smooth; c++) {
      let low = 255, high = 0;
      for (let dy = -1; dy <= 1 && smooth; dy++) for (let dx = -1; dx <= 1; dx++) {
        const neighbor = at + (dy * width + dx) * 4;
        if (rgba[neighbor + 3] !== 255) { smooth = 0; break; }
        const value = rgba[neighbor + c];
        if (value < low) low = value;
        if (value > high) high = value;
      }
      if (high - low >= edge) smooth = 0;
    }
    mask[pixel] = smooth;
  }
  return finish(graphicsPaletteSteps(rgba, width, height, mask, error, 512, rgba, true)) || rgba;
}

function screenFile(rgba, width, height) {
  const indexed = frequencyPlan(rgba, width, height);
  if (indexed) {
    const colors = indexed.plan.meta[0].width;
    return {bytes: finish(screenFrameSteps(rgba, width, height, indexed.shape, 'srgb', indexed.plan, {search: searchFor('palette', colors)})), shape: indexed.shape};
  }
  const shape = inspectPixels(rgba, width, height);
  if (!screenLike(rgba, width, height)) return {bytes: null, shape};
  const plan = screenPlan(rgba, width, height, shape, 'direct');
  if (!plan) return {bytes: null, shape};
  return {bytes: finish(screenFrameSteps(rgba, width, height, shape, 'srgb', plan, {search: searchFor('direct')})), shape};
}

export function encodeCaptureBytes(data, width, height, options = {}) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) throw fault('JXL_INPUT', 'Capture options are an object.');
  if (options.signal?.aborted) throw fault('JXL_ABORTED', 'JPEG XL encoding was canceled.');
  admitPixels(data, width, height, LIMITS);
  if (!(data instanceof Uint8Array) && !(data instanceof Uint8ClampedArray))
    throw fault('JXL_INPUT', 'A capture is 8-bit straight RGBA. Native precision and HDR use the full encoder.');
  const near = options.nearLossless === true;
  if (options.nearLossless !== undefined && typeof options.nearLossless !== 'boolean') throw fault('JXL_INPUT', 'nearLossless is a boolean.');
  const maxColorError = options.maxColorError === undefined ? 6 : options.maxColorError;
  if (!Number.isInteger(maxColorError) || maxColorError < 1 || maxColorError > 32)
    throw fault('JXL_INPUT', 'maxColorError is an integer from 1 through 32.');
  ensureKernels();
  const lossless = losslessFile(data, width, height, options.signal);
  if (!near) return lossless;
  if (options.signal?.aborted) throw fault('JXL_ABORTED', 'JPEG XL encoding was canceled.');
  const quantized = quantize(data, width, height, maxColorError);
  if (quantized === data) return lossless;
  const changed = losslessFile(quantized, width, height, options.signal);
  return changed.length < lossless.length ? changed : lossless;
}

function losslessFile(data, width, height, signal) {
  if (signal?.aborted) throw fault('JXL_ABORTED', 'JPEG XL encoding was canceled.');
  const packed = screenFile(data, width, height);
  const screen = packed.bytes, shape = packed.shape;
  if (screen && screen.length + 64 < estimateExactBytes(data, width, height) * 0.72) return screen;
  const exact = encodeLossless(data, width, height, {shape});
  if (signal?.aborted) throw fault('JXL_ABORTED', 'JPEG XL encoding was canceled.');
  return screen && screen.length < exact.length ? screen : exact;
}
