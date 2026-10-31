import {decodeBands} from '../decode-parallel.mjs';
import {decodeOptions} from '../decode-image.mjs';
import {PUBLIC_DECODE_LIMITS, decodeLimits} from './decode-limits.mjs';
import {addPart} from '../decode-parts.mjs';
import {readFeatures, applyPatches, applySplines, applyNoise} from '../decode-features.mjs';
import {readICC} from '../decode-icc.mjs';
import {readICCColor} from '../decode-color-icc.mjs';
import {upsamplePlane} from '../decode-upsample.mjs';
import {decompressBrotli} from '../decode-brotli.mjs';
import {readModularTransforms, inverseModularTransforms} from '../decode-modular-transforms.mjs';
import {brotliDictionary} from '../brotli-dictionary.mjs';
import {compileWasm} from '../wasm-modules.mjs';
import {DECODE_KERNELS} from '../decode-kernels-bytes.mjs';
import {decodedFields} from './describe.mjs';
import {bytes, check, fail, declared, object, callers, pixelLimit, admitSignal} from './primitives.mjs';
import {header} from './inspect.mjs';
import {publicDecoded} from './header-fields.mjs';
import {copyBytes, encodedByteLength} from './bytes.mjs';
export {configureWasm} from '../wasm-modules.mjs';

addPart('features', {readFeatures, applyPatches, applySplines, applyNoise}); addPart('icc', {readICC}); addPart('iccColor', {readICCColor});
addPart('upsample', {upsamplePlane}); addPart('brotli', {decompressBrotli}); addPart('transforms', {readModularTransforms, inverseModularTransforms});

export async function prepare() {
  try { await compileWasm('decode', () => Uint8Array.from(DECODE_KERNELS, c => c.charCodeAt(0))); } catch (error) { throw declared(error); }
}
export async function supported(feature) {
  if (feature === 'webgpu') return false;
  if (feature !== undefined) throw fail('JXL_OPTIONS', "supported takes nothing, or 'webgpu'.");
  return true;
}
const HDR = ['pq', 'hlg'];
const FLAGS = ['applyOrientation', 'unpremultiplyAlpha', 'renderSpotColors', 'planes'];
const KEYS = new Set([...PUBLIC_DECODE_LIMITS, ...FLAGS, 'format', 'colorSpace', 'signal', 'onProgress']);
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
  return given;
}
export const decode = (input, options) => decodeHere(input, options).catch(error => { throw error === options?.signal?.reason ? error : declared(error); });
async function decodeHere(input, options) {
  const {signal, onProgress, ...bounds} = admitDecode(options);
  check(signal);
  if (onProgress !== undefined && typeof onProgress !== 'function') throw fail('JXL_OPTIONS', 'onProgress is a function.');
  const limits = decodeOptions({...bounds, ...decodeLimits(bounds), maxPixels: pixelLimit(bounds.maxPixels), dictionary: brotliDictionary});
  let owned;
  if (typeof Blob !== 'undefined' && input instanceof Blob) {
    if (input.size > limits.maxInputBytes) throw fail('JXL_LIMIT', 'Encoded input exceeds maxInputBytes.');
    owned = new Uint8Array(await input.arrayBuffer()); check(signal);
  } else {
    if (encodedByteLength(input) > limits.maxInputBytes) throw fail('JXL_LIMIT', 'Encoded input exceeds maxInputBytes.');
    owned = copyBytes(input);
  }
  bytes(owned);
  const target = limits.colorSpace ?? 'original';
  if (target !== 'original') {
    let transfer; try { transfer = header(owned).colorEncoding?.transferFunction; } catch {}
    if (HDR.includes(transfer)) throw fail('JXL_UNSUPPORTED', "Converting an HDR picture (PQ or HLG) to another color space is not offered in this version; decode it with colorSpace 'original'.");
  }
  await prepare().catch(() => {});
  check(signal);
  const result = decodeBands(owned, limits);
  Object.assign(result, decodedFields(result));
  publicDecoded(result);
  for (const frame of [result, ...(result.frames ?? []), result.preview]) {
    const data = frame?.data;
    if (data instanceof Uint8Array) frame.data = new Uint8ClampedArray(data.buffer, data.byteOffset, data.length);
  }
  if (onProgress) try { onProgress(1); } catch (error) { throw callers(error); }
  check(signal);
  return result;
}
