// SPDX-License-Identifier: MIT
let depth = 0, workers = 1;
export const offloading = () => depth > 0;
export const offloadWorkers = () => depth > 0 ? workers : 1;
export function stepOffloaded(steps, reply, count = 1) {
  const outer = workers; depth++; workers = count;
  try { return steps.next(reply); } finally { depth--; workers = outer; }
}
export const sharing = () => depth > 0 && typeof SharedArrayBuffer === 'function' && globalThis.crossOriginIsolated !== false;
export const shareable = (Type, length) => sharing() ? new Type(new SharedArrayBuffer(length * Type.BYTES_PER_ELEMENT)) : new Type(length);
