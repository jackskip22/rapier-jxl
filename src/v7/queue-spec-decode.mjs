// SPDX-License-Identifier: MIT
import {workerAddress} from './worker-address.mjs';
export const DECODE_SPEC = Object.freeze({module: 'rapier-jxl/decode', operations: ['decode'],
  role: 'rapier-jxl/decode worker',
  url: () => workerAddress(import.meta.url, 'decode'),
  load: () => import('./decode.mjs'),
  worker: () => new Worker(new URL('./decode.mjs', import.meta.url), {type: 'module', name: 'rapier-jxl/decode worker'})});
