// SPDX-License-Identifier: MIT
import {DECODE_SPEC as QUEUE} from './queue-spec-decode.mjs';
import {moduleRuntime} from './module-runtime.mjs';
import {runner} from './codec-runner.mjs';
export const DECODE_SPEC = Object.freeze({...QUEUE,
  runtime: () => runner('rapier-jxl/decode', () => import('./decode.mjs').then(module => moduleRuntime(module, {name: 'rapier-jxl/decode'})))});
