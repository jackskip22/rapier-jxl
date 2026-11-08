// SPDX-License-Identifier: MIT
export const TYPED_VIEW = Symbol('rapier-jxl/typed-view');
export const TYPED_FAULT = Symbol('rapier-jxl/typed-fault');
export const TYPED_PREFETCH = Symbol('rapier-jxl/typed-prefetch');
export const TYPED_RESIZE = Symbol('rapier-jxl/typed-resize');
export function prefetchTyped(...requests) {
  for (const [view] of requests) if (view[TYPED_PREFETCH]) return view[TYPED_PREFETCH](requests);
}
let allocator = null;
export const allocateTyped = (Type, length) => allocator ? allocator(Type, length) : new Type(length);
export function withTypedAllocator(next, operation) {
  const previous = allocator; allocator = next;
  try { return operation(); } finally { allocator = previous; }
}
export function reinterpretTyped(view, Type, length = view.byteLength / Type.BYTES_PER_ELEMENT) {
  if (!Number.isSafeInteger(length) || length < 0 || length * Type.BYTES_PER_ELEMENT > view.byteLength)
    throw new RangeError('Reinterpreted view exceeds its logical source span.');
  if (view[TYPED_VIEW]) return view[TYPED_VIEW](Type, length);
  return new Type(view.buffer, view.byteOffset, length);
}
