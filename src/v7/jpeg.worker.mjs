import * as module from './jpeg.mjs';
import {install, workerPort} from './worker-runtime.mjs';
import {moduleRuntime} from './module-runtime.mjs';
const port = workerPort();
install(port, [], moduleRuntime(module, {name: 'rapier-jxl/jpeg'}));
