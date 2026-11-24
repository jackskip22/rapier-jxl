// SPDX-License-Identifier: MIT
import {kernelFlat, kernelBuffer, arenaHolder, takeArena, growArena} from './kernel-runtime.mjs';

const spec = (T, size, put, back = null) => ({T, size, bytes: size * T.BYTES_PER_ELEMENT, put, back});
const zeroed = to => to.fill(0);
export const into = (T, a, n = a.length, back) => {
  const buf = kernelBuffer(), src = buf && a.buffer === buf ? a.slice(0, n) : n === a.length ? a : a.subarray(0, n);
  return spec(T, n, to => to.set(src), back ? n : null);
};
export const both = (T, a, n) => into(T, a, n, 1);
export const rect = (T, a, stride, x, y, w, h, size = 1) => {
  const buf = kernelBuffer();
  if (buf && a.buffer === buf) {
    const copy = new a.constructor(w * h * size);
    for (let row = 0; row < h; row++) copy.set(a.subarray(((y + row) * stride + x) * size, ((y + row) * stride + x + w) * size), row * w * size);
    return spec(T, w * h * size, to => to.set(copy));
  }
  return spec(T, w * h * size, to => {
    for (let row = 0; row < h; row++) to.set(a.subarray(((y + row) * stride + x) * size, ((y + row) * stride + x + w) * size), row * w * size);
  });
};
export const out = (T, n, zero) => spec(T, n, zero ? zeroed : null, n);
export const outUpTo = (T, most, count, zero) => spec(T, most, zero ? zeroed : null, count);
export const room = (n, zero) => spec(Uint8Array, n, zero ? zeroed : null);
export const made = spec;

export const kernelCaller = (place, fail) => (pick, args, views) => {
  try {
    const specs = args.map(a => typeof a === 'number' ? null : ArrayBuffer.isView(a) ? into(a.constructor, a) : a);
    const {k, at} = place(start => {
      let end = start;
      return {offsets: specs.map(s => s && (end = (end + 15 & ~15) + s.bytes) - s.bytes), end};
    });
    const buffer = k.memory.buffer, view = (s, i, n) => new s.T(buffer, at.offsets[i], n);
    const result = [pick(k)(...args.map((a, i) => specs[i] ? (specs[i].put?.(view(specs[i], i, specs[i].size)), at.offsets[i]) : a))];
    specs.forEach((s, i) => {
      if (s?.back == null) return;
      const got = view(s, i, typeof s.back === 'function' ? s.back(result[0]) : s.back);
      result.push(views ? got : got.slice());
    });
    return result;
  } catch (error) { return fail(error); }
};

export const BAND = {};
export const part = (T, a, size = 1) => (at, n) => into(T, a.subarray(at * size, (at + n) * size));
export const partOut = (T, a, size = 1) => Object.assign((at, n) => out(T, n * size), {to: a, size});
export const bands = (call, most) => (pick, pixels, args) => {
  for (let at = 0; at < pixels; at += most) {
    const n = Math.min(most, pixels - at), made = args.map(a => a === BAND ? n : typeof a === 'function' ? a(at, n) : a),
      got = call(pick, made, true);
    let r = 1;
    made.forEach((m, i) => { if (m?.back != null) { if (args[i]?.to) args[i].to.set(got[r], at * args[i].size); r++; } });
  }
};

const shared = /* @__PURE__ */ arenaHolder(() => {});
export const kernelCall = /* @__PURE__ */ kernelCaller(lay => {
  const k = kernelFlat();
  takeArena(shared);
  const at = lay(65536);
  growArena(at.end);
  return {k, at};
}, error => { throw error; });
