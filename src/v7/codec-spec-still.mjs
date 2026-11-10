// SPDX-License-Identifier: MIT
import {moduleRuntime} from './module-runtime.mjs';
import {requireWebGPU} from './webgpu.mjs';
import {runner, helpers, helperFile} from './codec-runner.mjs';
const helper = helperFile(() => new URL('./still.helper.mjs', import.meta.url), () => new Worker(new URL('./still.helper.mjs', import.meta.url), {type: 'module'}));
export const STILL_SPEC = Object.freeze({module: 'rapier-jxl', gpu: true, operations: ['encode', 'fit', 'variants'],
  url: () => new URL('./still.worker.mjs', import.meta.url),
  worker: () => new Worker(new URL('./still.worker.mjs', import.meta.url), {type: 'module'}),
  runtime: () => runner('rapier-jxl', () => import('./index.mjs').then(module => moduleRuntime(module, {name: 'rapier-jxl', gpu: requireWebGPU, helpers, helper})))});
