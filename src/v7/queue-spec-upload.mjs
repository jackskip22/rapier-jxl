// SPDX-License-Identifier: MIT
import {importFile} from './worker-start.mjs';
import {admitCapturePhoto} from './capture-photo-options.mjs';
import {CAPTURE_UPLOAD} from './capture-levels.mjs';
const file = () => new URL('./upload.mjs', import.meta.url);
export const UPLOAD_SPEC = Object.freeze({module: 'rapier-jxl/upload', operations: ['encode', 'fit', 'variants', 'capture'], defaultEffort: 3, captureAdmission: admitCapturePhoto, captureLevels: CAPTURE_UPLOAD,
  role: 'rapier-jxl/upload worker',
  url: file,
  file, load: () => importFile(file()),
  worker: () => new Worker(file(), {type: 'module', name: 'rapier-jxl/upload worker'})});
