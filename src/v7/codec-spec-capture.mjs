// SPDX-License-Identifier: MIT
import {moduleRuntime} from './module-runtime.mjs';
import {CAPTURE_LEAN} from './capture-levels.mjs';
import {runner} from './codec-runner.mjs';
export const CAPTURE_SPEC = Object.freeze({module: 'rapier-jxl/capture', operations: ['capture'], captureLevels: CAPTURE_LEAN,
  url: () => new URL('./capture.worker.mjs', import.meta.url),
  worker: () => new Worker(new URL('./capture.worker.mjs', import.meta.url), {type: 'module'}),
  runtime: () => runner('rapier-jxl/capture', () => import('./capture.mjs').then(module => moduleRuntime(module, {name: 'rapier-jxl/capture'})))});
