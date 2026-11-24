// SPDX-License-Identifier: MIT
import {importFile} from './worker-start.mjs';
import {admitCapturePhoto} from './capture-photo-options.mjs';
import {CAPTURE_COMPLETE} from './capture-levels.mjs';
const file = () => new URL('./capture-complete.mjs', import.meta.url);
export const CAPTURE_COMPLETE_SPEC = Object.freeze({module: 'rapier-jxl/capture-complete', operations: ['capture'], captureGpu: true, captureAdmission: admitCapturePhoto, captureLevels: CAPTURE_COMPLETE,
  helpers: Object.freeze({role: 'rapier-jxl/capture-complete groups', url: file, worker: () => new Worker(file(), {type: 'module', name: 'rapier-jxl/capture-complete groups'})}),
  role: 'rapier-jxl/capture-complete worker',
  url: file,
  file, load: () => importFile(file()),
  worker: () => new Worker(file(), {type: 'module', name: 'rapier-jxl/capture-complete worker'})});
