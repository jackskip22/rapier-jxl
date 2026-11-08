// SPDX-License-Identifier: MIT
import {decode} from './decode.mjs';
import {restoreJPEG} from '../jpeg-reconstruction.mjs';
import {brotliDictionary} from '../brotli-dictionary.mjs';
import {transcode} from '../jpeg.mjs';
import {prepareKernels} from '../kernels.mjs';
import {fromDecoded} from './describe.mjs';
import {check, JPEG_PIXELS} from './primitives.mjs';
import {restoreSteps} from './jpeg-restore-steps.mjs';
import {jpegSteps} from '../jpeg-job.mjs';
import {jpegEffortSteps} from '../jpeg-effort.mjs';
import {answer} from '../admit.mjs';

const referenceSteps = Object.freeze({prepare:prepareKernels,
  normalize:({maxPixels}) => ({maxPixels:Math.min(maxPixels,JPEG_PIXELS)}),
  *open(plan,bytes) {
    return {bytes:answer(yield* jpegSteps(bytes,{effort:1,maxPixels:plan.maxPixels,bands:{from:0,packed:0}},jpegEffortSteps))};
  }});

export const ownDecoder = {
  decode,
  restoreSteps,
  readJPEGSteps:() => referenceSteps,
  restore: (bytes, {maxPixels}) => restoreJPEG(bytes, brotliDictionary, {maxPixels}),
  async readJPEG(bytes, options) {
    await prepareKernels(); check(options.signal);
    return fromDecoded(await decode(transcode(bytes, {effort: 1, maxPixels: Math.min(options.maxPixels, JPEG_PIXELS)}).bytes,
      {maxPixels: options.maxPixels, signal: options.signal}));
  },
};
