// SPDX-License-Identifier: MIT
import {importFile} from './worker-start.mjs';
const file = () => new URL('./decode.mjs', import.meta.url);
export const DECODE_SPEC = Object.freeze({module: 'rapier-jxl/decode', operations: ['decode'],
  role: 'rapier-jxl/decode worker',
  url: file,
  file, load: () => importFile(file()),
  worker: () => new Worker(file(), {type: 'module', name: 'rapier-jxl/decode worker'})});
