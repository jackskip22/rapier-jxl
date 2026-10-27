// SPDX-License-Identifier: MIT
import {createJPEGXLEncoder} from './full-encoder.mjs';
import {createJPEGXLCodec, installJPEGXLWorker} from './worker.mjs';
import {LIMITS, JPEG_LIMITS} from './bits.mjs';
import {readImage} from './image-source.mjs';
import {kernelMode} from './kernels.mjs';
import {format} from './format-worker.mjs';

export function createEncoder(options = {}) {
  return createJPEGXLCodec({imageReader: readImage, encoderFactory: () => createJPEGXLEncoder(options), formatHandler: format});
}
export function installWorker(options = {}) {
  return installJPEGXLWorker({imageReader: readImage, encoderFactory: () => createJPEGXLEncoder(options), formatHandler: format});
}
export {LIMITS, JPEG_LIMITS, kernelMode};
export {encode as encodeCapture} from './capture.mjs';
export {encode as encodePhoto, encodeToScore} from './photo-entry.mjs';
