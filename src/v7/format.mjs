import './engines.mjs';
import {author, admitFormat} from './author.mjs';
import {admitFormatRequest} from '../splines-bound.mjs';
import {snapshotOptions, admitSignal, check, fail, declared, callers, pixelLimit, progressOf} from './primitives.mjs';
import {own, record, DEFAULT_INPUT_BYTES} from './ownership.mjs';
import {withArenaLease} from '../call-scope.mjs';
import {acceleration} from './acceleration.mjs';
import {prepare as prepareStill} from './still.mjs';
import {ENCODE_FEATURES} from './encode-options.mjs';
import {imageResult} from './result.mjs';
import {readImageSize, codestreamOf} from '../framing.mjs';
import {encode} from './still.mjs';
export {supported} from './still.mjs';
const prepare = (operation = 'format') => operation === 'format' ? acceleration(false, 0, 0).then(() => {}, error => { throw declared(error); })
  : operation === 'encode' ? prepareStill() : Promise.reject(fail('JXL_OPTIONS', "prepare: format or encode"));
prepare.operations = ['format', 'encode'];

const format = (input, options) => formatHere(input, options).catch(error => { throw declared(error); });
const PHOTO_SETTINGS = ['level', 'upsampling', 'upsamplingWeights', 'transforms', 'quantization', 'coefficientOrders', 'progressive', 'noise', 'lfFrames'];
function photoKind(input, options, webgpu) {
  const {signal, onProgress, maxPixels, ...rest} = options;
  admitFormat(input, rest);
  const {kind: _kind, ...picture} = input, {fidelity, effort = 1} = rest, settings = {};
  for (const key of PHOTO_SETTINGS) if (rest[key] !== undefined) settings[key] = rest[key];
  return encode(picture, {...(fidelity !== undefined && {fidelity}), effort, ...(signal !== undefined && {signal}),
    ...(onProgress !== undefined && {onProgress}), ...(maxPixels !== undefined && {maxPixels}),
    ...(webgpu !== undefined && {webgpu}),
    ...(Object.keys(settings).length && {[ENCODE_FEATURES]: settings})});
}
function plainRequest(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail('JXL_INPUT', "format request: {kind}");
  let entries;
  try { entries = record(input); }
  catch (error) {
    if (error?.code === 'JXL_INPUT') throw error;
    throw callers(error);
  }
  return Object.fromEntries(entries.map(([key, descriptor]) => [key, descriptor.value]));
}
async function formatHere(input, given = {}) {
  const webgpu = given !== null && typeof given === 'object' ? given[CONFIGURED_WEBGPU] : undefined;
  let options = snapshotOptions(given);
  if (webgpu !== undefined) { const {[CONFIGURED_WEBGPU]: _w, ...clean} = options; options = clean; }
  input = plainRequest(input);
  if (input.kind === 'photo') return photoKind(input, options, webgpu);
  const {signal, onProgress, maxPixels: limit, ...rest} = options, maxPixels = pixelLimit(limit);
  admitSignal(signal);
  if (onProgress !== undefined && typeof onProgress !== 'function') throw fail('JXL_OPTIONS', "onProgress: function");
  admitFormat(input, rest);
  admitFormatRequest('format', input);
  const budget = Math.max(DEFAULT_INPUT_BYTES, maxPixels * 16);
  const request = own(input, maxPixels, budget), owned = own(rest, maxPixels, budget);
  const report = progressOf(onProgress, signal);
  check(signal);
  const bytes = await withArenaLease(signal, async () => {
    await acceleration(webgpu ?? false, 0, 0, owned.effort ?? 7, `authored ${request.kind}`);
    const hooks = {signal: signal ?? new AbortController().signal, onProgress: report, maxPixels};
    return author(request, owned, hooks);
  });
  const hooks = {signal: signal ?? new AbortController().signal, onProgress: report, maxPixels};
  const result = await imageResult(bytes, readImageSize(codestreamOf(bytes).codestream), {...formatFidelity(request.kind, owned), signal: hooks.signal, owned: true});
  report?.(1); await report?.finish();
  return result;
}

const LOSSY_KINDS = new Set(['photo', 'splines', 'hybrid']);
function formatFidelity(kind, options) {
  const asked = options.fidelity;
  if (asked !== undefined) return {fidelity: asked === 'exact' || asked.quality === 100 ? 'exact' : {quality: asked.quality}};
  if (LOSSY_KINDS.has(kind)) return {fidelity: {quality: 90}};
  const preset = options.preset ?? 'exact';
  const bound = kind === 'graphics' ? options.maxColorError ?? (preset === 'screen' ? 2 : preset === 'dither' ? 8 : 0)
    : kind === 'patches' ? options.baseError ?? 0 : 0;
  return bound > 0 || kind === 'graphics' && (options.undither ?? preset === 'dither')
    ? {fidelity: {maxError: bound}, kept: 'lossy'} : {fidelity: 'exact'};
}

export {configureDecoder} from '../shown-picture.mjs';

import * as self from './format.mjs';
import {serveRole, ownFile, roleName} from './module-roles.mjs';
import {moduleRuntime} from './module-runtime.mjs';
import {requireWebGPU, CONFIGURED_WEBGPU} from './webgpu.mjs';
import {install, workerPort} from './worker-runtime.mjs';
import {previewHub} from './preview-relay.mjs';
import * as pool from '../helper-pool.mjs';
import {serveHelper} from '../helper-runtime.mjs';
import {WORKER_PROTOCOL} from './protocol.mjs';
import {serveBlockSplit} from '../block-split.mjs';
import {serveParallel} from '../parallel-serve.mjs';
const NAME = 'rapier-jxl/format';
serveRole(NAME, {
  worker: () => install(workerPort(), [], moduleRuntime(self, {name: NAME, gpu: requireWebGPU, helpers: async () => pool, helper: ownFile(roleName(NAME, 'helper'))}), previewHub),
  helper: () => {
    const runtime = moduleRuntime(self, {name: NAME, gpu: requireWebGPU});
    serveHelper(() => ({name: NAME, protocol: WORKER_PROTOCOL, run: (...call) => runtime.run(...call), serveSplit: serveBlockSplit, serveParallel}));
  }});

import {inPlace} from './module-roles.mjs';
const here = inPlace('rapier-jxl/format', {format, encode, prepare}, {gpu: requireWebGPU, pool, url: () => new URL(import.meta.url), prepareOp: 'format'});
const formatIn = here.wrap('format'), encodeIn = here.wrap('encode'), prepareIn = here.wrap('prepare');
export {formatIn as format, encodeIn as encode, prepareIn as prepare};
export const {configure, close} = here;
