import * as module from './still.mjs';
import {install, workerPort} from './worker-runtime.mjs';
import {moduleRuntime} from './module-runtime.mjs';
const port = workerPort();
install(port, [], moduleRuntime(module, {name: 'rapier-jxl', gpu: true, helpers: () => import('./helpers.mjs'),
  helper: {url: () => new URL('./still.helper.mjs', import.meta.url), worker: () => new Worker(new URL('./still.helper.mjs', import.meta.url), {type: 'module'})}}));
