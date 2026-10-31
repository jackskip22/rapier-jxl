import {createCodec as createClient} from './client.mjs';
import {encoder} from './session.mjs';
import {moduleRuntime} from './module-runtime.mjs';
import {fail} from './primitives.mjs';

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
const MODULES = Object.freeze({
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

export function createCodec(config = {}) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw fail('JXL_OPTIONS', 'Codec configuration must be an object.');
  const {module = 'rapier-jxl', ...rest} = config;
  const spec = Object.hasOwn(MODULES, module) ? MODULES[module] : null;
  if (!spec) throw fail('JXL_OPTIONS', 'module names the module this codec runs: ' + Object.keys(MODULES).join(', ') + '.');
  if (rest.worker !== undefined) throw fail('JXL_OPTIONS', 'worker is not a codec setting: import the module to run it in place.');
  if (rest.helpers !== undefined && !spec.operations.includes('encode')) throw fail('JXL_OPTIONS', 'helpers are for a module that encodes.');
  if (rest.webgpu !== undefined && !spec.operations.includes('encode')) throw fail('JXL_OPTIONS', 'webgpu is for a module that encodes.');
  return encoder(createClient(rest, spec), rest, spec.operations, spec);
}
