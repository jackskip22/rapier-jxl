import {EDGE, PIXELS} from '../limits.mjs';
import {outOfMemory, hostWords, abortError} from '../fault.mjs';
export {abortError};
export {PIXELS};
export const fail = (code, message) => Object.assign(new Error(message), {code});
const FILES = [[[0x89, 0x50, 0x4e, 0x47], 'PNG'], [[0xff, 0xd8, 0xff], 'JPEG'], [[0x47, 0x49, 0x46, 0x38], 'GIF'], [[0x52, 0x49, 0x46, 0x46], 'WebP']];
export const filePassed = view => {
  if (typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true) return null;
  if ((view instanceof ArrayBuffer ? view : ArrayBuffer.isView(view) ? view.buffer : null)?.detached) return null;
  let bytes;
  try {
    bytes = ArrayBuffer.isView(view) ? new Uint8Array(view.buffer, view.byteOffset, Math.min(view.byteLength, 4))
      : view instanceof ArrayBuffer ? new Uint8Array(view, 0, Math.min(view.byteLength, 4)) : null;
  } catch { return null; }
  const kind = bytes && FILES.find(([magic]) => magic.every((byte, i) => bytes[i] === byte))?.[1];
  return kind ? `These are ${kind} file bytes, not pixels; pass new Blob([bytes]).` : null;
};
const shownQuality = options => {
  const q = options?.quality;
  return typeof q === 'number' || typeof q === 'string' || typeof q === 'boolean' ? `{quality: ${q}}` : '{quality}';
};
export const unknownOption = (key, options, what = 'option', after = '') => fail('JXL_OPTIONS', `unknown ${what}: ${String(key)}${
  typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true ? '' : key === 'quality'
  ? `; write fidelity: ${shownQuality(options)}` : key === 'lossless' ? "; write fidelity: 'exact'" : ''}${after}`);
const PASS = 'pass pixels {data, width, height}, ImageData, a canvas, a bitmap, or an image file as a Blob.';
export const unreadInput = input => {
  let element = false;
  try { element = input?.nodeType === 1; } catch {  }
  return element ? 'A page element is not an image; capture it with SnapDOM, or ' + PASS : 'The image input is invalid; ' + PASS;
};
export const preparedAlone = run => operation => operation === undefined ? run() : Promise.reject(fail('JXL_OPTIONS', 'prepare(): no argument'));
export const lostBlank = (context, data) => {
  if (!context?.isContextLost?.()) return false;
  const words = new Uint32Array(data.buffer, data.byteOffset, data.byteLength >> 2);
  for (let i = 0; i < words.length; i++) if (words[i]) return false;
  return true;
};
export const LOST = "canvas lost: redraw";
export const gpuDrawn = data => {
  if (typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true) return data;
  if (new Uint8Array(data.buffer, data.byteOffset, data.byteLength).some(Boolean)) return data;
  throw fail('JXL_INPUT', 'GPU canvas blank: read it in the task that draws it, or set preserveDrawingBuffer: true');
};
export function proveRead(context) {
  if (context?.isContextLost?.() || typeof context?.putImageData !== 'function' || typeof context.createImageData !== 'function') return;
  const half = context.getContextAttributes?.().colorType === 'float16';
  const native = () => context.getImageData(0, 0, 1, 1, half ? {pixelFormat: 'rgba-float16'} : undefined);
  let saved;
  try { saved = native(); }
  catch (cause) { throw Object.assign(fail('JXL_INPUT', "canvas read failed: redraw with readable sources or pass RGBA pixels"), {cause}); }
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
const bufferLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength').get;
let blobSize;
export function isBlob(value) {
  if (value === null || typeof value !== 'object') return false;
  if (blobSize === undefined) { if (typeof Blob !== 'function') return false; blobSize = Object.getOwnPropertyDescriptor(Blob.prototype, 'size')?.get ?? null; }
  if (!blobSize) return false;
  try { blobSize.call(value); return true; } catch { return false; }
}
export function arrayBufferBytes(value) {
  if (ArrayBuffer.isView(value)) return null;
  try { return bufferLength.call(value); } catch { return null; }
}
const typed = Object.getPrototypeOf(Uint8Array.prototype), field = key => Object.getOwnPropertyDescriptor(typed, key).get;
export const typedName = field(Symbol.toStringTag), typedFields = Object.fromEntries(['buffer', 'byteOffset', 'byteLength', 'length'].map(key => [key, field(key)]));
const kindOf = view => { const name = typedName.call(view), kind = name && globalThis[name]; return typeof kind === 'function' ? kind : undefined; };
export const plainView = view => {
  const kind = kindOf(view);
  if (!kind || view.constructor === kind) return view;
  try { return new kind(typedFields.buffer.call(view), typedFields.byteOffset.call(view), typedFields.length.call(view)); }
  catch { throw fail('JXL_INPUT', "ArrayBuffer: live and sized"); }
};
export const plainCopy = view => new (kindOf(view) ?? view.constructor)(view);
const DECLARED = new Set(['JXL_OPTIONS', 'JXL_INPUT', 'JXL_DIMENSIONS', 'JXL_JPEG', 'JXL_DECODE', 'JXL_RECONSTRUCTION', 'JXL_TARGET',
  'JXL_PLATFORM', 'JXL_MEMORY', 'JXL_LIMIT', 'JXL_WASM', 'JXL_WEBGPU', 'JXL_WORKER',
  'JXL_CLOSED', 'JXL_UNSUPPORTED', 'JXL_INTERNAL', 'JXL_IO', 'JXL_SETUP']);
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
    if (outOfMemory(error)) return Object.assign(new Error(`memory: shrink picture${hostWords(error)}`, {cause: error}), {code: 'JXL_MEMORY'});
    const code = error?.code;
    if (typeof code !== 'string' || !code.startsWith('JXL_') || DECLARED.has(code)) return error;
    const named = Object.hasOwn(AS, code) ? AS[code] : 'JXL_INTERNAL';
    return Object.assign(new Error(String(error.message ?? ''), {cause: error}), {code: named});
  } catch { return error; }
}
export function admitSignal(signal) {
  if (signal === undefined) return undefined;
  if (!signal || typeof signal !== 'object' && typeof signal !== 'function') throw fail('JXL_OPTIONS', "signal: AbortSignal");
  let aborted, listen;
  try { aborted = signal.aborted; listen = signal.addEventListener; } catch (error) { throw callers(error); }
  if (typeof aborted !== 'boolean' || typeof listen !== 'function') throw fail('JXL_OPTIONS', "signal: AbortSignal");
  return signal;
}
export function check(signal) {
  if (signal === undefined || signal === null) return;
  let aborted, reason;
  try { aborted = signal.aborted; if (aborted) reason = signal.reason; } catch (error) { throw callers(error); }
  if (!aborted) return;
  throw callers(reason === undefined ? abortError() : reason);
}
const heads = new WeakMap();
export function blobHead(blob) {
  let head = heads.get(blob);
  if (!head) { head = blobRead(blob, undefined, 0, 32); heads.set(blob, head); head.catch(() => heads.delete(blob)); }
  return head;
}
export async function blobBytes(blob, signal, start, end) {
  if (start === 0 && end === 32) { check(signal); const head = await abortable(blobHead(blob), signal); check(signal); return head.slice(); }
  return blobRead(blob, signal, start, end);
}
async function blobRead(blob, signal, start, end) {
  check(signal);
  let stop;
  try {
    const stopped = signal && new Promise((resolve, reject) => {
      stop = () => { try { check(signal); } catch (error) { reject(error); } };
      signal.addEventListener('abort', stop, {once: true});
    });
    if (stopped) { stopped.catch(() => {}); check(signal); }
    const part = start === undefined ? blob : blob.slice(start, end), read = Promise.resolve(part.arrayBuffer());
    if (stopped) read.catch(() => {});
    const buffer = await (stopped ? Promise.race([read, stopped]) : read);
    check(signal);
    if (arrayBufferBytes(buffer) !== part.size) throw fail('JXL_INPUT', "file changed: reselect");
    return new Uint8Array(buffer);
  } catch (cause) {
    if (isCaller(cause) || (typeof cause?.code === 'string' && cause.code.startsWith('JXL_'))) throw cause;
    let aborted = false; try { aborted = signal?.aborted === true && Object.is(signal.reason, cause); } catch {}
    if (aborted) throw cause;
    throw Object.assign(outOfMemory(cause) ? fail('JXL_MEMORY', `file read: memory${hostWords(cause)}`)
      : cause?.name === 'NotReadableError' ? fail('JXL_INPUT', "file changed: reselect")
      : fail('JXL_IO', "file read: retry"), {cause});
  } finally { if (stop) try { signal.removeEventListener?.('abort', stop); } catch {} }
}
export function abortable(pending, signal, discard) {
  if (!signal) return Promise.resolve(pending);
  return new Promise((resolve, reject) => {
    let done = false;
    const drop = value => { try { discard?.(value); } catch {} };
    const settle = (finish, value) => {
      if (done) { if (finish === resolve) drop(value); return; }
      done = true;
      try { signal.removeEventListener?.('abort', stop); }
      catch (reason) {
        if (finish === resolve) { drop(value); reject(callers(reason)); return; }
      }
      finish(value);
    };
    const stop = () => { try { check(signal); } catch (reason) { settle(reject, reason); } };
    Promise.resolve(pending).then(value => settle(resolve, value), reason => settle(reject, reason));
    try { signal.addEventListener('abort', stop, {once: true}); stop(); }
    catch (reason) { settle(reject, callers(reason)); }
  });
}
export function progressOf(onProgress, signal, onRejected) {
  if (onProgress === undefined) return undefined;
  if (typeof onProgress !== 'function') throw fail('JXL_OPTIONS', "onProgress: function");
  let last = -1, rejected = null, pending;
  const checked = () => { if (rejected) throw callers(rejected.reason); check(signal); };
  const tell = fraction => {
    checked();
    last = fraction;
    try {
      const answer = onProgress(fraction);
      if (answer && typeof answer.then === 'function') {
        pending ??= new Set();
        const settled = Promise.resolve(answer).then(() => { pending.delete(settled); }, reason => {
          pending.delete(settled); rejected ??= {reason}; onRejected?.(reason); throw callers(reason);
        });
        settled.catch(() => {});
        pending.add(settled);
      }
    } catch (error) { rejected ??= {reason: error}; throw callers(error); }
    check(signal);
  };
  const progress = fraction => { if (last < 0) tell(0); if (fraction > last && fraction <= 1) tell(fraction); };
  progress.finish = () => { checked(); return pending?.size ? abortable(Promise.all(pending), signal).then(checked) : undefined; };
  progress.isCaller = error => !!rejected && Object.is(rejected.reason, error);
  return progress;
}
export function object(value, name = 'Options') {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail('JXL_OPTIONS', `${name}: object`);
  const tag = Object.prototype.toString.call(value).slice(8, -1);
  if (tag !== 'Object') throw fail('JXL_OPTIONS', `${name}: an options object, not a ${tag}`);
  return value;
}
export const OPTION_SYMBOLS = /* @__PURE__ */ new Set([
  Symbol.for('rapier-jxl.fit.bytes'),
  Symbol.for('rapier-jxl.retain-input'),
  Symbol.for('rapier-jxl.jpeg-source'),
  Symbol.for('rapier-jxl.journal'),
  Symbol.for('rapier-jxl.decoder.snapshot'),
  Symbol.for('rapier-jxl.configured-webgpu'),
  Symbol.for('rapier-jxl.groups'),
]);
export const optionSymbol = description => { const s = Symbol(description); OPTION_SYMBOLS.add(s); return s; };
export function rejectOptionSymbols(value, what = 'option') {
  for (const key of Object.getOwnPropertySymbols(value)) {
    if (!Object.prototype.propertyIsEnumerable.call(value, key) || OPTION_SYMBOLS.has(key)) continue;
    throw fail('JXL_OPTIONS', `unknown ${what}: ${String(key)}`);
  }
}
export function snapshotOptions(value, name, fields = [], checkSymbols = name === undefined || name === 'Options' || name === 'options') {
  const supplied = object(value, name);
  let options;
  try {
    options = {...supplied};
    for (const key of fields) if (!Object.hasOwn(options, key) && key in supplied) options[key] = supplied[key];
  } catch (error) { throw callers(error); }
  if (checkSymbols) rejectOptionSymbols(options);
  return options;
}
export function snapshotArray(value, name = 'The list', exactLength, code = 'JXL_OPTIONS') {
  if (!Array.isArray(value)) throw fail(code, `${name}: array`);
  let length;
  try { length = value.length; } catch (error) { throw callers(error); }
  if (!Number.isInteger(length) || length < 0 || length > 0xffffffff)
    throw fail(code, `${name}: array length`);
  if (exactLength !== undefined && length !== exactLength)
    throw fail(code, `${name}: ${exactLength} items`);
  const copy = [];
  for (let i = 0; i < length; i++) {
    let present, item;
    try { present = i in value; if (present) item = value[i]; } catch (error) { throw callers(error); }
    if (!present) throw fail(code, `${name}: no holes`);
    copy[i] = item;
  }
  return copy;
}

export function dimensions(width, height, maxPixels = PIXELS, maxDimension = EDGE) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width > maxDimension || height > maxDimension)
    throw fail('JXL_DIMENSIONS', `sides: integer 1-${maxDimension}${maxDimension === EDGE ? ', JPEG XL size field' : ''}`);
  if (width * height > maxPixels)
    throw fail('JXL_DIMENSIONS', `${width * height} pixels: maxPixels ${maxPixels} exceeded`);
}
export const JPEG_ELSEWHERE = 'JPEG: use jpegxl/jpeg recompress(bytes)';
export const NO_JPEG = "original JPEG: absent, use recompress()";
export function pixelLimit(value) {
  if (value === undefined) return PIXELS;
  if (!Number.isSafeInteger(value) || value < 1) throw fail('JXL_OPTIONS', 'maxPixels: positive integer');
  return value;
}
export function bytes(input) {
  if (!(input instanceof Uint8Array) || !input.length) throw fail('JXL_INPUT', "input: nonempty Uint8Array");
  return input;
}
export function webgpuSetting(value) {
  if (value !== undefined && value !== 'required' && value !== false)
    throw fail('JXL_OPTIONS', "webgpu: 'required', false or omitted");
  return value;
}

export function admitKeys(settings, allowed) {
  for (const key of Object.keys(settings)) if (!allowed.includes(key)) throw fail('JXL_OPTIONS', 'unknown option: ' + key);
}
export function callHooks(options) {
  const {signal, onProgress} = options;
  admitSignal(signal);
  if (onProgress !== undefined && typeof onProgress !== 'function') throw fail('JXL_OPTIONS', 'onProgress: function');
  return {signal, progress: progressOf(onProgress, signal) ?? (() => {})};
}
