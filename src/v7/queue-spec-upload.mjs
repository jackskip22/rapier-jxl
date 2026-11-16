// SPDX-License-Identifier: MIT
import {workerAddress} from './worker-address.mjs';
import {admitCapturePhoto} from './capture-photo-options.mjs';
import {CAPTURE_UPLOAD} from './capture-levels.mjs';
export const UPLOAD_SPEC = Object.freeze({module: 'rapier-jxl/upload', operations: ['encode', 'fit', 'variants', 'capture'], defaultEffort: 3, captureAdmission: admitCapturePhoto, captureLevels: CAPTURE_UPLOAD,
  role: 'rapier-jxl/upload worker',
  url: () => workerAddress(import.meta.url, 'upload'),
  load: () => import('./upload.mjs'),
  worker: () => new Worker(new URL('./upload.mjs', import.meta.url), {type: 'module', name: 'rapier-jxl/upload worker'})});
