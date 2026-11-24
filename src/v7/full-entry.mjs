// SPDX-License-Identifier: MIT
import {RAW_OPERATION} from './result-operation.mjs';
import {encode as ordinaryEncode, stillEncoder, prepare as prepareStill} from './still.mjs';
import {preparation} from './preparation.mjs';
import {withVariantsHelpers} from './preparation-with.mjs';
import {readPNG16} from '../source.mjs';
import {jpegPixels} from './jpeg-pixels.mjs';
import {orientSamples} from '../sample-transforms.mjs';
import {verbSteps, STEPS} from './verb-steps.mjs';
import {fitOptions, variantsOptions} from './preparation-options.mjs';
import {publicVocabulary} from './encode-options.mjs';
import {serveRole, ownFile, roleName, inPlace} from './module-roles.mjs';
import {moduleRuntime} from './module-runtime.mjs';
import {requireWebGPU} from './webgpu.mjs';
import {install, workerPort} from './worker-runtime.mjs';
import {previewHub} from './preview-relay.mjs';
import * as pool from '../helper-pool.mjs';
import {serveHelper} from '../helper-runtime.mjs';
import {WORKER_PROTOCOL} from './protocol.mjs';
import {serveBlockSplit} from '../block-split.mjs';
import {serveParallel} from '../parallel-serve.mjs';

export function fullEntry(name, selfUrl, ten = false) {
  const encode = ten ? stillEncoder(true) : ordinaryEncode;
  const {fit, variants} = preparation(ordinaryEncode[RAW_OPERATION], {
    deep: async () => ({readSource: readPNG16, orient: orientSamples}), jpegPixels, orient: orientSamples, fitTarget: true});
  if (!(typeof __RAPIER_JXL_UNSTEPPED__ !== 'undefined' && __RAPIER_JXL_UNSTEPPED__ === true)) {
    Object.defineProperty(fit, STEPS, {value: verbSteps('fit:rapier-jxl', fit, {taken: ['maxBytes', 'fidelity', 'effort', 'progressive', 'jpeg', 'readAs', 'maxPixels', 'firstRegion', 'webgpu'], admit: options => { fitOptions(publicVocabulary(options)); }, rows: true, files: true})});
    Object.defineProperty(variants, STEPS, {value: verbSteps('variants:rapier-jxl', variants, {taken: ['outputs', 'fidelity', 'effort', 'progressive', 'jpeg', 'readAs', 'maxPixels', 'firstRegion', 'webgpu'], admit: options => { variantsOptions(publicVocabulary(options)); }})});
  }
  const raw = {encode, fit, variants, prepare: prepareStill};
  serveRole(name, {
    worker: () => {
      const file = ownFile(roleName(name, 'helper'));
      install(workerPort(), [], withVariantsHelpers(moduleRuntime(raw, {name, gpu: requireWebGPU, helpers: async () => pool, helper: file}), pool, name, file), previewHub);
    },
    helper: () => {
      const runtime = moduleRuntime(raw, {name, gpu: requireWebGPU});
      serveHelper(() => ({name, protocol: WORKER_PROTOCOL, run: (...call) => runtime.run(...call), serveSplit: serveBlockSplit, serveParallel}));
    }});
  const here = inPlace(name, raw, {gpu: requireWebGPU, pool, url: selfUrl, prepareOp: 'encode',
    runtime: ready => {
      const file = ownFile(roleName(name, 'helper'), selfUrl);
      return withVariantsHelpers(moduleRuntime(raw, {name, gpu: requireWebGPU, ready, helpers: async () => pool, helper: file}), pool, name, file, ready);
    }});
  return {encode: here.wrap('encode'), fit: here.wrap('fit'), variants: here.wrap('variants'), prepare: here.wrap('prepare'),
    configure: here.configure, close: here.close};
}
