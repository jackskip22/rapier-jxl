import * as module from './upload.mjs';
import {install, workerPort} from './worker-runtime.mjs';
import {moduleRuntime} from './module-runtime.mjs';
const port = workerPort();
install(port, [], moduleRuntime(module, {name: 'rapier-jxl/upload', helpers: () => import('./helpers.mjs'),
  helper: {url: () => new URL('./upload.helper.mjs', import.meta.url), worker: () => new Worker(new URL('./upload.helper.mjs', import.meta.url), {type: 'module'})}}));
