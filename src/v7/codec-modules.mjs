// SPDX-License-Identifier: MIT
import {moduleRuntime} from './module-runtime.mjs';

const helpers = () => import('./helpers.mjs');
const helperFile = (url, worker) => Object.freeze({url, worker});
const HELPERS = Object.freeze({
  still: helperFile(() => new URL('./still.helper.mjs', import.meta.url), () => new Worker(new URL('./still.helper.mjs', import.meta.url), {type: 'module'})),
  upload: helperFile(() => new URL('./upload.helper.mjs', import.meta.url), () => new Worker(new URL('./upload.helper.mjs', import.meta.url), {type: 'module'})),
  animation: helperFile(() => new URL('./animation.helper.mjs', import.meta.url), () => new Worker(new URL('./animation.helper.mjs', import.meta.url), {type: 'module'})),
  format: helperFile(() => new URL('./format.helper.mjs', import.meta.url), () => new Worker(new URL('./format.helper.mjs', import.meta.url), {type: 'module'})),
});
const runners = new Map();
const runner = (name, load) => { if (!runners.has(name)) { const loading = load(); runners.set(name, loading); loading.catch(() => runners.delete(name)); } return runners.get(name); };
export const MODULES = Object.freeze({
  'rapier-jxl': Object.freeze({module: 'rapier-jxl', gpu: true, operations: ['encode', 'capture'],
    url: () => new URL('./still.worker.mjs', import.meta.url),
    worker: () => new Worker(new URL('./still.worker.mjs', import.meta.url), {type: 'module'}),
    runtime: () => runner('rapier-jxl', () => import('./index.mjs').then(module => moduleRuntime(module, {name: 'rapier-jxl', gpu: true, helpers, helper: HELPERS.still})))}),
  'rapier-jxl/upload': Object.freeze({module: 'rapier-jxl/upload', operations: ['encode', 'capture'], defaultEffort: 3,
    url: () => new URL('./upload.worker.mjs', import.meta.url),
    worker: () => new Worker(new URL('./upload.worker.mjs', import.meta.url), {type: 'module'}),
    runtime: () => runner('rapier-jxl/upload', () => import('./upload.mjs').then(module => moduleRuntime(module, {name: 'rapier-jxl/upload', helpers, helper: HELPERS.upload})))}),
  'rapier-jxl/animation': Object.freeze({module: 'rapier-jxl/animation', gpu: true, operations: ['encode', 'capture'],
    url: () => new URL('./animation.worker.mjs', import.meta.url),
    worker: () => new Worker(new URL('./animation.worker.mjs', import.meta.url), {type: 'module'}),
    runtime: () => runner('rapier-jxl/animation', () => import('./animation.mjs').then(module => moduleRuntime(module, {name: 'rapier-jxl/animation', gpu: true, helpers, helper: HELPERS.animation})))}),
  'rapier-jxl/format': Object.freeze({module: 'rapier-jxl/format', gpu: true, operations: ['format', 'encode', 'capture'],
    url: () => new URL('./format.worker.mjs', import.meta.url),
    worker: () => new Worker(new URL('./format.worker.mjs', import.meta.url), {type: 'module'}),
    runtime: () => runner('rapier-jxl/format', () => import('./format.mjs').then(module => moduleRuntime(module, {name: 'rapier-jxl/format', gpu: true, helpers, helper: HELPERS.format})))}),
  'rapier-jxl/capture': Object.freeze({module: 'rapier-jxl/capture', operations: ['capture'],
    url: () => new URL('./capture.worker.mjs', import.meta.url),
    worker: () => new Worker(new URL('./capture.worker.mjs', import.meta.url), {type: 'module'}),
    runtime: () => runner('rapier-jxl/capture', () => import('./capture.mjs').then(module => moduleRuntime(module, {name: 'rapier-jxl/capture'})))}),
  'rapier-jxl/decode': Object.freeze({module: 'rapier-jxl/decode', operations: ['decode'],
    url: () => new URL('./decode.worker.mjs', import.meta.url),
    worker: () => new Worker(new URL('./decode.worker.mjs', import.meta.url), {type: 'module'}),
    runtime: () => runner('rapier-jxl/decode', () => import('./decode.mjs').then(module => moduleRuntime(module, {name: 'rapier-jxl/decode'})))}),
  'rapier-jxl/jpeg': Object.freeze({module: 'rapier-jxl/jpeg', operations: ['recompress', 'restore'],
    url: () => new URL('./jpeg.worker.mjs', import.meta.url),
    worker: () => new Worker(new URL('./jpeg.worker.mjs', import.meta.url), {type: 'module'}),
    runtime: () => runner('rapier-jxl/jpeg', () => import('./jpeg.mjs').then(module => moduleRuntime(module, {name: 'rapier-jxl/jpeg'})))}),
});
