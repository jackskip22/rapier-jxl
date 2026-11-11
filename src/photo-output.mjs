// SPDX-License-Identifier: BSD-3-Clause
/*!
 * Copyright (c) the JPEG XL Project Authors.
 * All rights reserved.
 * 
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 * 
 * 1. Redistributions of source code must retain the above copyright notice, this
 *    list of conditions and the following disclaimer.
 * 
 * 2. Redistributions in binary form must reproduce the above copyright notice,
 *    this list of conditions and the following disclaimer in the documentation
 *    and/or other materials provided with the distribution.
 * 
 * 3. Neither the name of the copyright holder nor the names of its
 *    contributors may be used to endorse or promote products derived from
 *    this software without specific prior written permission.
 * 
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
 * AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
 * IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
 * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
 * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
 * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
 * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */

import {kernelHooks} from './kernel-hooks.mjs';

const f = Math.fround;
const DITHER = /* @__PURE__ */ Float32Array.from(atob("PNS2d2Sr7wN9L8AkeT6HmjZ/vPBCry1jIsNOM+lnnAGpI1DdNiZLlNwU+0df8hNT59coigfGVOW1DniuFITA/32V6gaK+sNwXKaIzAm6pmges1qlaP0YkHA68F/KRCtYEr1DYbCdDj/stjZulN4vzneSEeI3gaBGzd+jBZfcc+Q1bfLHHVZ7zioXVOkhfk7rO/lHynW52QtaJ4pN9R+3jtCkKIHZMuSjj2XYm0KyBIsZvpsAUSIx9ny/GmywPGMK+VMVk2e4SwH0gr4R/WHEpFdtLN3tsZJjqOI1yH/VnUmFruJBDP52xSBFrDDLcyTv2oCrXolu0hZAmFL7ECzowwRgc8qaqFk43V5wClGEmDRED/YbOEkIu+pyA6qNWXcgOdgv7hwrh7OV7dGi9uEW0mm3zZTFo/1YhiXaZe5Cupf0tIxIv23nCBl8KY47uUqniwdVdCXgfDDNtTrEohjOaRGhWgZ+2k/JQrtWHWoCeln8LeY/sBOaahuQTAuBKeBOeSPU+Kw2m/tnp/DbrcbqIcCeg9ViUOxDqvfjc1f/rYnpvD5qFWAjjRMzhUiZMGLZO20Y848BvtoNX58xxpMCNMlSmIXP7LV208IJcfgUgpIMqkq4MspxiCt90h+wY0RvGd8JLaVFAOFNXeUkzEG2T/XRXXsioT3xVLxG9BLW7p5dsnb0v1iVKoGgso9Xpd51KsIG4P5nFbGWBmyKOni5J/pHkRw3b8jxPRr/OGsD7hyciTmok0bV4yXIp+iZVQiIM9Fk54PXDqxpvQzXfy69XkVu6FQPg1p1NPhcGizM46kNxKASt0wjjN54SJfrr4vN+xfHLtCtwAmOTYDdvmZAfVJxJj/8p2L1VSzRYSBPPQ2ierNk7yA/6py3PQR0ox/xsYncW5V6MQOetBDBpHTk2SdNjwKZfmvXFGXPrP5LlNYBMOu7DNPB5UOE7Tf5BYVouPM+3jT6T6Uu8SKLMhPBYfedSWwdPJBwyxdokVbHL5tbEMJyXbwLh8V4UeBc6YM7dxfIrYbyWCamTHzfG7JG1B6Az58aqybnQ5cPu2+gJM9mkeMpUNu2Ev7VuCmhcuaM/K4tR+KN025f96k+zAuuVboIOH6hBWaaNWAAQfNiCjlTbATveTlOswAf1n8qS/zYRO1g0PlFxnmI6MKWgssVpL/YllnHEf2ZxDeOZfCWhx2omCGvchbfKEypHlYytOx7JUGGtSFphCjrduFTBcU1cdyAwVcxkLn1Ds51+NtJkVvhEPYz5qa9XEiqFrqi5F4PLkr3CuZAW5xqOo0HZhkrb6vJnXRQDds8B9BrJ0B6sfKMaxify4Ie07RS5Z+v1MP/AkpkG9KTe/OehvqS1hxRyQ=="),c=>Math.round((2*c.charCodeAt(0)-255)*13125/68)/1e5);
const P = /* @__PURE__ */ new Float32Array([-5.135152395e-4, 5.287254571e-3, 3.903842876e-1, 1.474205315, 7.352629620e-1]);
const Q = /* @__PURE__ */ new Float32Array([1.004519624e-2, 3.036675394e-1, 1.340816930, 9.258482155e-1, 2.424867759e-2]);
const LOW = f(0.0031308), SLOPE = f(12.92);
const P0 = P[0], P1 = P[1], P2 = P[2], P3 = P[3], P4 = P[4];
const Q0 = Q[0], Q1 = Q[1], Q2 = Q[2], Q3 = Q[3], Q4 = Q[4];
const word = new Uint32Array(1), single = new Float32Array(word.buffer);
const f64View = new Float64Array(1), u32View = new Uint32Array(f64View.buffer);
const ENC_KEYS = new Int32Array(1 << 16).fill(-1), ENC_VALS = new Float32Array(1 << 16);

function adjacent(value, up) {
  if (value === 0) return up ? 2 ** -149 : -(2 ** -149);
  single[0] = value; word[0] += (value > 0) === up ? 1 : -1;
  return single[0];
}
function fma(a, b, c) {
  const product = a * b, sum = product + c, rounded = f(sum);
  f64View[0] = sum;
  if ((u32View[0] & 0x1fffffff) !== 0x10000000) return rounded;
  const z = sum - product, residual = (product - (sum - z)) + (c - z);
  if (!residual || sum === rounded || !Number.isFinite(rounded)) return rounded;
  const other = adjacent(rounded, sum > rounded);
  return sum === (rounded + other) / 2 ? residual > 0 ? Math.max(rounded, other) : Math.min(rounded, other) : rounded;
}
function encoded(value) {
  const v = f(value);
  if (!(v > 0)) return 0;
  if (v >= 1) return 1;
  if (v <= LOW) return f(v * SLOPE);
  single[0] = v;
  const bits = word[0], slot = (Math.imul(bits, 0x9e3779b1) >>> 16);
  if (ENC_KEYS[slot] === bits) return ENC_VALS[slot];
  const x = f(Math.sqrt(v));
  let p = fma(P4, x, P3); p = fma(p, x, P2); p = fma(p, x, P1); p = fma(p, x, P0);
  let q = fma(Q4, x, Q3); q = fma(q, x, Q2); q = fma(q, x, Q1); q = fma(q, x, Q0);
  const res = f(p / q);
  ENC_KEYS[slot] = bits; ENC_VALS[slot] = res;
  return res;
}
const FAST_MARGIN = 2 ** -12, FAST_SHIFT = 13;
let fast = null, kernelTables = null;
function fastTable() {
  single[0] = LOW; const low = word[0]; single[0] = 1;
  const K = ((word[0] - low) >>> FAST_SHIFT) + 2, V = new Float64Array(K), R = new Float64Array(K), S = new Float64Array(K);
  for (let k = 0; k < K; k++) {
    word[0] = low + (k << FAST_SHIFT); const v = V[k] = single[0], x = Math.sqrt(v);
    R[k] = ((((P4 * x + P3) * x + P2) * x + P1) * x + P0) / ((((Q4 * x + Q3) * x + Q2) * x + Q1) * x + Q0);
  }
  for (let k = 0; k + 1 < K; k++) S[k] = (R[k + 1] - R[k]) / (V[k + 1] - V[k]);
  return fast = {low, V, R, S};
}
const byteOf = (s, d) => {
  const v = Math.max(0, Math.min(255, f(f(s * 255) + d))), floor = Math.floor(v);
  return v - floor === 0.5 ? floor + (floor & 1) : Math.round(v);
};
function encodedByte(v, bits, d, {low, V, R, S}) {
  if (!(v > LOW) || v >= 1) return byteOf(encoded(v), d);
  const k = (bits - low) >>> FAST_SHIFT, u = 255 * (R[k] + (v - V[k]) * S[k]) + d;
  const byte = Math.round(Math.max(0, Math.min(255, u - FAST_MARGIN)));
  return byte === Math.round(Math.max(0, Math.min(255, u + FAST_MARGIN))) ? byte : byteOf(encoded(v), d);
}
const bitsOf = p => p instanceof Float32Array ? new Uint32Array(p.buffer, p.byteOffset, p.length) : null;
export const nativeTables = () => ({dither: DITHER, fast: fast ?? fastTable(), margin: FAST_MARGIN, shift: FAST_SHIFT, low: LOW});
export const nativeByte = (v, d) => byteOf(encoded(f(v)), d);
const nearestEven = value => {
  const floor = Math.floor(value);
  return value - floor === 0.5 ? floor + (floor & 1) : Math.round(value);
};
function output(planes, width, height, {x = 0, y = 0, alpha = null} = {}, linear, dithered = true) {
  const pixels = width * height;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || !Number.isSafeInteger(pixels * 4))
    throw new RangeError('Photographic output dimensions must be positive safe integers.');
  if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y)) throw new RangeError('Photographic output origin must use safe integers.');
  if (!Array.isArray(planes) || planes.length !== 3 || planes.some(p => !(p instanceof Float32Array || p instanceof Float64Array) || p.length < pixels))
    throw new TypeError('Photographic output needs three complete floating-point planes.');
  if (alpha !== null && (!(alpha instanceof Uint8Array || alpha instanceof Uint8ClampedArray) || alpha.length < pixels))
    throw new TypeError('Photographic output alpha needs one byte per pixel.');
  const rgba = new Uint8Array(pixels * 4), ox = (x % 32 + 32) % 32, oy = (y % 32 + 32) % 32;
  const p0 = planes[0], p1 = planes[1], p2 = planes[2];
  if (dithered && linear) {
    const table = fast ?? fastTable(), b0 = bitsOf(p0), b1 = bitsOf(p1), b2 = bitsOf(p2);
    if (kernelHooks.nativeRGBA?.(planes, width, height, ox, oy, kernelTables ??= {coefficients: Float64Array.of(P0, P1, P2, P3, P4, Q0, Q1, Q2, Q3, Q4, LOW, SLOPE),
      dither: DITHER, V: table.V, R: table.R, S: table.S, low: table.low}, rgba)) {
      if (alpha) for (let i = 0; i < pixels; i++) rgba[i * 4 + 3] = alpha[i];
      return rgba;
    }
    for (let row = 0, at = 0; row < height; row++) {
      const dr0 = ((oy + row) & 31) * 32, dr1 = ((oy + row + 13) & 31) * 32, dr2 = ((oy + row + 26) & 31) * 32;
      for (let col = 0; col < width; col++, at++) {
        const i4 = at * 4, v0 = f(p0[at]), v1 = f(p1[at]), v2 = f(p2[at]);
        rgba[i4] = encodedByte(v0, b0 ? b0[at] : (single[0] = v0, word[0]), DITHER[dr0 + ((ox + col) & 31)], table);
        rgba[i4 + 1] = encodedByte(v1, b1 ? b1[at] : (single[0] = v1, word[0]), DITHER[dr1 + ((ox + col + 23) & 31)], table);
        rgba[i4 + 2] = encodedByte(v2, b2 ? b2[at] : (single[0] = v2, word[0]), DITHER[dr2 + ((ox + col + 14) & 31)], table);
        rgba[i4 + 3] = alpha ? alpha[at] : 255;
      }
    }
    return rgba;
  }
  for (let row = 0, at = 0; row < height; row++) for (let col = 0; col < width; col++, at++) {
    for (let c = 0; c < 3; c++) {
      const sample = linear ? encoded(planes[c][at]) : planes[c][at];
      const value = dithered ? f(f(f(sample) * 255) +
        DITHER[((oy + row + c * 13) & 31) * 32 + ((ox + col + c * 23) & 31)]) : sample * 255;
      const bounded = Math.max(0, Math.min(255, value));
      rgba[at * 4 + c] = dithered ? nearestEven(bounded) : Math.round(bounded);
    }
    rgba[at * 4 + 3] = alpha?.[at] ?? 255;
  }
  return rgba;
}

export const nativeRGBA = (linear, width, height, options) => output(linear, width, height, options, true);

export const nativeGammaRGBA = (gamma, width, height, options) => output(gamma, width, height, options, false);

export const gammaRGBA = (gamma, width, height, options) => output(gamma, width, height, options, false, false);
