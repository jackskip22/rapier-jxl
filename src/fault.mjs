// SPDX-License-Identifier: MIT
export const fault = (code, message) => Object.assign(new Error(message), {code});
export const abortError = () => typeof DOMException === 'function' ? new DOMException('The operation was aborted.', 'AbortError')
  : Object.assign(new Error('The operation was aborted.'), {name: 'AbortError'});
export const abortReason = signal => { let reason; try { reason = signal?.reason; } catch (error) { reason = error; } return reason === undefined ? abortError() : reason; };
const REFUSED = /allocation failed|out of memory|(?:cannot|could not) allocate|(?:failed|unable) to grow|maximum memory size|declared maximum|allocation size overflow|invalid string length/i;
export const outOfMemory = error => {
  try { return (error instanceof RangeError || error?.name === 'RangeError' || error?.name === 'InternalError') && !error.code && REFUSED.test(String(error.message)); }
  catch { return false; }
};
export const hostShort = error => outOfMemory(error) || error?.code === 'JXL_MEMORY' &&
  (outOfMemory(error.cause) || /grow failed|out of memory/i.test(String(error.message)));
export const hostWords = error => error?.message ? ` (${String(error.message)})` : '';
const CAPTURE_REFUSALS = new Set(['JXL_DIMENSIONS', 'JXL_FRAMING', 'JXL_INPUT', 'JXL_MEMORY', 'JXL_SIZE', 'JXL_UNSUPPORTED', 'JXL_WASM']);
export const captureRefused = error => CAPTURE_REFUSALS.has(error?.code);
