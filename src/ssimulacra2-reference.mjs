// SPDX-License-Identifier: MIT
import {s2Dimensions, s2Samples} from './ssimulacra2-input.mjs';
import {releaseReferenceArena} from './ssimulacra2-arithmetic.mjs';
export const SCALES = 6, S2_REFERENCE = Symbol('SSIMULACRA2 reference');

export const s2Colors = () => ({});

function s2ReferenceSnapshot(reference, pixels) {
  if (reference.rgba) {
    const rgba = reference.rgba, values = rgba.subarray ? rgba.subarray(0, pixels * 4) : rgba.slice(0, pixels * 4);
    const copy = rgba instanceof Uint8Array || rgba instanceof Uint8ClampedArray ? new Uint8Array(values) : Float64Array.from(values);
    return {source: {rgba: copy}, bytes: copy.byteLength};
  }
  const source = [0, 1, 2].map(c => {
    const plane = reference[c];
    return Float64Array.from(plane.subarray ? plane.subarray(0, pixels) : plane.slice(0, pixels));
  });
  return {source, bytes: source.reduce((sum, plane) => sum + plane.byteLength, 0)};
}

export function ssimulacra2Reference(reference, width, height, {cacheBytes = 0, immutable = false} = {}) {
  const pixels = s2Dimensions(width, height);
  if (!Number.isSafeInteger(cacheBytes) || cacheBytes < 0) throw new RangeError('SSIMULACRA2 cacheBytes must be a nonnegative safe integer.');
  let inputBytes = 0;
  if (typeof reference !== 'function') reference = s2Samples(reference, pixels);
  if (!immutable && typeof reference !== 'function') {
    const snapshot = s2ReferenceSnapshot(reference, pixels); reference = snapshot.source; inputBytes = snapshot.bytes;
  }
  const state = {reference, width, height, scales: [], sizes: [], cacheBytes: 0, inputBytes, busy: false, arena: null, released: false};
  let w = Math.max(8, width), h = Math.max(8, height), left = cacheBytes;
  for (let scale = 0; scale < SCALES; scale++) {
    if (w < 8 || h < 8) break;
    if (scale) { w = (w + 1) >> 1; h = (h + 1) >> 1; }
    const bytes = w * h * 36, keep = bytes <= left;
    state.scales.push(keep ? [] : null); state.sizes.push({width: w, height: h, keep});
    if (keep) left -= bytes;
  }
  return Object.freeze({[S2_REFERENCE]: state, reservedBytes: cacheBytes - left,
    get cacheBytes() { return state.cacheBytes; }, get inputBytes() { return state.inputBytes; },
    get arenaBytes() { return state.arena?.memory?.buffer.byteLength ?? 0; },
    release() {
      if (state.busy) throw new Error('SSIMULACRA2 reference is in use.');
      releaseReferenceArena(state.arena);
      state.released = true; state.arena = null; state.reference = null; state.inputBytes = 0; state.cacheBytes = 0;
      state.scales = state.scales.map(() => null);
    }});
}

