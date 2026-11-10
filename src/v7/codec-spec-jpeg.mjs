// SPDX-License-Identifier: MIT
import {moduleRuntime} from './module-runtime.mjs';
import {runner} from './codec-runner.mjs';
export const JPEG_SPEC = Object.freeze({module: 'rapier-jxl/jpeg', operations: ['recompress', 'restore'],
  url: () => new URL('./jpeg.worker.mjs', import.meta.url),
  worker: () => new Worker(new URL('./jpeg.worker.mjs', import.meta.url), {type: 'module'}),
  runtime: () => runner('rapier-jxl/jpeg', () => import('./jpeg.mjs').then(module => moduleRuntime(module, {name: 'rapier-jxl/jpeg'})))});
