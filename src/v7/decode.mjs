import {wasmBytes} from '../wasm-text.mjs';
import {decodeBands} from '../decode-parallel.mjs';
import {decodeOptions, openImageSteps} from '../decode-image.mjs';
import {PUBLIC_DECODE_LIMITS, decodeLimits} from './decode-limits.mjs';
import {addPart} from '../decode-parts.mjs';
import {readFeatures, applyPatches, applySplines, applyNoise} from '../decode-features.mjs';
import {readICC, readICCSteps} from '../decode-icc.mjs';
import {readICCColor} from '../decode-color-icc.mjs';
import {upsamplePlane} from '../decode-upsample.mjs';
import {decompressBrotli, decompressBrotliSteps} from '../decode-brotli.mjs';
import {readModularTransforms, inverseModularTransforms} from '../decode-modular-transforms.mjs';
import {brotliDictionary} from '../brotli-dictionary.mjs';
import {compileWasm} from '../wasm-modules.mjs';
import {DECODE_KERNELS} from '../decode-kernels-bytes.mjs';
import {wasmRequired} from '../capture-wasm-error.mjs';
import {decodedFields} from './describe.mjs';
import {bytes, check, fail, declared, object, pixelLimit, LARGEST, admitSignal, progressOf} from './primitives.mjs';
import {header} from './inspect.mjs';
import {publicDecoded} from './header-fields.mjs';
import {copyBytes, encodedByteLength} from './bytes.mjs';
import {admitRegion} from './region.mjs';
export {configureWasm} from '../wasm-modules.mjs';

addPart('features', {readFeatures, applyPatches, applySplines, applyNoise}); addPart('icc', {readICC, readICCSteps}); addPart('iccColor', {readICCColor});
addPart('upsample', {upsamplePlane}); addPart('brotli', {decompressBrotli, decompressBrotliSteps}); addPart('transforms', {readModularTransforms, inverseModularTransforms});

const compileKernels = () => compileWasm('decode', () => wasmBytes(DECODE_KERNELS));
export async function prepare() {
  let compiled;
  try { compiled = await compileKernels(); } catch (error) { throw declared(error); }
  if (!compiled) throw wasmRequired();
}
export async function supported(feature) {
  if (feature === 'webgpu') return false;
  if (feature !== undefined) throw fail('JXL_OPTIONS', "supported takes nothing, or 'webgpu'.");
  try { return await compileKernels(); } catch { return false; }
}
const HDR = ['pq', 'hlg'];
const FLAGS = ['applyOrientation', 'unpremultiplyAlpha', 'renderSpotColors', 'planes', 'partial'];
const KEYS = new Set([...PUBLIC_DECODE_LIMITS, ...FLAGS, 'format', 'colorSpace', 'region', 'signal', 'onProgress']);
const NAMED_SPACES = ['original', 'srgb', 'linear-srgb', 'display-p3', 'rec2020', 'xyb'];
const TARGET = {space: ['rgb', 'gray', 'xyb'], whitePoint: ['d65', 'dci', 'e', 'd50'], primaries: ['srgb', 'display-p3', 'rec2020'],
  transferFunction: ['srgb', 'linear', 'bt709', 'dci', 'pq', 'hlg', 'gamma']};
const point = value => Array.isArray(value) && value.length === 2 && value.every(Number.isFinite);
function colorTarget(value) {
  if (value === undefined) return undefined;
  const refuse = () => fail('JXL_OPTIONS', "colorSpace is 'original', 'srgb', 'linear-srgb', 'display-p3', 'rec2020', 'xyb' or {space, whitePoint?, primaries?, transferFunction?, gamma?, renderingIntent?}.");
  if (typeof value === 'string') { if (!NAMED_SPACES.includes(value)) throw refuse(); return value; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw refuse();
  const own = {...value};
  for (const key of Object.keys(own)) if (!['space', 'whitePoint', 'primaries', 'transferFunction', 'gamma', 'renderingIntent'].includes(key)) throw refuse();
  const {space, whitePoint, primaries, transferFunction, gamma, renderingIntent} = own, target = {space};
  if (!TARGET.space.includes(space)) throw refuse();
  if (whitePoint !== undefined) { if (!TARGET.whitePoint.includes(whitePoint) && !point(whitePoint)) throw refuse(); target.whitePoint = Array.isArray(whitePoint) ? [...whitePoint] : whitePoint; }
  if (primaries !== undefined) {
    if (!TARGET.primaries.includes(primaries) && !(Array.isArray(primaries) && primaries.length === 3 && primaries.every(point))) throw refuse();
    target.primaries = Array.isArray(primaries) ? primaries.map(pair => [...pair]) : primaries;
  }
  if (transferFunction !== undefined) { if (!TARGET.transferFunction.includes(transferFunction)) throw refuse(); target.transferFunction = transferFunction; }
  if (gamma !== undefined) {
    if (!Number.isFinite(gamma) || gamma <= 0 || transferFunction !== undefined && transferFunction !== 'gamma') throw refuse();
    target.gamma = gamma;
  }
  if (renderingIntent !== undefined) { if (![0, 1, 2, 3].includes(renderingIntent)) throw refuse(); target.renderingIntent = renderingIntent; }
  if (transferFunction === 'gamma' && gamma === undefined) throw fail('JXL_OPTIONS', "A 'gamma' transferFunction needs gamma.");
  if (space === 'xyb' && (gamma !== undefined && gamma !== 1 / 3 || transferFunction !== undefined && transferFunction !== 'gamma'))
    throw fail('JXL_OPTIONS', 'XYB has its own transfer: gamma 1/3, set or left out.');
  return target;
}
function admitDecode(options) {
  const given = {...object(options)};
  for (const key of Object.keys(given)) if (!KEYS.has(key)) throw fail('JXL_OPTIONS', `Unknown decode option: ${key}.`);
  for (const key of FLAGS) if (given[key] !== undefined && typeof given[key] !== 'boolean') throw fail('JXL_OPTIONS', `${key} is a boolean.`);
  if (given.format !== undefined && !['auto', 'uint8', 'uint16', 'float32'].includes(given.format)) throw fail('JXL_OPTIONS', 'format is auto, uint8, uint16 or float32.');
  for (const key of PUBLIC_DECODE_LIMITS) if (key !== 'maxPixels' && given[key] !== undefined && !(Number.isSafeInteger(given[key]) && given[key] > 0))
    throw fail('JXL_OPTIONS', `${key} is a positive safe integer.`);
  admitSignal(given.signal);
  if (given.colorSpace !== undefined) given.colorSpace = colorTarget(given.colorSpace);
  if (given.region !== undefined) given.region = admitRegion(given.region);
  if (given.partial && given.region) throw fail('JXL_OPTIONS', 'Use partial or region, not both.');
  return given;
}
export const decode = (input, options) => decodeHere(input, options).catch(error => { throw error === options?.signal?.reason ? error : declared(error); });
const limitsOf = bounds => decodeOptions({...bounds, ...decodeLimits(bounds), maxPixels: pixelLimit(bounds.maxPixels, LARGEST), dictionary: brotliDictionary});
decode[Symbol.for('rapier-jxl.verify.groups')] = Object.freeze({
  *open(input, options = {}) {
    bytes(input); const limits = {...limitsOf(admitDecode(options)), borrowed: true};
    if (input.length > limits.maxInputBytes) throw fail('JXL_LIMIT', 'Encoded input exceeds maxInputBytes.');
    try { return yield* openImageSteps(input, limits); } catch (error) { throw declared(error); }
  },
  region(input, options, opened) {
    if (!options?.region) return Promise.reject(fail('JXL_OPTIONS', 'A bounded verification decode needs its region.'));
    if (!opened) return Promise.reject(fail('JXL_INTERNAL', 'A bounded verification region needs its opened image.'));
    return decodeHere(input, options, opened).catch(error => { throw error === options?.signal?.reason ? error : declared(error); });
  },
});
async function decodeHere(input, options, opened = null) {
  const {signal, onProgress, ...bounds} = admitDecode(options);
  check(signal);
  if (onProgress !== undefined && typeof onProgress !== 'function') throw fail('JXL_OPTIONS', 'onProgress is a function.');
  const limits = limitsOf(bounds);
  const borrowed = opened !== null;
  if (borrowed) limits.borrowed = true;
  let owned;
  if (borrowed) {
    bytes(input);
    if (input.length > limits.maxInputBytes) throw fail('JXL_LIMIT', 'Encoded input exceeds maxInputBytes.');
    owned = input;
  } else if (typeof Blob !== 'undefined' && input instanceof Blob) {
    if (input.size > limits.maxInputBytes) throw fail('JXL_LIMIT', 'Encoded input exceeds maxInputBytes.');
    owned = new Uint8Array(await input.arrayBuffer()); check(signal);
  } else {
    if (encodedByteLength(input) > limits.maxInputBytes) throw fail('JXL_LIMIT', 'Encoded input exceeds maxInputBytes.');
    owned = copyBytes(input);
  }
  bytes(owned);
  const target = limits.colorSpace ?? 'original';
  if (target !== 'original') {
    let transfer; try { transfer = (opened?.h ?? header(owned)).colorEncoding?.transferFunction; } catch {}
    if (HDR.includes(transfer)) throw fail('JXL_UNSUPPORTED', "Converting HDR (PQ or HLG) is not offered in this version; decode with colorSpace 'original'.");
  }
  await prepare();
  check(signal);
  const result = decodeBands(owned, limits, opened);
  if (limits.region) result.region = {...limits.region};
  Object.assign(result, decodedFields(result));
  publicDecoded(result);
  for (const frame of [result, ...(result.frames ?? []), result.preview]) {
    const data = frame?.data;
    if (data instanceof Uint8Array) frame.data = new Uint8ClampedArray(data.buffer, data.byteOffset, data.length);
  }
  progressOf(onProgress, signal)?.(1);
  check(signal);
  return result;
}
