// SPDX-License-Identifier: MIT
import {workerAddress} from './worker-address.mjs';
import {admitCapturePhoto} from './capture-photo-options.mjs';
import {CAPTURE_COMPLETE} from './capture-levels.mjs';
export const CAPTURE_COMPLETE_SPEC = Object.freeze({module: 'rapier-jxl/capture-complete', operations: ['capture'], captureGpu: true, captureAdmission: admitCapturePhoto, captureLevels: CAPTURE_COMPLETE,
  helpers: Object.freeze({role: 'rapier-jxl/capture-complete groups', url: () => workerAddress(import.meta.url, 'capture-complete'), worker: () => new Worker(new URL('./capture-complete.mjs', import.meta.url), {type: 'module', name: 'rapier-jxl/capture-complete groups'})}),
  role: 'rapier-jxl/capture-complete worker',
  url: () => workerAddress(import.meta.url, 'capture-complete'),
  load: () => import('./capture-complete.mjs'),
  worker: () => new Worker(new URL('./capture-complete.mjs', import.meta.url), {type: 'module', name: 'rapier-jxl/capture-complete worker'})});
