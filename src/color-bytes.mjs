// SPDX-License-Identifier: MIT
import {kernelCall, bands, part, partOut, out, room, BAND} from './kernel-call.mjs';
import {OPSIN, inverse, times, SRGB_CURVE} from './color-transform.mjs';

const run = /* @__PURE__ */ bands(kernelCall, 65536), CONSTANTS = new WeakMap();
let LEVELS = null;
const levels = () => LEVELS ??= kernelCall(k => k.srgbLevels, [out(Float64Array, 257), out(Uint8Array, 8192)]).slice(1);
export const wideLevels = () => levels()[0].subarray(0, 256);
function constants(transform) {
  let at = CONSTANTS.get(transform);
  if (at) return at;
  const back = times(inverse(OPSIN), transform.lms);
  at = new Float64Array(1043);
  at.set(inverse(back)); at.set(back, 9); transform.tables.forEach((t, c) => at.set(t, 18 + c * 256));
  CONSTANTS.set(transform, at);
  return at;
}
const linear = pixels => [0, 1, 2].map(() => new Float64Array(pixels));
function coded(planes, pixels, transform, rgba, lin) {
  const srgb = transform.tables.every(t => t === SRGB_CURVE) ? 1 : 0, T = planes.every(p => p instanceof Float32Array) ? Float32Array : Float64Array;
  const at = constants(transform), [steps, first] = srgb ? levels() : [[], new Uint8Array(0)];
  at.set(steps, 786);
  run(k => k.codedBytes, pixels, [...planes.map(p => part(T, p)), T === Float32Array ? 1 : 0, BAND, at, first, srgb,
    rgba ? partOut(Uint8Array, rgba, 4) : (at, n) => room(n * 4), ...lin ? lin.map(p => partOut(Float64Array, p)) : [0, 0, 0]]);
  return rgba ?? lin;
}
export const codedBytesFromLinear = (planes, pixels, transform) => coded(planes, pixels, transform, new Uint8Array(pixels * 4));
export const linearOfCodedBytes = (planes, pixels, transform, into = linear(pixels)) => coded(planes, pixels, transform, null, into);
export function linearFromTransform(rgba, pixels, transform, into = linear(pixels)) {
  run(k => k.linearBytes, pixels, [part(Uint8Array, rgba, 4), BAND, constants(transform), ...into.map(p => partOut(Float64Array, p))]);
  return into;
}
