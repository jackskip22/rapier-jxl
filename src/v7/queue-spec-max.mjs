// SPDX-License-Identifier: MIT
import {importFile} from './worker-start.mjs';
const file = () => new URL('./max.mjs', import.meta.url);
export const MAX_SPEC = Object.freeze({module: 'rapier-jxl/max', gpu: true, defaultEffort: 10, operations: ['encode', 'fit', 'variants'],
  role: 'rapier-jxl/max worker', url: file, file, load: () => importFile(file()),
  worker: () => new Worker(file(), {type: 'module', name: 'rapier-jxl/max worker'})});
