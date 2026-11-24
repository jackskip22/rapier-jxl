// SPDX-License-Identifier: MIT
import {importFile} from './worker-start.mjs';
const file = () => new URL('./jpeg.mjs', import.meta.url);
export const JPEG_SPEC = Object.freeze({module: 'rapier-jxl/jpeg', operations: ['recompress', 'restore'],
  role: 'rapier-jxl/jpeg worker',
  url: file,
  file, load: () => importFile(file()),
  worker: () => new Worker(file(), {type: 'module', name: 'rapier-jxl/jpeg worker'})});
