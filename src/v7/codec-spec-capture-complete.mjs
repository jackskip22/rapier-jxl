// SPDX-License-Identifier: MIT
import {moduleRuntime} from './module-runtime.mjs';
import {admitCapturePhoto} from './capture-photo-options.mjs';
import {CAPTURE_COMPLETE} from './capture-levels.mjs';
import {runner, helperFile} from './codec-runner.mjs';
const helper = helperFile(() => new URL('./capture-complete.helper.mjs', import.meta.url), () => new Worker(new URL('./capture-complete.helper.mjs', import.meta.url), {type: 'module'}));
export const CAPTURE_COMPLETE_SPEC = Object.freeze({module: 'rapier-jxl/capture-complete', operations: ['capture'], captureGpu: true, captureAdmission: admitCapturePhoto, captureLevels: CAPTURE_COMPLETE,
  helpers: Object.freeze({url: () => new URL('./capture-complete.groups.worker.mjs', import.meta.url), worker: () => new Worker(new URL('./capture-complete.groups.worker.mjs', import.meta.url), {type: 'module'})}),
  url: () => new URL('./capture-complete.worker.mjs', import.meta.url),
  worker: () => new Worker(new URL('./capture-complete.worker.mjs', import.meta.url), {type: 'module'}),
  runtime: () => runner('rapier-jxl/capture-complete', () => Promise.all([import('./capture-complete.mjs'), import('./capture-groups.mjs')])
    .then(([module, {withGroups}]) => withGroups(moduleRuntime(module, {name: 'rapier-jxl/capture-complete'}), module, 'rapier-jxl/capture-complete', helper)))});
