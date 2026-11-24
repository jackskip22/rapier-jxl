// SPDX-License-Identifier: MIT
import {fault} from './fault.mjs';
export const DECODER_KEY = Symbol.for('rapier-jxl.decoder');
export const configuredDecoder = () => globalThis[DECODER_KEY] ?? null;
export function setDecoder(decode, restore, recompress) {
  if (decode !== null && typeof decode !== 'function')
    throw fault('JXL_INPUT', 'decode: function or null');
  if (restore !== undefined && restore !== null && typeof restore !== 'function')
    throw fault('JXL_INPUT', 'restore: function or null');
  if (recompress !== undefined && recompress !== null && typeof recompress !== 'function')
    throw fault('JXL_INPUT', 'recompress: function or null');
  globalThis[DECODER_KEY] = decode === null && !restore && !recompress ? null : Object.freeze({...(decode && {decode}), ...(restore && {restore}), ...(recompress && {recompress})});
}
