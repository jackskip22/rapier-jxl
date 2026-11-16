// SPDX-License-Identifier: MIT
import {workerAddress} from './worker-address.mjs';
import {admitFormatRequest} from '../splines-bound.mjs';
export const FORMAT_SPEC = Object.freeze({module: 'rapier-jxl/format', gpu: true, operations: ['format', 'encode'],
  admitInput: admitFormatRequest,
  role: 'rapier-jxl/format worker',
  url: () => workerAddress(import.meta.url, 'format'),
  load: () => import('./format.mjs'),
  worker: () => new Worker(new URL('./format.mjs', import.meta.url), {type: 'module', name: 'rapier-jxl/format worker'})});
