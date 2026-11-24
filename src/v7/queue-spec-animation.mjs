// SPDX-License-Identifier: MIT
import {importFile} from './worker-start.mjs';
const file = () => new URL('./animation.mjs', import.meta.url);
export const ANIMATION_SPEC = Object.freeze({module: 'rapier-jxl/animation', gpu: true, operations: ['encode'],
  role: 'rapier-jxl/animation worker',
  url: file,
  file, load: () => importFile(file()),
  worker: () => new Worker(file(), {type: 'module', name: 'rapier-jxl/animation worker'})});
