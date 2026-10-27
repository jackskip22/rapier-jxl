// SPDX-License-Identifier: MIT
import {LIMITS} from './bits.mjs';
import {readImage} from './image-source.mjs';
import {encodeCaptureSteps} from './capture-codec.mjs';
import {quantizeCaptureGPU} from './capture-gpu.mjs';
import {imageOptions, imageColor} from './encode-options.mjs';
import {finishEncoding, checkSignal} from './async-job.mjs';
import {fault} from './fault.mjs';

export {LIMITS};
/** Capture pixels exactly by default; maxError bounds each visible RGB sample, never alpha. */
export async function encode(source, options = {}) {
  const limits = imageOptions(options, LIMITS), maxError = options.maxError === undefined ? 0 : options.maxError;
  for (const key of Object.keys(options)) if (!['maxError', 'colorSpace', 'gpu', 'signal', 'onProgress', 'maxPixels'].includes(key))
    throw fault('JXL_OPTIONS', `Unknown capture option: ${key}.`);
  if (!Number.isInteger(maxError) || maxError < 0 || maxError > 8) throw fault('JXL_OPTIONS', 'maxError is an integer from 0 to 8.');
  const image = await readImage(source, false, limits), colorSpace = imageColor(image, options);
  checkSignal(options.signal);
  if (!(image.data instanceof Uint8Array || image.data instanceof Uint8ClampedArray)) throw fault('JXL_INPUT', 'Captures use 8-bit RGBA; use core or full for native precision.');
  const accelerated = maxError > 0 && options.gpu !== 'cpu' && image.width * image.height >= 1 << 20
    ? await quantizeCaptureGPU(image.data, maxError) : null;
  checkSignal(options.signal);
  return finishEncoding(encodeCaptureSteps(accelerated ?? image.data, image.width, image.height,
    {maxError: accelerated ? 0 : maxError, colorSpace}), {signal: options.signal, progress: options.onProgress});
}
