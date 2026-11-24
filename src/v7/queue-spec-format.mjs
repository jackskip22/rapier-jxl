// SPDX-License-Identifier: MIT
import {importFile} from './worker-start.mjs';
import {admitFormatRequest} from '../splines-bound.mjs';
const file = () => new URL('./format.mjs', import.meta.url);
export const FORMAT_SPEC = Object.freeze({module: 'rapier-jxl/format', gpu: true, operations: ['format', 'encode'],
  admitInput: admitFormatRequest,
  role: 'rapier-jxl/format worker',
  url: file,
  file, load: () => importFile(file()),
  worker: () => new Worker(file(), {type: 'module', name: 'rapier-jxl/format worker'})});
