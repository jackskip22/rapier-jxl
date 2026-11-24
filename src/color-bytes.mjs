// SPDX-License-Identifier: MIT
import {kernelCaller, bands, part, partOut, out, room, BAND} from './kernel-call.mjs';
import {kernelModule} from './kernel-runtime.mjs';
import {OPSIN, inverse, times, SRGB_CURVE} from './color-transform.mjs';

let held = null;
const call = /* @__PURE__ */ kernelCaller(lay => {
  if (!held) {
    const memory = new WebAssembly.Memory({initial: 20});
    const {exports} = new WebAssembly.Instance(kernelModule(), {env: {memory}});
    held = {...exports, memory};
  }
  const at = lay(0), have = held.memory.buffer.byteLength;
  if (at.end > have) held.memory.grow(Math.ceil((at.end - have) / 65536));
  return {k: held, at};
}, error => { throw error; });
const run = /* @__PURE__ */ bands(call, 65536), CONSTANTS = new WeakMap();
let LEVELS = null;
const levels = () => LEVELS ??= call(k => k.srgbLevels, [out(Float64Array, 257), out(Uint8Array, 8192)]).slice(1);
export const wideLevels = () => levels()[0].subarray(0, 256);
const isSrgb = t => t === SRGB_CURVE || t?.length === 256 && t.every((v, i) => v === SRGB_CURVE[i]);
function constants(transform) {
  let at = CONSTANTS.get(transform);
  if (!at) {
    const back = transform.lms ? times(inverse(OPSIN), transform.lms) : [1, 0, 0, 0, 1, 0, 0, 0, 1];
    at = new Float64Array(1043);
    at.set(transform.lms ? inverse(back) : back); at.set(back, 9); transform.tables.forEach((t, c) => at.set(t, 18 + c * 256));
    at.srgb = transform.tables.every(isSrgb) ? 1 : 0;
    at.leveled = false;
    CONSTANTS.set(transform, at);
  }
  return at;
}
const linear = pixels => [0, 1, 2].map(() => new Float64Array(pixels));
function coded(planes, pixels, transform, rgba, lin) {
  const at = constants(transform), {srgb} = at, T = planes.every(p => p instanceof Float32Array) ? Float32Array : Float64Array;
  const OutT = lin?.[0] instanceof Float32Array ? Float32Array : Float64Array;
  if (srgb && !at.leveled) { at.set(levels()[0], 786); at.leveled = true; }
  const first = srgb ? levels()[1] : new Uint8Array(0);
  run(k => k.codedBytes, pixels, [...planes.map(p => part(T, p)), T === Float32Array ? 1 : 0, BAND, at, first, srgb,
    rgba ? partOut(Uint8Array, rgba, 4) : (at, n) => room(n * 4), ...lin ? lin.map(p => partOut(OutT, p)) : [0, 0, 0], OutT === Float32Array ? 1 : 0]);
  return rgba ?? lin;
}
export const codedBytesFromLinear = (planes, pixels, transform, into = new Uint8Array(pixels * 4)) => coded(planes, pixels, transform, into);
export const linearOfCodedBytes = (planes, pixels, transform, into = linear(pixels), rgba = null) => (coded(planes, pixels, transform, rgba, into), into);
export function linearFromTransform(rgba, pixels, transform, into = linear(pixels)) {
  const OutT = into[0] instanceof Float32Array ? Float32Array : Float64Array;
  run(k => k.linearBytes, pixels, [part(Uint8Array, rgba, 4), BAND, constants(transform), ...into.map(p => partOut(OutT, p)), OutT === Float32Array ? 1 : 0]);
  return into;
}
