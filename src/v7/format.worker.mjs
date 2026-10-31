import * as module from './format.mjs';
import {install, workerPort} from './worker-runtime.mjs';
import {moduleRuntime} from './module-runtime.mjs';
const port = workerPort();
install(port, [], moduleRuntime(module, {name: 'rapier-jxl/format', gpu: true, helpers: () => import('./helpers.mjs'),
  helper: {url: () => new URL('./format.helper.mjs', import.meta.url), worker: () => new Worker(new URL('./format.helper.mjs', import.meta.url), {type: 'module'})}}));
