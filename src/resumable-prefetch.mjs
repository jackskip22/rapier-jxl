// SPDX-License-Identifier: MIT
import {fault} from './fault.mjs';

const READ_BATCH_PARTS = 128;
export const READ_BATCH_BYTES = 8 * 1048576;
const fail = message => { throw fault('JXL_INPUT', message); };

export async function prefetchParts(io, refs, consume) {
  if (!Array.isArray(refs)) fail('frontier: array');
  const unique = new Map();
  for (const ref of refs) {
    if (!ref || typeof ref.hash !== 'string' || !ref.hash.length || !Number.isSafeInteger(ref.length) ||
        ref.length < 0 || ref.length > 1048576 || Object.keys(ref).length !== 2)
      fail('frontier ref');
    if (unique.has(ref.hash) && unique.get(ref.hash).length !== ref.length) fail('frontier: length conflict');
    unique.set(ref.hash, ref);
  }
  if (!unique.size) return;
  if (io.durable === false) { await consume?.([...unique.values()]); return; }
  if (typeof io.prefetch !== 'function') fail('io.prefetch: function');
  let batch = [], bytes = 0;
  for (const ref of unique.values()) {
    if (batch.length === READ_BATCH_PARTS || bytes + ref.length > READ_BATCH_BYTES) {
      await io.prefetch(batch); await consume?.(batch); batch = []; bytes = 0;
    }
    batch.push(ref); bytes += ref.length;
  }
  if (batch.length) { await io.prefetch(batch); await consume?.(batch); }
}
