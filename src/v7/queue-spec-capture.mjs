// SPDX-License-Identifier: MIT
import {importFile} from './worker-start.mjs';
import {CAPTURE_LEAN} from './capture-levels.mjs';
const file = () => new URL('./capture.mjs', import.meta.url);
export const CAPTURE_SPEC = Object.freeze({module: 'rapier-jxl/capture', operations: ['capture'], captureLevels: CAPTURE_LEAN,
  role: 'rapier-jxl/capture worker',
  url: file,
  file, load: () => importFile(file()),
  worker: () => new Worker(file(), {type: 'module', name: 'rapier-jxl/capture worker'})});
