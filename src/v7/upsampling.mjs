// SPDX-License-Identifier: MIT
import {resizeSamples} from '../sample-transforms.mjs';
import {fail} from './primitives.mjs';

export async function upsampledSamples({data, width, height, ...source}, features, {signal, maxPixels} = {}) {
  const factor = features?.upsampling ?? 1;
  if (factor === 1) return data;
  if (![2, 4, 8].includes(factor)) throw fail('JXL_OPTIONS', 'upsampling: 2, 4 or 8');
  if (source.extraChannels !== undefined) throw fail('JXL_UNSUPPORTED', 'upsampling: not with extraChannels');
  const w = Math.ceil(width / factor), h = Math.ceil(height / factor), W = w * factor, H = h * factor;
  let samples = data;
  if (W !== width || H !== height) {
    samples = new data.constructor(W * H * 4);
    const row = width * 4, wide = W * 4;
    for (let y = 0; y < H; y++) {
      const at = y * wide, from = Math.min(y, height - 1) * row;
      samples.set(data.subarray(from, from + row), at);
      for (let x = width; x < W; x++) samples.copyWithin(at + x * 4, at + (width - 1) * 4, at + width * 4);
    }
  }
  const {colorSpace, transferFunction, bitDepth, sampleFormat, alphaPremultiplied} = source;
  const picture = {data: samples, width: W, height: H,
    ...(source.icc === undefined && colorSpace !== undefined && {colorSpace}),
    ...(source.icc === undefined && transferFunction !== undefined && {transferFunction}),
    ...(bitDepth !== undefined && {bitDepth}), ...(sampleFormat !== undefined && {sampleFormat}),
    ...(alphaPremultiplied !== undefined && {alphaPremultiplied})};
  return (await resizeSamples(picture, w, h, {signal, maxPixels: Math.max(maxPixels ?? 0, W * H)})).data;
}
