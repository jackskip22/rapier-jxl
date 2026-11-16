// SPDX-License-Identifier: MIT
import {workerAddress} from './worker-address.mjs';
export const ANIMATION_SPEC = Object.freeze({module: 'rapier-jxl/animation', gpu: true, operations: ['encode'],
  role: 'rapier-jxl/animation worker',
  url: () => workerAddress(import.meta.url, 'animation'),
  load: () => import('./animation.mjs'),
  worker: () => new Worker(new URL('./animation.mjs', import.meta.url), {type: 'module', name: 'rapier-jxl/animation worker'})});
