// SPDX-License-Identifier: MIT
import {workerAddress} from './worker-address.mjs';
export const JPEG_SPEC = Object.freeze({module: 'rapier-jxl/jpeg', operations: ['recompress', 'restore'],
  role: 'rapier-jxl/jpeg worker',
  url: () => workerAddress(import.meta.url, 'jpeg'),
  load: () => import('./jpeg.mjs'),
  worker: () => new Worker(new URL('./jpeg.mjs', import.meta.url), {type: 'module', name: 'rapier-jxl/jpeg worker'})});
