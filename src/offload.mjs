// SPDX-License-Identifier: MIT
let depth = 0, workers = 1, stage = null;
export const offloading = kind => depth > 0 && (stage === null || stage === kind);
export const offloadWorkers = () => depth > 0 ? workers : 1;
export function stepOffloaded(steps, reply, count = 1, only = null) {
  const outer = [workers, stage]; depth++; workers = count; stage = only;
  try { return steps.next(reply); } finally { depth--; [workers, stage] = outer; }
}
export const sharing = () => offloading() && typeof SharedArrayBuffer === 'function' && globalThis.crossOriginIsolated !== false;
export const shareable = (Type, length) => sharing() ? new Type(new SharedArrayBuffer(length * Type.BYTES_PER_ELEMENT)) : new Type(length);
