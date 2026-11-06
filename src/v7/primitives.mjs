import {EDGE} from '../limits.mjs';
export const fail = (code, message) => Object.assign(new Error(message), {code});
export const lostBlank = (context, data) => {
  if (!context?.isContextLost?.()) return false;
  const words = new Uint32Array(data.buffer, data.byteOffset, data.byteLength >> 2);
  for (let i = 0; i < words.length; i++) if (words[i]) return false;
  return true;
};
export const LOST = 'The canvas lost its 2D context; draw it again.';
export function proveRead(context) {
  if (context?.isContextLost?.() || typeof context?.putImageData !== 'function' || typeof context.createImageData !== 'function') return;
  const half = context.getContextAttributes?.().colorType === 'float16';
  const native = () => context.getImageData(0, 0, 1, 1, half ? {pixelFormat: 'rgba-float16'} : undefined);
  let saved;
  try { saved = native(); }
  catch (cause) { throw Object.assign(fail('JXL_INPUT', 'The canvas could not be read: ' + (cause?.message || cause)), {cause}); }
  if (half && saved.data.BYTES_PER_ELEMENT !== 2) return;
  const bits = data => new Uint8Array(data.buffer, data.byteOffset, data.byteLength).some(Boolean);
  if (bits(saved.data)) return;
  const mark = context.createImageData(1, 1);
  mark.data.fill(255);
  let kept;
  try { context.putImageData(mark, 0, 0); kept = bits(native().data); }
  finally { context.putImageData(saved, 0, 0); }
  if (!kept) throw fail('JXL_INPUT', LOST);
}
const KINDS = [Uint8Array, Uint8ClampedArray, Int8Array, Uint16Array, Int16Array, Uint32Array, Int32Array, Float32Array, Float64Array];
const kindOf = view => typeof Float16Array === 'function' && view instanceof Float16Array ? Float16Array : KINDS.find(kind => view instanceof kind);
export const plainView = view => { const kind = kindOf(view); return !kind || view.constructor === kind ? view : new kind(view.buffer, view.byteOffset, view.length); };
export const plainCopy = view => new (kindOf(view) ?? view.constructor)(view);
const DECLARED = new Set(['JXL_OPTIONS', 'JXL_INPUT', 'JXL_DIMENSIONS', 'JXL_JPEG', 'JXL_DECODE', 'JXL_RECONSTRUCTION', 'JXL_TARGET',
  'JXL_PLATFORM', 'JXL_MEMORY', 'JXL_LIMIT', 'JXL_WASM', 'JXL_WEBGPU', 'JXL_WORKER', 'JXL_WORKER_CSP', 'JXL_WORKER_TIMEOUT', 'JXL_ABORTED',
  'JXL_CLOSED', 'JXL_UNSUPPORTED', 'JXL_INTERNAL']);
const AS = {JXL_SIZE: 'JXL_LIMIT', JXL_INVALID: 'JXL_DECODE', JXL_FRAMING: 'JXL_INPUT', JXL_RGBA: 'JXL_INPUT', JXL_PROTOCOL: 'JXL_WORKER',
  JXL_WORKER_LEASE: 'JXL_WORKER', JXL_THREAD_REQUIRED: 'JXL_PLATFORM', JXL_UNAVAILABLE: 'JXL_PLATFORM', JXL_QUEUE_FULL: 'JXL_MEMORY',
  JXL_BUSY: 'JXL_INTERNAL', JXL_CODEC: 'JXL_INTERNAL', JXL_DICTIONARY: 'JXL_INTERNAL', JXL_ENCODE: 'JXL_INTERNAL',
  JXL_GPU: 'JXL_INTERNAL', JXL_GPU_NATIVE_UNPROVEN: 'JXL_INTERNAL', JXL_INITIALIZE: 'JXL_INTERNAL',
  JXL_MEMORY_GPU_UNPROVEN: 'JXL_INTERNAL', JXL_OPERATION: 'JXL_INTERNAL', JXL_PART: 'JXL_INTERNAL'};
const CALLER = new WeakSet();
export function isCaller(value) { try { return CALLER.has(value); } catch { return false; } }
export function callers(value) {
  try { if (value !== null && (typeof value === 'object' || typeof value === 'function')) CALLER.add(value); } catch {}
  return value;
}
export function declared(error) {
  try {
    if (CALLER.has(error)) return error;
    const code = error?.code;
    if (typeof code !== 'string' || !code.startsWith('JXL_') || DECLARED.has(code)) return error;
    const named = Object.hasOwn(AS, code) ? AS[code] : 'JXL_INTERNAL';
    return Object.assign(new Error(String(error.message ?? ''), {cause: error}), {code: named});
  } catch { return error; }
}
export function admitSignal(signal) {
  if (signal === undefined) return undefined;
  if (!signal || typeof signal !== 'object' && typeof signal !== 'function' || typeof signal.aborted !== 'boolean' || typeof signal.addEventListener !== 'function')
    throw fail('JXL_OPTIONS', 'signal must be an AbortSignal.');
  return signal;
}
export function check(signal) {
  if (signal === undefined || signal === null) return;
  let aborted, reason;
  try { aborted = signal.aborted; if (aborted) reason = signal.reason; } catch (error) { throw callers(error); }
  if (!aborted) return;
  throw reason === undefined ? fail('JXL_ABORTED', 'The job was aborted.') : callers(reason);
}
export function progressOf(onProgress, signal) {
  if (!onProgress) return undefined;
  let last = -1;
  const tell = fraction => { last = fraction; try { onProgress(fraction); } catch (error) { throw callers(error); } check(signal); };
  return fraction => { if (last < 0) tell(0); if (fraction > last && fraction <= 1) tell(fraction); };
}
export function object(value, name = 'Options') {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail('JXL_OPTIONS', `${name} must be an object.`);
  return value;
}
export function dimensions(width, height, maxPixels = 40000000) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width > EDGE || height > EDGE)
    throw fail('JXL_DIMENSIONS', `Sides are whole numbers from 1 to ${EDGE} pixels.`);
  if (width * height > maxPixels)
    throw fail('JXL_DIMENSIONS', `${width * height} pixels is over maxPixels (${maxPixels}): resize or raise maxPixels.`);
}
export const JPEG_ELSEWHERE = 'A JPEG is recompressed by rapier-jxl/jpeg: recompress(bytes).';
export const NO_JPEG = 'The file contains no JPEG reconstruction data: only a file made by recompress() from a JPEG restores one. Decode it for its pixels.';
export const LARGEST = 268435456;
export const JPEG_PIXELS = 64000000;
export function jpegPixels(value) {
  if (value === undefined) return JPEG_PIXELS;
  if (!Number.isSafeInteger(value) || value < 1 || value > JPEG_PIXELS) throw fail('JXL_OPTIONS', 'maxPixels is a positive whole number, at most 64,000,000.');
  return value;
}
export function pixelLimit(value, largest = 40000000) {
  if (value === undefined) return 40000000;
  if (!Number.isSafeInteger(value) || value < 1 || value > largest) throw fail('JXL_OPTIONS', `maxPixels is a positive whole number, at most ${largest.toLocaleString('en-US')}.`);
  return value;
}
export function bytes(input) {
  if (!(input instanceof Uint8Array) || !input.length) throw fail('JXL_INPUT', 'Encoded input must be a nonempty Uint8Array.');
  return input;
}
export function webgpuSetting(value) {
  if (value !== undefined && value !== 'required' && value !== false)
    throw fail('JXL_OPTIONS', "webgpu is 'required' or false, or left out.");
  return value;
}
