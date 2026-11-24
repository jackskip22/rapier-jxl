// SPDX-License-Identifier: MIT
import {s2Dimensions, s2Samples} from './ssimulacra2-input.mjs';
import {releaseReferenceArena} from './ssimulacra2-arithmetic.mjs';
import {fault} from './fault.mjs';
export const SCALES = 6, S2_REFERENCE = Symbol('SSIMULACRA2 reference');

export function planReferenceScales(width, height, cacheBytes, libjxl = false) {
  let w = Math.max(8, width), h = Math.max(8, height), left = cacheBytes;
  const dims = [];
  for (let scale = 0; scale < SCALES; scale++) {
    if (w < 8 || h < 8) break;
    if (scale) { w = (w + 1) >> 1; h = (h + 1) >> 1; }
    dims.push({scale, width: w, height: h, pixels: w * h, keep: false, bytes: 0});
  }
  for (let i = dims.length - 1; i >= 0; i--) {
    const d = dims[i], p = d.pixels;
    if (p * 36 <= left) { d.keep = true; d.bytes = p * 36; left -= d.bytes; }
    else if (i === 0 && !libjxl && p * 20 <= left) { d.keep = 'y-ms'; d.bytes = p * 20; left -= d.bytes; }
    else if (i === 0 && p * 12 <= left) { d.keep = 'p1'; d.bytes = p * 12; left -= d.bytes; }
  }
  return {dims, left};
}

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

export function ssimulacra2Reference(reference, width, height, options = {}) {
  for (const key of Object.keys(options ?? {})) if (key !== 'cacheBytes' && key !== 'immutable' && key !== 'arithmetic')
    throw fault('JXL_OPTIONS', 'unknown option: ' + key);
  const {cacheBytes = 0, immutable = false, arithmetic = 'binary64'} = options ?? {};
  const pixels = s2Dimensions(width, height);
  if (!Number.isSafeInteger(cacheBytes) || cacheBytes < 0) throw fault('JXL_INTERNAL', 'ssimulacra2-reference:cacheBytes');
  let inputBytes = 0;
  if (typeof reference !== 'function') reference = s2Samples(reference, pixels);
  if (!immutable && typeof reference !== 'function') {
    const snapshot = s2ReferenceSnapshot(reference, pixels); reference = snapshot.source; inputBytes = snapshot.bytes;
  }
  if (arithmetic !== 'binary64' && arithmetic !== 'libjxl') throw new RangeError('arithmetic: binary64 or libjxl');
  const {dims, left} = planReferenceScales(width, height, cacheBytes, arithmetic === 'libjxl');
  const state = {
    reference, width, height,
    scales: dims.map(d => d.keep ? [] : null),
    sizes: dims.map(({width: sw, height: sh, keep, bytes}) => ({width: sw, height: sh, keep, bytes})),
    cacheBytes: 0, inputBytes, busy: false, arena: null, released: false, arithmetic,
  };
  return Object.freeze({[S2_REFERENCE]: state, reservedBytes: cacheBytes - left,
    get cacheBytes() { return state.cacheBytes; }, get inputBytes() { return state.inputBytes; },
    get arenaBytes() { return state.arena?.memory?.buffer.byteLength ?? 0; },
    release() {
      if (state.busy) throw fault('JXL_INTERNAL', 'ssimulacra2-reference:busy');
      releaseReferenceArena(state.arena);
      state.released = true; state.arena = null; state.reference = null; state.inputBytes = 0; state.cacheBytes = 0;
      state.scales = state.scales.map(() => null);
    }});
}
