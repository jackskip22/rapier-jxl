// SPDX-License-Identifier: MIT
import {SCORE} from './ssimulacra2-kernel-bytes.mjs';
import {wasmBytes} from './wasm-text.mjs';
import {compileWasm, wasmModule} from './wasm-modules.mjs';
import {S2_WEIGHTS, finalCurve} from './ssimulacra2-weights.mjs';
import {exactPow, exactCbrt} from './exact-math.mjs';
import {dct8Basis} from './photo-dct.mjs';

export const S2_TAPS = Float64Array.of(0.009414367809653594, 0.036011114658364235, 0.10933537277746022, 0.2129285920104222,
  0.2646211054881986, 0.2129285920104224, 0.10933537277746044, 0.036011114658364284, 0.009414367809653428);
const BIAS = 0.0037930732552754493;
let tables = null;
const kernelTables = () => tables ??= Float32Array.from({length: 266}, (_, i) => {
  if (i < 256) { const v = i / 255; return v <= 0.04045 ? v / 12.92 : exactPow((v + 0.055) / 1.055, 2.4); }
  return i < 265 ? S2_TAPS[i - 256] : exactCbrt(BIAS);
});

export const prepareScorer = () => compileWasm('score', () => wasmBytes(SCORE));

let shared = null;
const instance = () => {
  if (shared) return shared;
  const k = new WebAssembly.Instance(wasmModule('score', () => wasmBytes(SCORE)), {}).exports;
  new Float32Array(k.memory.buffer, k.s2Tables(), 266).set(kernelTables());
  return shared = k;
};

export function scorer(reference, width, height) {
  const k = instance();
  const scales = k.s2Setup(width, height), bytes = width * height * 4, input = k.s2Input();
  new Uint8Array(k.memory.buffer, input, bytes).set(reference.subarray(0, bytes));
  k.s2Reference();
  const sizes = [];
  for (let s = 0, w = width, h = height; s < scales; s++) { if (s) { w = (w + 1) >> 1; h = (h + 1) >> 1; } sizes.push(w * h); }
  return rgba => {
    new Uint8Array(k.memory.buffer, input, bytes).set(rgba.subarray(0, bytes));
    const at = k.s2Score(), sums = new Float64Array(k.memory.buffer, at, scales * 18);
    let sum = 0, i = 0;
    for (let c = 0; c < 3; c++) for (let s = 0; s < scales; s++) {
      const o = (s * 3 + c) * 6, n = sizes[s];
      const norms = [sums[o] / n, Math.sqrt(Math.sqrt(sums[o + 1] / n)), sums[o + 2] / n, Math.sqrt(Math.sqrt(sums[o + 3] / n)), sums[o + 4] / n, Math.sqrt(Math.sqrt(sums[o + 5] / n))];
      for (let q = 0; q < 2; q++) { sum += S2_WEIGHTS[i++] * Math.abs(norms[q]); sum += S2_WEIGHTS[i++] * Math.abs(norms[2 + q]); sum += S2_WEIGHTS[i++] * Math.abs(norms[4 + q]); }
    }
    return finalCurve(sum);
  };
}

const DEQUANT_BIAS = Float32Array.of(1 - .05465007330715401, 1 - .07005449891748593, 1 - .049935103337343655);

export function reconstruct(jpeg) {
  const k = instance(), {width: w, height: h, components, quantScale: qs, cfl, quantFieldBase: F = 1, quantFields: fields} = jpeg;
  const stride = components[0].stride, rows = components[0].rows, blocks = stride * rows, values = new Map(), which = new Uint8Array(blocks);
  for (let i = 0; i < blocks; i++) {
    const v = fields ? fields[i] : F;
    if (!values.has(v)) values.set(v, values.size);
    which[i] = values.get(v);
  }
  const steps = new Float32Array(192 * values.size);
  for (const [v, n] of values) for (let c = 0; c < 3; c++) for (let q = 0; q < 64; q++) steps[n * 192 + c * 64 + q] = components[c].quant[q] * (q ? F / v : 1) / qs;
  const tiles = cfl.x.length, factors = new Float32Array(2 * tiles);
  for (let t = 0; t < tiles; t++) { factors[2 * t] = 1 + cfl.x[t] / 84; factors[2 * t + 1] = 1 + cfl.b[t] / 84; }
  const sizes = [blocks * 64 * 3 * 2, blocks, steps.length * 4, factors.length * 4, 256, 12, w * h * 4];
  const at = []; let total = 0;
  for (const n of sizes) { at.push(total); total += n + 15 & ~15; }
  const scratch = k.s2Scratch(total), mem = k.memory.buffer, coeffs = new Int16Array(mem, scratch + at[0], blocks * 64 * 3);
  for (let c = 0; c < 3; c++) coeffs.set(components[c].coeffs.subarray(0, blocks * 64), c * blocks * 64);
  new Uint8Array(mem, scratch + at[1], blocks).set(which);
  new Float32Array(mem, scratch + at[2], steps.length).set(steps);
  new Float32Array(mem, scratch + at[3], factors.length).set(factors);
  new Float32Array(mem, scratch + at[4], 64).set(dct8Basis);
  new Float32Array(mem, scratch + at[5], 3).set(DEQUANT_BIAS);
  k.s2Reconstruct(w, h, stride, rows, scratch + at[0], scratch + at[1], scratch + at[2], scratch + at[3], cfl.width, scratch + at[4], scratch + at[5], scratch + at[6]);
  return new Uint8Array(k.memory.buffer, scratch + at[6], w * h * 4);
}
