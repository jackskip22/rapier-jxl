export const fail = (code, message) => Object.assign(new Error(message), {code});
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
export function object(value, name = 'Options') {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail('JXL_OPTIONS', `${name} must be an object.`);
  return value;
}
export function dimensions(width, height, maxPixels = 40000000) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 ||
      width > 16384 || height > 16384 || width * height > maxPixels)
    throw fail('JXL_DIMENSIONS', 'Image dimensions exceed the configured limit.');
}
export function pixelLimit(value) {
  if (value === undefined) return 40000000;
  if (!Number.isSafeInteger(value) || value < 1 || value > 40000000) throw fail('JXL_OPTIONS', 'maxPixels is a positive whole number, at most 40,000,000.');
  return value;
}
export function bytes(input) {
  if (!(input instanceof Uint8Array) || !input.length) throw fail('JXL_INPUT', 'Encoded input must be a nonempty Uint8Array.');
  return input;
}
