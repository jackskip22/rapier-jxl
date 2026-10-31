import * as module from './animation.mjs';
import {install, workerPort} from './worker-runtime.mjs';
import {moduleRuntime} from './module-runtime.mjs';
const port = workerPort();
install(port, [], moduleRuntime(module, {name: 'rapier-jxl/animation', gpu: true, helpers: () => import('./helpers.mjs'),
  helper: {url: () => new URL('./animation.helper.mjs', import.meta.url), worker: () => new Worker(new URL('./animation.helper.mjs', import.meta.url), {type: 'module'})}}));
