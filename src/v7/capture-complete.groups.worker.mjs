// SPDX-License-Identifier: MIT
import * as module from './capture-complete-module.mjs';
import {moduleRuntime} from './module-runtime.mjs';
import {workerPort, install} from './worker-runtime.mjs';
import {previewHub} from './preview-relay.mjs';
import {withGroups} from './capture-groups.mjs';
const name = 'rapier-jxl/capture-complete';
install(workerPort(), [], withGroups(moduleRuntime(module, {name}), module, name,
  {url: () => new URL('./capture-complete.helper.mjs', import.meta.url), worker: () => new Worker(new URL('./capture-complete.helper.mjs', import.meta.url), {type: 'module'})}), previewHub);
