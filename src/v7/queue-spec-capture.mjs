// SPDX-License-Identifier: MIT
import {workerAddress} from './worker-address.mjs';
import {CAPTURE_LEAN} from './capture-levels.mjs';
export const CAPTURE_SPEC = Object.freeze({module: 'rapier-jxl/capture', operations: ['capture'], captureLevels: CAPTURE_LEAN,
  role: 'rapier-jxl/capture worker',
  url: () => workerAddress(import.meta.url, 'capture'),
  load: () => import('./capture.mjs'),
  worker: () => new Worker(new URL('./capture.mjs', import.meta.url), {type: 'module', name: 'rapier-jxl/capture worker'})});
