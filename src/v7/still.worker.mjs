import {requireWebGPU} from './webgpu.mjs';
import * as module from './index.mjs';
import {install, workerPort} from './worker-runtime.mjs';
import {moduleRuntime} from './module-runtime.mjs';
const port = workerPort();
install(port, [], moduleRuntime(module, {name: 'rapier-jxl', gpu: requireWebGPU, helpers: () => import('./helpers.mjs'),
  helper: {url: () => new URL('./still.helper.mjs', import.meta.url), worker: () => new Worker(new URL('./still.helper.mjs', import.meta.url), {type: 'module'})}}));
