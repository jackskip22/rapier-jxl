// SPDX-License-Identifier: MIT
import {fault} from './fault.mjs';

export const READ_BATCH_PARTS = 128;
export const READ_BATCH_BYTES = 8 * 1048576;
const fail = message => { throw fault('JXL_INPUT', message); };

export async function prefetchParts(io, refs) {
  if (!Array.isArray(refs)) fail('A part frontier is an ordered array.');
  const unique = new Map();
  for (const ref of refs) {
    if (!ref || typeof ref.hash !== 'string' || !ref.hash.length || !Number.isSafeInteger(ref.length) ||
        ref.length < 0 || ref.length > 1048576 || Object.keys(ref).length !== 2)
      fail('Invalid part frontier reference.');
    if (unique.has(ref.hash) && unique.get(ref.hash).length !== ref.length) fail('Conflicting part frontier lengths.');
    unique.set(ref.hash, ref);
  }
  if (io.durable === false || !unique.size) return;
  if (typeof io.prefetch !== 'function') fail('The immutable part reader must support declared read frontiers.');
  let batch = [], bytes = 0;
  for (const ref of unique.values()) {
    if (batch.length === READ_BATCH_PARTS || bytes + ref.length > READ_BATCH_BYTES) {
      await io.prefetch(batch); batch = []; bytes = 0;
    }
    batch.push(ref); bytes += ref.length;
  }
  if (batch.length) await io.prefetch(batch);
}
