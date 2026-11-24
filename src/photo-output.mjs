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

import {kernelCall, room} from './kernel-call.mjs';
import {fault} from './fault.mjs';

const f = Math.fround;
const DITHER = /* @__PURE__ */ Float32Array.from(/* @__PURE__ */ atob("PNS2d2Sr7wN9L8AkeT6HmjZ/vPBCry1jIsNOM+lnnAGpI1DdNiZLlNwU+0df8hNT59coigfGVOW1DniuFITA/32V6gaK+sNwXKaIzAm6pmges1qlaP0YkHA68F/KRCtYEr1DYbCdDj/stjZulN4vzneSEeI3gaBGzd+jBZfcc+Q1bfLHHVZ7zioXVOkhfk7rO/lHynW52QtaJ4pN9R+3jtCkKIHZMuSjj2XYm0KyBIsZvpsAUSIx9ny/GmywPGMK+VMVk2e4SwH0gr4R/WHEpFdtLN3tsZJjqOI1yH/VnUmFruJBDP52xSBFrDDLcyTv2oCrXolu0hZAmFL7ECzowwRgc8qaqFk43V5wClGEmDRED/YbOEkIu+pyA6qNWXcgOdgv7hwrh7OV7dGi9uEW0mm3zZTFo/1YhiXaZe5Cupf0tIxIv23nCBl8KY47uUqniwdVdCXgfDDNtTrEohjOaRGhWgZ+2k/JQrtWHWoCeln8LeY/sBOaahuQTAuBKeBOeSPU+Kw2m/tnp/DbrcbqIcCeg9ViUOxDqvfjc1f/rYnpvD5qFWAjjRMzhUiZMGLZO20Y848BvtoNX58xxpMCNMlSmIXP7LV208IJcfgUgpIMqkq4MspxiCt90h+wY0RvGd8JLaVFAOFNXeUkzEG2T/XRXXsioT3xVLxG9BLW7p5dsnb0v1iVKoGgso9Xpd51KsIG4P5nFbGWBmyKOni5J/pHkRw3b8jxPRr/OGsD7hyciTmok0bV4yXIp+iZVQiIM9Fk54PXDqxpvQzXfy69XkVu6FQPg1p1NPhcGizM46kNxKASt0wjjN54SJfrr4vN+xfHLtCtwAmOTYDdvmZAfVJxJj/8p2L1VSzRYSBPPQ2ierNk7yA/6py3PQR0ox/xsYncW5V6MQOetBDBpHTk2SdNjwKZfmvXFGXPrP5LlNYBMOu7DNPB5UOE7Tf5BYVouPM+3jT6T6Uu8SKLMhPBYfedSWwdPJBwyxdokVbHL5tbEMJyXbwLh8V4UeBc6YM7dxfIrYbyWCamTHzfG7JG1B6Az58aqybnQ5cPu2+gJM9mkeMpUNu2Ev7VuCmhcuaM/K4tR+KN025f96k+zAuuVboIOH6hBWaaNWAAQfNiCjlTbATveTlOswAf1n8qS/zYRO1g0PlFxnmI6MKWgssVpL/YllnHEf2ZxDeOZfCWhx2omCGvchbfKEypHlYytOx7JUGGtSFphCjrduFTBcU1cdyAwVcxkLn1Ds51+NtJkVvhEPYz5qa9XEiqFrqi5F4PLkr3CuZAW5xqOo0HZhkrb6vJnXRQDds8B9BrJ0B6sfKMaxify4Ie07RS5Z+v1MP/AkpkG9KTe/OehvqS1hxRyQ=="), c => Math.round((2 * c.charCodeAt(0) - 255) * 13125 / 68) / 1e5);
const LOW = /* @__PURE__ */ f(0.0031308), SLOPE = /* @__PURE__ */ f(12.92);
const P0 = /* @__PURE__ */ f(-5.135152395e-4), P1 = /* @__PURE__ */ f(5.287254571e-3), P2 = /* @__PURE__ */ f(3.903842876e-1), P3 = /* @__PURE__ */ f(1.474205315), P4 = /* @__PURE__ */ f(7.352629620e-1);
const Q0 = /* @__PURE__ */ f(1.004519624e-2), Q1 = /* @__PURE__ */ f(3.036675394e-1), Q2 = /* @__PURE__ */ f(1.340816930), Q3 = /* @__PURE__ */ f(9.258482155e-1), Q4 = /* @__PURE__ */ f(2.424867759e-2);
const FAST_MARGIN = 2 ** -12, FAST_SHIFT = 13;
let fast = null, tableBytes = null;

function fastTable() {
  const word = new Uint32Array(1), single = new Float32Array(word.buffer);
  single[0] = LOW; const low = word[0]; single[0] = 1;
  const K = ((word[0] - low) >>> FAST_SHIFT) + 2, V = new Float64Array(K), R = new Float64Array(K), S = new Float64Array(K);
  for (let k = 0; k < K; k++) {
    word[0] = low + (k << FAST_SHIFT); const v = V[k] = single[0], x = Math.sqrt(v);
    R[k] = ((((P4 * x + P3) * x + P2) * x + P1) * x + P0) / ((((Q4 * x + Q3) * x + Q2) * x + Q1) * x + Q0);
  }
  for (let k = 0; k + 1 < K; k++) S[k] = (R[k + 1] - R[k]) / (V[k + 1] - V[k]);
  return fast = {low, V, R, S};
}

function tablePack() {
  if (tableBytes) return tableBytes;
  const {low, V, R, S} = fast ?? fastTable(), count = V.length;
  const buf = new ArrayBuffer(96 + 4096 + 24 * count);
  new Float64Array(buf, 0, 12).set([P0, P1, P2, P3, P4, Q0, Q1, Q2, Q3, Q4, LOW, SLOPE]);
  new Float32Array(buf, 96, 1024).set(DITHER);
  const knots = new Float64Array(buf, 4192, 3 * count);
  knots.set(V, 0); knots.set(R, count); knots.set(S, 2 * count);
  return tableBytes = {bytes: new Uint8Array(buf), low, count};
}

export const nativeTables = () => ({dither: DITHER, fast: fast ?? fastTable(), margin: FAST_MARGIN, shift: FAST_SHIFT, low: LOW});
export const nativeByte = (v, d) => {
  const {bytes, low, count} = tablePack();
  return kernelCall(k => (tAt, inAt, outAt) => {
    const buf = k.memory.buffer;
    new Float32Array(buf, inAt, 1)[0] = v;
    new Float64Array(buf, inAt + 8, 1)[0] = d;
    k.nativeRows(inAt, 0, 0, 0, 0, tAt, low, count, outAt, 0, 0);
    return new Uint8Array(buf)[outAt];
  }, [bytes, room(16), room(8)])[0];
};

function outputSetup(planes, width, height, {x = 0, y = 0, alpha = null} = {}, into = null) {
  const pixels = width * height;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || !Number.isSafeInteger(pixels * 4))
    throw fault('JXL_INTERNAL', 'photo-output:dimensions');
  if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y)) throw fault('JXL_INTERNAL', 'photo-output:origin');
  if (!Array.isArray(planes) || planes.length !== 3 || planes.some(p => !(p instanceof Float32Array || p instanceof Float64Array) || p.length < pixels))
    throw fault('JXL_INTERNAL', 'photo-output:planes');
  if (alpha !== null && (!(alpha instanceof Uint8Array || alpha instanceof Uint8ClampedArray) || alpha.length < pixels))
    throw fault('JXL_INTERNAL', 'photo-output:alpha');
  if (into !== null && (!(into instanceof Uint8Array) || into.length !== pixels * 4 ||
      planes.some(p => p.buffer === into.buffer) || alpha?.buffer === into.buffer))
    throw fault('JXL_INTERNAL', 'photo-output:into');
  return {alpha, rgba: into ?? new Uint8Array(pixels * 4), ox: (x % 32 + 32) % 32, oy: (y % 32 + 32) % 32};
}

function runNativeRows(planes, width, height, options, into, gamma) {
  const {alpha, rgba, ox, oy} = outputSetup(planes, width, height, options, into);
  const {bytes, low, count} = tablePack(), stepRows = Math.min(height, Math.max(1, Math.floor(262144 / width))), maxM = stepRows * width;
  kernelCall(k => (tAt, inAt, aAt, outAt) => {
    const buf = k.memory.buffer, f32 = new Float32Array(buf), u8 = new Uint8Array(buf);
    for (let y = 0; y < height; y += stepRows) {
      const h = Math.min(stepRows, height - y), m = h * width;
      for (let c = 0; c < 3; c++) f32.set(planes[c].subarray(y * width, y * width + m), (inAt >> 2) + c * m);
      if (alpha) u8.set(alpha.subarray(y * width, y * width + m), aAt);
      k.nativeRows(inAt, width, h, ox, oy + y, tAt, low, count, outAt, alpha ? aAt : 0, gamma);
      rgba.set(u8.subarray(outAt, outAt + m * 4), y * width * 4);
    }
  }, [bytes, room(maxM * 12), room(alpha ? maxM : 0), room(maxM * 4)]);
  return rgba;
}

export const nativeRGBA = (planes, width, height, options, into = null) => runNativeRows(planes, width, height, options, into, 0);
export const nativeGammaRGBA = (planes, width, height, options) => runNativeRows(planes, width, height, options, null, 1);
