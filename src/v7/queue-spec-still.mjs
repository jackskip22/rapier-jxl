// SPDX-License-Identifier: MIT
import {workerAddress} from './worker-address.mjs';
export const STILL_SPEC = Object.freeze({module: 'rapier-jxl', gpu: true, operations: ['encode', 'fit', 'variants'],
  role: 'rapier-jxl worker',
  url: () => workerAddress(import.meta.url, 'index'),
  load: () => import('./index.mjs'),
  worker: () => new Worker(new URL('./index.mjs', import.meta.url), {type: 'module', name: 'rapier-jxl worker'})});
