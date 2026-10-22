// SPDX-License-Identifier: MIT
import {byteView, codecError} from './worker-input.mjs';
import {checkSignal, finishEncoding} from './async-job.mjs';
import {encodePhotoSteps} from './photo.mjs';
import {encodeProfileSteps} from './icc.mjs';
import {readSource} from './source.mjs';
import {withOpsin} from './opsin.mjs';

export const STILL_FORMAT_ACTIONS = Object.freeze(['photo', 'profile', 'readSource', 'encodeSource', 'opsin']);

export function formatBytes(input) {
  const bytes = byteView(input);
  if (!bytes.length) throw codecError('JXL_INPUT', 'The image is empty.');
  return bytes;
}
export function formatPixels(input) {
  return input instanceof Uint16Array || input instanceof Float32Array ? input : byteView(input);
}
export function formatOptions(input, onProgress) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || typeof input.action !== 'string')
    throw codecError('JXL_OPERATION', 'Unknown JPEG XL format action.');
  const options = input.options === undefined ? {} : input.options;
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw codecError('JXL_OPTIONS', 'Format options are an object.');
  if (onProgress !== undefined && typeof onProgress !== 'function') throw codecError('JXL_OPTIONS', 'onProgress is a function.');
  return options;
}

export async function formatStill(input, {signal, onProgress} = {}, photoAuthor = encodePhotoSteps) {
  checkSignal(signal);
  const options = formatOptions(input, onProgress);
  if (!STILL_FORMAT_ACTIONS.includes(input.action))
    throw codecError('JXL_UNAVAILABLE', 'This format action requires JPEG XL complete.');
  const finish = steps => finishEncoding(steps, {signal, progress: onProgress});
  let result;
  switch (input.action) {
    case 'photo':
      if (photoAuthor === encodePhotoSteps && ['transforms', 'quantization', 'coefficientOrders', 'progressive', 'noise',
        'lfFrames', 'upsampling', 'upsamplingWeights', 'extraChannels', 'level', 'orientation'].some(key => options[key] !== undefined))
        throw codecError('JXL_UNAVAILABLE', 'These photo options require JPEG XL complete.');
      return finish(photoAuthor(formatPixels(input.data), input.width, input.height, options));
    case 'profile': return finish(encodeProfileSteps(formatPixels(input.data), input.width, input.height, options));
    case 'readSource': result = await readSource(formatBytes(input.bytes)); break;
    case 'encodeSource': {
      const {data, width, height, ...sourceOptions} = await readSource(formatBytes(input.bytes));
      checkSignal(signal);
      return finish(encodeProfileSteps(data, width, height, {...sourceOptions, ...options}));
    }
    case 'opsin': result = withOpsin(formatBytes(input.bytes), options); break;
  }
  checkSignal(signal);
  onProgress?.(1);
  return result;
}
