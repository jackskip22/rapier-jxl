import './engines.mjs';
import {wasmBytes} from '../wasm-text.mjs';
import {decodeBands, decodeBandsAsync} from '../decode-parallel.mjs';
import {decodeOptions, openImageSteps, admitContainer, unreadAfterLastFrame} from '../decode-image.mjs';
import {PUBLIC_DECODE_LIMITS, decodeLimits} from './decode-limits.mjs';
import {addPart} from '../decode-parts.mjs';
import {readFeatures, applyPatches, applySplines, applyNoise} from '../decode-features.mjs';
import {readICC, readICCSteps} from '../decode-icc.mjs';
import {readICCColor} from '../decode-color-icc.mjs';
import {upsamplePlane} from '../decode-upsample.mjs';
import {decompressBrotli, decompressBrotliSteps} from '../decode-brotli.mjs';
import {readModularTransforms, inverseModularTransforms} from '../decode-modular-transforms.mjs';
import {brotliDictionary} from '../brotli-dictionary.mjs';
import {compileWasm, wasmFailure} from '../wasm-modules.mjs';
import {DECODE_KERNELS} from '../decode-kernels-bytes.mjs';
import {wasmRequired} from '../capture-wasm-error.mjs';
import {decodedFields} from './describe.mjs';
import {bytes, check, fail, declared, callers, snapshotOptions, snapshotArray, pixelLimit, PIXELS, admitSignal, progressOf, blobBytes, preparedAlone, isBlob} from './primitives.mjs';
import {header} from './inspect.mjs';
import {publicDecoded, publicFrameFields} from './header-fields.mjs';
import {copyBytes, encodedByteLength, viewBytes, admitSignature} from './bytes.mjs';
import {admitRegion} from './region.mjs';

addPart('features', {readFeatures, applyPatches, applySplines, applyNoise}); addPart('icc', {readICC, readICCSteps}); addPart('iccColor', {readICCColor});
addPart('upsample', {upsamplePlane}); addPart('brotli', {decompressBrotli, decompressBrotliSteps}); addPart('transforms', {readModularTransforms, inverseModularTransforms});

const compileKernels = () => compileWasm('decode', () => wasmBytes(DECODE_KERNELS));
const prepare = preparedAlone(async () => {
  let compiled;
  try { compiled = await compileKernels(); } catch (error) { throw declared(error); }
  if (!compiled) throw wasmRequired(wasmFailure('decode'));
});
export async function supported(feature) {
  if (feature === 'webgpu') return false;
  if (feature !== undefined) throw fail('JXL_OPTIONS', "supported(): no argument or 'webgpu'");
  try { return await compileKernels(); } catch { return false; }
}
const HDR = ['pq', 'hlg'];
const FLAGS = ['applyOrientation', 'unpremultiplyAlpha', 'renderSpotColors', 'planes', 'partial'];
const KEYS = new Set([...PUBLIC_DECODE_LIMITS, ...FLAGS, 'format', 'colorSpace', 'region', 'signal', 'onProgress', 'onFrame']);
const NAMED_SPACES = ['original', 'srgb', 'linear-srgb', 'display-p3', 'rec2020', 'xyb'];
const TARGET = {space: ['rgb', 'gray', 'xyb'], whitePoint: ['d65', 'dci', 'e', 'd50'], primaries: ['srgb', 'display-p3', 'rec2020'],
  transferFunction: ['srgb', 'linear', 'bt709', 'dci', 'pq', 'hlg', 'gamma']};
const point = value => {
  if (!Array.isArray(value)) return null;
  const copy = snapshotArray(value, 'Color point', 2);
  return copy.every(Number.isFinite) ? copy : null;
};
function colorTarget(value) {
  if (value === undefined) return undefined;
  const refuse = () => fail('JXL_OPTIONS', "colorSpace: original|srgb|linear-srgb|display-p3|rec2020|xyb|{space, whitePoint?, primaries?, transferFunction?, gamma?, renderingIntent?}");
  if (typeof value === 'string') { if (!NAMED_SPACES.includes(value)) throw refuse(); return value; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw refuse();
  const own = snapshotOptions(value, 'colorSpace');
  for (const key of Object.keys(own)) if (!['space', 'whitePoint', 'primaries', 'transferFunction', 'gamma', 'renderingIntent'].includes(key)) throw refuse();
  const {space, whitePoint, primaries, transferFunction, gamma, renderingIntent} = own, target = {space};
  if (!TARGET.space.includes(space)) throw refuse();
  if (whitePoint !== undefined) {
    target.whitePoint = TARGET.whitePoint.includes(whitePoint) ? whitePoint : point(whitePoint);
    if (!target.whitePoint) throw refuse();
  }
  if (primaries !== undefined) {
    if (TARGET.primaries.includes(primaries)) target.primaries = primaries;
    else {
      if (!Array.isArray(primaries)) throw refuse();
      const copy = snapshotArray(primaries, 'Color primaries', 3);
      target.primaries = copy.map(point);
      if (target.primaries.some(pair => !pair)) throw refuse();
    }
  }
  if (transferFunction !== undefined) { if (!TARGET.transferFunction.includes(transferFunction)) throw refuse(); target.transferFunction = transferFunction; }
  if (gamma !== undefined) {
    if (!Number.isFinite(gamma) || gamma <= 0 || transferFunction !== undefined && transferFunction !== 'gamma') throw refuse();
    target.gamma = gamma;
  }
  if (renderingIntent !== undefined) { if (![0, 1, 2, 3].includes(renderingIntent)) throw refuse(); target.renderingIntent = renderingIntent; }
  if (transferFunction === 'gamma' && gamma === undefined) throw fail('JXL_OPTIONS', "gamma: required with transferFunction: 'gamma'");
  if (space === 'xyb' && (gamma !== undefined && gamma !== 1 / 3 || transferFunction !== undefined && transferFunction !== 'gamma'))
    throw fail('JXL_OPTIONS', 'xyb gamma: 1/3 or omit');
  return target;
}
function admitDecode(options) {
  const given = snapshotOptions(options);
  for (const key of Object.keys(given)) if (!KEYS.has(key)) throw fail('JXL_OPTIONS', `unknown option: ${key}`);
  for (const key of FLAGS) if (given[key] !== undefined && typeof given[key] !== 'boolean') throw fail('JXL_OPTIONS', `${key}: boolean`);
  if (given.format !== undefined && !['auto', 'uint8', 'uint16', 'float32'].includes(given.format)) throw fail('JXL_OPTIONS', "format: auto|uint8|uint16|float32");
  for (const key of PUBLIC_DECODE_LIMITS) if (key !== 'maxPixels' && given[key] !== undefined && !(Number.isSafeInteger(given[key]) && given[key] > 0))
    throw fail('JXL_OPTIONS', `${key}: positive safe integer`);
  admitSignal(given.signal);
  if (given.colorSpace !== undefined) given.colorSpace = colorTarget(given.colorSpace);
  if (given.region !== undefined) given.region = admitRegion(given.region);
  if (given.partial && given.region) throw fail('JXL_OPTIONS', 'partial: not with region');
  if (given.onFrame !== undefined) {
    if (typeof given.onFrame !== 'function') throw fail('JXL_OPTIONS', 'onFrame: function');
    if (given.region || given.partial) throw fail('JXL_OPTIONS', 'onFrame: not with region or partial');
  }
  return given;
}
const decode = (input, options) => decodeHere(input, options).catch(error => { throw declared(error); });
const limitsOf = bounds => decodeOptions({...bounds, ...decodeLimits(bounds), maxPixels: pixelLimit(bounds.maxPixels), dictionary: brotliDictionary});
decode[Symbol.for('rapier-jxl.verify.groups')] = Object.freeze({
  *open(input, options = {}) {
    bytes(input); const limits = {...limitsOf(admitDecode(options)), borrowed: true};
    if (input.length > limits.maxInputBytes) throw fail('JXL_LIMIT', 'maxInputBytes: exceeded');
    try { return yield* openImageSteps(input, limits); } catch (error) { throw declared(error); }
  },
  region: (input, options, opened) => decodeRegion(input,options,opened,false),
  withoutNoise: (input, options, opened) => decodeRegion(input,options,opened,true),
});
function decodeRegion(input,options,opened,withoutNoise) {
  if (!options?.region) return Promise.reject(fail('JXL_OPTIONS', 'region: required for partial verify'));
  if (!opened) return Promise.reject(fail('JXL_INTERNAL', 'decode: unopened region'));
  return decodeHere(input,options,opened,withoutNoise).catch(error => { throw declared(error); });
}
decode[Symbol.for('rapier-jxl.verify.unread')] = (input, options) => {
  bytes(input);
  try { return unreadAfterLastFrame(input, limitsOf(admitDecode(options))); } catch (error) { throw declared(error); }
};
decode[Symbol.for('rapier-jxl.verify.without-noise')] = (input, options) =>
  decodeHere(input, options, null, true).catch(error => { throw declared(error); });
async function decodeHere(input, options, opened = null, withoutNoise = false) {
  const admitted = admitDecode(options), {signal, onProgress, onFrame, ...bounds} = admitted;
  check(signal);
  if (onProgress !== undefined && typeof onProgress !== 'function') throw fail('JXL_OPTIONS', 'onProgress: function');
  const limits = limitsOf(onFrame ? {...bounds, onFrame} : bounds);
  if (bounds.maxTotalSamples !== undefined) limits.callerTotalSamples = true;
  if (onFrame) limits.onFrame = async (frame, index) => {
    publicFrameFields(frame);
    if (frame.data instanceof Uint8Array) frame.data = new Uint8ClampedArray(frame.data.buffer, frame.data.byteOffset, frame.data.length);
    check(signal);
    try { await onFrame(frame, index); } catch (error) { throw callers(error); }
    check(signal);
  };
  const borrowed = opened !== null;
  if (borrowed) limits.borrowed = true;
  else limits.ownedInput = true;
  if (withoutNoise) limits.withoutNoise = true;
  let owned;
  if (borrowed) {
    bytes(input);
    if (input.length > limits.maxInputBytes) throw fail('JXL_LIMIT', 'maxInputBytes: exceeded');
    owned = input;
  } else if (isBlob(input)) {
    if (input.size > limits.maxInputBytes) throw fail('JXL_LIMIT', 'maxInputBytes: exceeded');
    owned = await blobBytes(input, signal);
  } else {
    if (encodedByteLength(input) > limits.maxInputBytes) throw fail('JXL_LIMIT', 'maxInputBytes: exceeded');
    const view = viewBytes(input);
    admitSignature(view, 'JXL_DECODE');
    if (!limits.partial) admitContainer(view, limits);
    try { header(view, {maxBoxes: limits.maxBoxes, maxPixels: limits.maxPixels, maxDimension: limits.maxDimension}); }
    catch (error) { if (error?.code && error.code !== 'JXL_INPUT' && error.code !== 'JXL_LIMIT') throw error; }
    owned = copyBytes(input);
  }
  bytes(owned);
  const target = limits.colorSpace ?? 'original';
  if (target !== 'original') {
    let transfer; try { transfer = (opened?.h ?? header(owned)).colorEncoding?.transferFunction; } catch {}
    if (HDR.includes(transfer)) throw fail('JXL_UNSUPPORTED', "HDR PQ/HLG: colorSpace 'original'");
  }
  await prepare();
  check(signal);
  const result = onFrame ? await decodeBandsAsync(owned, limits, opened) : decodeBands(owned, limits, opened);
  if (limits.region) result.region = {...limits.region};
  Object.assign(result, decodedFields(result));
  publicDecoded(result);
  for (const frame of [result, ...(result.frames ?? []), result.preview]) {
    const data = frame?.data;
    if (data instanceof Uint8Array) frame.data = new Uint8ClampedArray(data.buffer, data.byteOffset, data.length);
  }
  const progress = progressOf(onProgress, signal);
  progress?.(1); await progress?.finish();
  check(signal);
  return result;
}

import * as self from './decode.mjs';
import {serveRole} from './module-roles.mjs';
import {moduleRuntime} from './module-runtime.mjs';
import {install, workerPort} from './worker-runtime.mjs';
serveRole('rapier-jxl/decode', {worker: () => install(workerPort(), [], moduleRuntime(self, {name: 'rapier-jxl/decode'}))});

import {inPlace} from './module-roles.mjs';
const here = inPlace('rapier-jxl/decode', {decode, prepare}, {url: () => new URL(import.meta.url)});
const decodeIn = here.wrap('decode'), prepareIn = here.wrap('prepare');
export {decodeIn as decode, prepareIn as prepare};
export const {configure, close} = here;
