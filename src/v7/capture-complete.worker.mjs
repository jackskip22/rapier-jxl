// SPDX-License-Identifier: MIT
import * as module from './capture-complete-module.mjs';
import {moduleRuntime} from './module-runtime.mjs';
import {workerPort, install} from './worker-runtime.mjs';
install(workerPort(), [], moduleRuntime(module, {name: 'rapier-jxl/capture-complete'}));
