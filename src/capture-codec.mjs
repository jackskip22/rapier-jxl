// SPDX-License-Identifier: MIT
// Capture encoding shares the screen encoder's palette, predictor, LZ77 and framing kernels.
import {BitWriter, complete} from './bits.mjs';
import {admitOptions, admitPixels, fault, job} from './admit.mjs';
import {inspectPixels, losslessSteps} from './lossless.mjs';
import {screenLocalFrameSteps} from './screen.mjs';
import {screenModel, writeScreenModel} from './screen-lz77.mjs';

export function quantizeCapture(data, maxError = 0) {
  if (!Number.isInteger(maxError) || maxError < 0 || maxError > 8)
    throw fault('JXL_INPUT', 'maxError is a whole number from 0 to 8. Zero preserves every sample.');
  if (!maxError) return data;
  const out = new Uint8Array(data), step = 2 * maxError + 1;
  const table = Uint8Array.from({length: 256}, (_, value) => Math.min(255, Math.floor((value + maxError) / step) * step));
  for (let i = 0; i < out.length; i += 4) if (out[i + 3]) {
    out[i] = table[out[i]]; out[i + 1] = table[out[i + 1]]; out[i + 2] = table[out[i + 2]];
  }
  return out;
}

// Rank transforms on three spatial windows, including palette-table costs.
// Each group gets one full model search; noisy inputs use the core below.
function selectCapturePlans(choices, width, height) {
  if (choices.length < 2 || width * height <= 4096) return choices;
  const sw = Math.min(width, 64), sh = Math.min(height, 32), area = sw * sh;
  for (const entry of choices) {
    const {choice} = entry;
    const planes = Array.from({length: choice.count}, () => new Int16Array(area));
    let price = 0;
    for (const t of [0, 0.5, 1]) {
      choice.fill(planes, Math.floor((width - sw) * t), Math.floor((height - sh) * t), sw, sh);
      for (const plane of planes) price += screenModel(plane, sw, sh, 4, 7).bits;
    }
    price *= width * height / (area * 3);
    if (choice.meta.length) {
      const writer = new BitWriter(256);
      writeScreenModel(writer, choice.meta.map(m => screenModel(m.plane, m.width, m.height, 4, 7)))();
      price += writer.bitLength;
    }
    entry.price = price;
  }
  choices.sort((a, b) => a.price - b.price);
  return choices.slice(0, 1);
}

export function encodeCapture(data, width, height, options) {
  return complete(encodeCaptureSteps(data, width, height, options));
}

export function encodeCaptureSteps(data, width, height, options = {}) {
  const {colorSpace} = admitOptions(options);
  admitPixels(data, width, height);
  if (!(data instanceof Uint8Array || data instanceof Uint8ClampedArray))
    throw fault('JXL_INPUT', 'Captures use straight RGBA8 samples.');
  if (options.quality !== undefined || options.bitDepth !== undefined || options.sampleFormat !== undefined ||
      options.transferFunction !== undefined || options.alphaPremultiplied !== undefined || options.icc !== undefined)
    throw fault('JXL_INPUT', 'Captures use maxError and colorSpace; use the full encoder for other sample formats.');
  const pixels = quantizeCapture(data, options.maxError);
  const shape = inspectPixels(pixels, width, height, {palette: false});
  // Flat neighbours are useful screen structure. A picture with almost none is
  // cheaper to code with the shared two-pass core than with copy dictionaries.
  let flat = 0, smooth = 0;
  for (let sample = 0; sample < 256; sample++) {
    const pixel = Math.min(width * height - 1, Math.floor((sample + 0.5) * width * height / 256));
    const i = pixel * 4, n = (pixel % width ? pixel - 1 : pixel) * 4;
    const delta = Math.abs(pixels[i] - pixels[n]) + Math.abs(pixels[i + 1] - pixels[n + 1]) +
      Math.abs(pixels[i + 2] - pixels[n + 2]) + Math.abs(pixels[i + 3] - pixels[n + 3]);
    if (!delta) flat++;
    if (delta <= 32) smooth++;
  }
  if (width * height > 4096 && flat < 16 && smooth < 96)
    return job(losslessSteps(pixels, width, height, {shape, colorSpace}));
  return job(screenLocalFrameSteps(pixels, width, height, shape, colorSpace, {
    dim: 1024, depths: [4], modes: ['global', 'scalar', 'direct'], select: selectCapturePlans
  }));
}
