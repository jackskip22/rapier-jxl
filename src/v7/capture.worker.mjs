import * as module from './capture-module.mjs';
import {install, workerPort} from './worker-runtime.mjs';
import {previewHub} from './preview-relay.mjs';
import {moduleRuntime} from './module-runtime.mjs';
const port = workerPort();
install(port, [], moduleRuntime(module, {name: 'rapier-jxl/capture'}), previewHub);
