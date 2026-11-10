// SPDX-License-Identifier: MIT
import {moduleRuntime} from './module-runtime.mjs';
import {admitCapturePhoto} from './capture-photo-options.mjs';
import {CAPTURE_UPLOAD} from './capture-levels.mjs';
import {runner, helpers, helperFile} from './codec-runner.mjs';
const helper = helperFile(() => new URL('./upload.helper.mjs', import.meta.url), () => new Worker(new URL('./upload.helper.mjs', import.meta.url), {type: 'module'}));
export const UPLOAD_SPEC = Object.freeze({module: 'rapier-jxl/upload', operations: ['encode', 'fit', 'variants', 'capture'], defaultEffort: 3, captureAdmission: admitCapturePhoto, captureLevels: CAPTURE_UPLOAD,
  url: () => new URL('./upload.worker.mjs', import.meta.url),
  worker: () => new Worker(new URL('./upload.worker.mjs', import.meta.url), {type: 'module'}),
  runtime: () => runner('rapier-jxl/upload', () => import('./upload.mjs').then(module => moduleRuntime(module, {name: 'rapier-jxl/upload', helpers, helper})))});
