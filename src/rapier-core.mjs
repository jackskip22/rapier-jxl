// SPDX-License-Identifier: MIT
import {createStillEncoder} from './rapier-still.mjs';
import {createJPEGXLCodec, installJPEGXLWorker} from './worker.mjs';
import {LIMITS, JPEG_LIMITS} from './bits.mjs';
import {readImage} from './image-source.mjs';
import {kernelMode} from './kernels.mjs';

export function createEncoder(options = {}) {
  return createJPEGXLCodec({imageReader: readImage, encoderFactory: () => createStillEncoder(options)});
}
export function installWorker(options = {}) {
  return installJPEGXLWorker({imageReader: readImage, encoderFactory: () => createStillEncoder(options)});
}
export {LIMITS, JPEG_LIMITS, kernelMode};
