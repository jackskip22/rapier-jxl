// SPDX-License-Identifier: MIT
// Complete encoder and worker protocol used by Rapier.
import {createJPEGXLEncoder} from './rapier-encoder.mjs';
import {createJPEGXLCodec, installJPEGXLWorker} from './worker.mjs';
import {LIMITS, JPEG_LIMITS} from './bits.mjs';
import {kernelMode} from './kernels.mjs';

export function createEncoder(options = {}) {
  return createJPEGXLCodec({encoderFactory: () => createJPEGXLEncoder(options)});
}
export function installWorker(options = {}) {
  return installJPEGXLWorker({encoderFactory: () => createJPEGXLEncoder(options)});
}
export {LIMITS, JPEG_LIMITS, kernelMode};
