// SPDX-License-Identifier: MIT
import {moduleRuntime} from './module-runtime.mjs';
import {requireWebGPU} from './webgpu.mjs';
import {runner, helpers, helperFile} from './codec-runner.mjs';
const helper = helperFile(() => new URL('./format.helper.mjs', import.meta.url), () => new Worker(new URL('./format.helper.mjs', import.meta.url), {type: 'module'}));
export const FORMAT_SPEC = Object.freeze({module: 'rapier-jxl/format', gpu: true, operations: ['format', 'encode'],
  url: () => new URL('./format.worker.mjs', import.meta.url),
  worker: () => new Worker(new URL('./format.worker.mjs', import.meta.url), {type: 'module'}),
  runtime: () => runner('rapier-jxl/format', () => import('./format.mjs').then(module => moduleRuntime(module, {name: 'rapier-jxl/format', gpu: requireWebGPU, helpers, helper})))});
