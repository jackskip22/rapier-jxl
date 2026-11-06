// SPDX-License-Identifier: MIT
import {exactPow} from './exact-math.mjs';
import {RGB8_THRESHOLDS} from './rgb8-thresholds.mjs';

export function toRGBA(linear, width, height) { return toRGBAInto(linear, 0, width * height, new Uint8ClampedArray(width * height * 4), 0); }
let RGBA_STEP_HI = null;
function rgbaStepHi(T) {
  const step = new Uint8Array(65536);
  let k = 0;
  for (let i = 0; i < 65536; i++) {
    const minV = i / 65536;
    while (k < 255 && minV >= T[k + 1]) k++;
    step[i] = k;
  }
  return step;
}

export function toRGBAInto(linear, from, count, out, at) {
  if (linear.every(p => p instanceof Float32Array)) {
    const T = RGB8_THRESHOLDS, S = RGBA_STEP_HI ??= rgbaStepHi(T);
    const L0 = linear[0], L1 = linear[1], L2 = linear[2];
    for (let i = 0; i < count; i++) {
      const idx = from + i, dst = (at + i) * 4;
      const v0 = L0[idx];
      if (!(v0 >= T[1])) out[dst] = 0;
      else if (v0 >= T[255]) out[dst] = 255;
      else { const k0 = S[(v0 * 65536) | 0]; out[dst] = v0 >= T[k0 + 1] ? k0 + 1 : k0; }
      const v1 = L1[idx];
      if (!(v1 >= T[1])) out[dst + 1] = 0;
      else if (v1 >= T[255]) out[dst + 1] = 255;
      else { const k1 = S[(v1 * 65536) | 0]; out[dst + 1] = v1 >= T[k1 + 1] ? k1 + 1 : k1; }
      const v2 = L2[idx];
      if (!(v2 >= T[1])) out[dst + 2] = 0;
      else if (v2 >= T[255]) out[dst + 2] = 255;
      else { const k2 = S[(v2 * 65536) | 0]; out[dst + 2] = v2 >= T[k2 + 1] ? k2 + 1 : k2; }
      out[dst + 3] = 255;
    }
    return out;
  }
  return toRGBAExact(linear, from, count, out, at);
}
export function toRGBAExact(linear, from, count, out, at) {
  const enc = v => v <= 0.0031308 ? 12.92 * v : 1.055 * exactPow(v, 1 / 2.4) - 0.055;
  for (let i = 0; i < count; i++) {
    for (let c = 0; c < 3; c++) out[(at + i) * 4 + c] = Math.round(255 * Math.min(1, Math.max(0, enc(linear[c][from + i]))));
    out[(at + i) * 4 + 3] = 255;
  }
  return out;
}


