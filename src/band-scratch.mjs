// SPDX-License-Identifier: MIT
const held = new Map();
const MOST = 16 * 1024 * 1024;
export function bandScratch(Type, slot, length) {
  if (typeof WeakRef !== 'function' || length * Type.BYTES_PER_ELEMENT > MOST) return new Type(length);
  const key = Type.name + ':' + slot;
  let kept = held.get(key)?.deref();
  if (!kept || kept.length < length) { kept = new Type(length); held.set(key, new WeakRef(kept)); }
  return kept.subarray(0, length);
}
