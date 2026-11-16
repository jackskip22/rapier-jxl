import {RAW_OPERATION} from './result-operation.mjs';
export * from './still.mjs';
export {configureDecoder} from '../shown-picture.mjs';
import {encode, prepare as prepareStill} from './still.mjs';
import {preparation} from './preparation.mjs';
import {readPNG16} from '../source.mjs';
import {jpegPixels} from './jpeg-pixels.mjs';
import {orientSamples} from '../sample-transforms.mjs';
import {verbSteps, STEPS} from './verb-steps.mjs';
import {fitOptions, variantsOptions} from './preparation-options.mjs';
import {publicVocabulary} from './encode-options.mjs';

const {fit, variants} = preparation(encode[RAW_OPERATION], {deep: async () => ({readSource: (bytes, options) => readPNG16(bytes, {...options, named: true}), orient: orientSamples}), jpegPixels, orient: orientSamples, fitTarget: true});
if (!(typeof __RAPIER_JXL_UNSTEPPED__ !== 'undefined' && __RAPIER_JXL_UNSTEPPED__ === true)) Object.defineProperty(fit, STEPS, {value: verbSteps('fit:rapier-jxl', fit, {taken: ['maxBytes', 'fidelity', 'effort', 'progressive', 'jpeg', 'readAs', 'maxPixels', 'firstRegion', 'webgpu'], admit: options => { fitOptions(publicVocabulary(options)); }, rows: true, files: true})});
if (!(typeof __RAPIER_JXL_UNSTEPPED__ !== 'undefined' && __RAPIER_JXL_UNSTEPPED__ === true)) Object.defineProperty(variants, STEPS, {value: verbSteps('variants:rapier-jxl', variants, {taken: ['outputs', 'fidelity', 'effort', 'progressive', 'jpeg', 'readAs', 'maxPixels', 'firstRegion', 'webgpu'], admit: options => { variantsOptions(publicVocabulary(options)); }})});
const prepare = prepareStill;

import * as self from './index.mjs';
import {serveRole, ownFile, roleName} from './module-roles.mjs';
import {moduleRuntime} from './module-runtime.mjs';
import {requireWebGPU} from './webgpu.mjs';
import {install, workerPort} from './worker-runtime.mjs';
import {previewHub} from './preview-relay.mjs';
import * as pool from '../helper-pool.mjs';
import {serveHelper} from '../helper-runtime.mjs';
import {WORKER_PROTOCOL} from './protocol.mjs';
import {serveBlockSplit} from '../block-split.mjs';
import {serveParallel} from '../parallel-serve.mjs';
const NAME = 'rapier-jxl';
serveRole(NAME, {
  worker: () => install(workerPort(), [], moduleRuntime(self, {name: NAME, gpu: requireWebGPU, helpers: async () => pool, helper: ownFile(roleName(NAME, 'helper'))}), previewHub),
  helper: () => {
    const runtime = moduleRuntime(self, {name: NAME, gpu: requireWebGPU});
    serveHelper(() => ({name: NAME, protocol: WORKER_PROTOCOL, run: (...call) => runtime.run(...call), serveSplit: serveBlockSplit, serveParallel}));
  }});

import {inPlace} from './module-roles.mjs';
const here = inPlace('rapier-jxl', {encode, fit, variants, prepare}, {gpu: requireWebGPU, pool, url: () => new URL(import.meta.url), prepareOp: 'encode'});
const encodeIn = here.wrap('encode'), fitIn = here.wrap('fit'), variantsIn = here.wrap('variants'), prepareIn = here.wrap('prepare');
export {encodeIn as encode, fitIn as fit, variantsIn as variants, prepareIn as prepare};
export const {configure, close} = here;