// SPDX-License-Identifier: MIT
import {moduleRuntime} from './module-runtime.mjs';
import {requireWebGPU} from './webgpu.mjs';
import {runner, helpers, helperFile} from './codec-runner.mjs';
const helper = helperFile(() => new URL('./animation.helper.mjs', import.meta.url), () => new Worker(new URL('./animation.helper.mjs', import.meta.url), {type: 'module'}));
export const ANIMATION_SPEC = Object.freeze({module: 'rapier-jxl/animation', gpu: true, operations: ['encode'],
  url: () => new URL('./animation.worker.mjs', import.meta.url),
  worker: () => new Worker(new URL('./animation.worker.mjs', import.meta.url), {type: 'module'}),
  runtime: () => runner('rapier-jxl/animation', () => import('./animation.mjs').then(module => moduleRuntime(module, {name: 'rapier-jxl/animation', gpu: requireWebGPU, helpers, helper})))});
