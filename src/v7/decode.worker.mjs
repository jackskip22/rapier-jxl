import * as module from './decode.mjs';
import {install, workerPort} from './worker-runtime.mjs';
import {moduleRuntime} from './module-runtime.mjs';
const port = workerPort();
install(port, [], moduleRuntime(module, {name: 'rapier-jxl/decode'}));
