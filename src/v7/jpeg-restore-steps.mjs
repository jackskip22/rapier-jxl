// SPDX-License-Identifier: MIT
import {restoreJPEGSteps} from '../jpeg-reconstruction.mjs';
import {brotliDictionary} from '../brotli-dictionary.mjs';
import {imageResult} from './result.mjs';
import {fail, pixelLimit, NO_JPEG} from './primitives.mjs';
import {jpegDisplayDimensionsSteps} from './preparation-jpeg.mjs';

const record = value => value && typeof value === 'object' && !Array.isArray(value);
export const keys = (options, taken) => {
  if (!record(options)) throw fail('JXL_OPTIONS', "jpeg options: plain record");
  const unknown = Object.keys(options).find(key => !taken.includes(key));
  if (unknown) throw fail('JXL_OPTIONS', `unknown option: ${unknown}; use ${taken.join(", ")}`);
};

export const restoreSteps = Object.freeze({id: 'jpeg:restore', prepare: null, eager: false,
  normalize(options) {
    keys(options, ['maxPixels']);
    return {options: {...options}, maxPixels: pixelLimit(options.maxPixels)};
  },
  *open(plan, file) {
    const head = file.subarray(0,2);
    if (head[0] === 255 && head[1] === 10) throw fail('JXL_RECONSTRUCTION', NO_JPEG);
    const result = yield* restoreJPEGSteps(file, brotliDictionary, {maxPixels: plan.maxPixels});
    if (!result) throw fail('JXL_RECONSTRUCTION', NO_JPEG);
    const facts = yield* jpegDisplayDimensionsSteps(result, plan.maxPixels);
    return {bytes: result, facts: {...facts, originalBytes: file.length}};
  },
  record: (bytes, plan, source, size) => imageResult(bytes, size, {format: 'jpeg', fidelity: 'exact', kept: 'jpeg-bytes', originalBytes: size.originalBytes, owned: true})});
