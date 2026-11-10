// SPDX-License-Identifier: MIT
import {moduleRuntime} from './module-runtime.mjs';
import {runner} from './codec-runner.mjs';
export const DECODE_SPEC = Object.freeze({module: 'rapier-jxl/decode', operations: ['decode'],
  url: () => new URL('./decode.worker.mjs', import.meta.url),
  worker: () => new Worker(new URL('./decode.worker.mjs', import.meta.url), {type: 'module'}),
  runtime: () => runner('rapier-jxl/decode', () => import('./decode.mjs').then(module => moduleRuntime(module, {name: 'rapier-jxl/decode'})))});
