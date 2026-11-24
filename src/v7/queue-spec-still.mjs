// SPDX-License-Identifier: MIT
import {importFile} from './worker-start.mjs';
const file = () => new URL('./index.mjs', import.meta.url);
export const STILL_SPEC = Object.freeze({module: 'rapier-jxl', gpu: true, operations: ['encode', 'fit', 'variants'],
  role: 'rapier-jxl worker',
  url: file,
  file, load: () => importFile(file()),
  worker: () => new Worker(file(), {type: 'module', name: 'rapier-jxl worker'})});
