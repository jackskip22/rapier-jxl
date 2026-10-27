// SPDX-License-Identifier: MIT
import {createStillEncoder} from './rapier-still.mjs';
import {createJPEGXLCodec, installJPEGXLWorker} from './worker.mjs';

export function createEncoder(options = {}) {
  return createJPEGXLCodec({encoderFactory: () => createStillEncoder(options)});
}
export function installWorker(options = {}) {
  return installJPEGXLWorker({encoderFactory: () => createStillEncoder(options)});
}
