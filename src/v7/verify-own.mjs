// SPDX-License-Identifier: MIT
import {decode} from './decode.mjs';
import {restoreJPEG} from '../jpeg-reconstruction.mjs';
import {brotliDictionary} from '../brotli-dictionary.mjs';
import {transcode} from '../jpeg.mjs';
import {prepareKernels} from '../kernels.mjs';
import {fromDecoded} from './describe.mjs';
import {check, JPEG_PIXELS} from './primitives.mjs';

export const ownDecoder = {
  decode,
  restore: (bytes, {maxPixels}) => restoreJPEG(bytes, brotliDictionary, {maxPixels}),
  async readJPEG(bytes, options) {
    await prepareKernels(); check(options.signal);
    return fromDecoded(await decode(transcode(bytes, {effort: 1, maxPixels: Math.min(options.maxPixels, JPEG_PIXELS)}).bytes,
      {maxPixels: options.maxPixels, signal: options.signal}));
  },
};
