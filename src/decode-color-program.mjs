// SPDX-License-Identifier: MIT
import {decodeKernels} from './decode-kernels.mjs';

export const CURVE = Object.freeze({identity: 0, iccGamma: 1, sampled: 2, sampledInverse: 3, para: 4, paraInverse: 5, segmented: 6, srgb: 7, srgbInverse: 8,
  bt709: 9, bt709Inverse: 10, gamma: 11, pq: 12, pqInverse: 13, hlg: 14, hlgInverse: 15, linear: 16});
export const OP = Object.freeze({curve: 1, matrix: 2, vector3: 3, clut: 4, decodePCS: 5, encodePCS: 6, scale: 7, divide: 8, grayD50: 9, copy: 10,
  hlgOotf: 11, grayAll: 12, grayFromY: 13, xybInverse: 14, xybForward: 15, xybUnscale: 16, ink: 17, none: 18, xybNative: 19, ycbcr: 20});
const CURVE_BYTES = 80, OP_BYTES = 32, SEGMENT_BYTES = 64, V = 3531264, SMALL = 3531776, SMALL_END = 3539968;
const align8 = n => Math.ceil(n / 8) * 8;
const f64Bytes = values => values ? align8(values.length * 8) : 0;

function curveBytes(c) {
  return CURVE_BYTES + f64Bytes(c.table) + f64Bytes(c.breaks) + (c.segments ?? []).reduce((n, s) => n + SEGMENT_BYTES + f64Bytes(s.table), 0);
}
export function programBytes(ops) {
  return (ops.length + 1) * OP_BYTES + ops.reduce((n, o) => n + f64Bytes(o.data) + (o.grid ? align8(o.grid.length * 4) : 0) + (o.curve ? curveBytes(o.curve) : 0), 0);
}
function writer(kernels, at) {
  const buffer = kernels.buffer, i32 = new Int32Array(buffer), f64 = new Float64Array(buffer);
  const w = {at, take: n => { const p = w.at; w.at += align8(n); return p; },
    doubles: values => { const p = w.take(values.length * 8); f64.set(values, p / 8); return p; }, i32, f64};
  return w;
}
function writeCurve(w, c) {
  const d = w.take(CURVE_BYTES), {i32, f64} = w;
  i32.fill(0, d / 4, d / 4 + 4); f64.fill(0, d / 8 + 2, d / 8 + 10);
  i32[d / 4] = c.kind;
  (c.p ?? []).forEach((v, k) => { f64[d / 8 + 2 + k] = v; });
  if (c.table) { i32[d / 4 + 1] = c.table.length; i32[d / 4 + 2] = w.doubles(c.table); }
  if (c.segments) {
    i32[d / 4 + 1] = c.breaks.length; i32[d / 4 + 2] = c.breaks.length ? w.doubles(c.breaks) : 0;
    const records = w.take(c.segments.length * SEGMENT_BYTES); i32[d / 4 + 3] = records;
    c.segments.forEach((s, k) => {
      const g = records + k * SEGMENT_BYTES;
      i32.fill(0, g / 4, g / 4 + 4); f64.fill(0, g / 8 + 2, g / 8 + 8);
      i32[g / 4] = s.kind; s.p.forEach((v, j) => { f64[g / 8 + 2 + j] = v; });
      if (s.table) { i32[g / 4 + 1] = s.table.length - 1; i32[g / 4 + 2] = w.doubles(s.table); }
    });
  }
  return d;
}
function writeOps(w, ops) {
  const start = w.take((ops.length + 1) * OP_BYTES), {i32} = w;
  i32.fill(0, start / 4, start / 4 + (ops.length + 1) * 8);
  ops.forEach((o, k) => {
    const r = start / 4 + k * 8;
    i32[r] = o.op; i32[r + 1] = o.a ?? 0; i32[r + 2] = o.b ?? 0; i32[r + 3] = o.c ?? 0; i32[r + 4] = o.d ?? 0;
    if (o.curve) i32[r + 5] = writeCurve(w, o.curve);
    else if (o.grid) { const g = w.take(o.grid.length * 4); i32.set(o.grid, g / 4); i32[r + 5] = g; i32[r + 6] = w.doubles(o.data); }
    else if (o.data) i32[r + 5] = w.doubles(o.data);
  });
  return start;
}

export function runVector(ops, v, out = []) {
  const kernels = decodeKernels(), bytes = programBytes(ops);
  const at = bytes <= SMALL_END - SMALL ? SMALL : kernels.reserve([bytes])[0];
  const program = writeOps(writer(kernels, at), ops), f64 = new Float64Array(kernels.buffer, V, 16);
  for (let c = 0; c < v.length && c < 16; c++) f64[c] = v[c];
  kernels.run(program);
  for (let c = 0; c < 16; c++) out[c] = f64[c];
  return out;
}

export function curveValue(curve, x) {
  const kernels = decodeKernels(), bytes = curveBytes(curve), at = bytes <= SMALL_END - SMALL ? SMALL : kernels.reserve([bytes])[0];
  return kernels.curve(writeCurve(writer(kernels, at), curve), x);
}

const CHUNK = 65536, TABLE_BYTES = 98304 * 8;
export function curveTable(curve) {
  const kernels = decodeKernels(), [desc, out] = kernels.reserve([curveBytes(curve), TABLE_BYTES]);
  const error = kernels.curveTable(writeCurve(writer(kernels, desc), curve), out);
  return {values: new Float32Array(kernels.buffer, out, 98304 * 2).slice(), error};
}

export function convertPixels(n, job) {
  const kernels = decodeKernels(), {inputs, black = null, alpha = null, outputs, blackOut = null, flags = 0, to, from = [], quantized = null} = job;
  const planes = [...inputs, black, alpha, ...outputs, blackOut].filter(Boolean), inPlace = planes.every(p => p.buffer === kernels.buffer);
  if (!inPlace && planes.some(p => p.buffer === kernels.buffer)) throw new Error('Color planes are partly in the kernels\' memory.');
  const tables = quantized ? [...new Set(quantized.tables)] : [];
  const bytes = programBytes(to) + programBytes(from) + (quantized ? 168 + quantized.curves.reduce((n, c) => n + curveBytes(c), 0) : 0);
  let w, chunk = n;
  const buffers = [], tableAt = new Map();
  if (inPlace && !quantized && bytes <= SMALL_END - SMALL) w = writer(kernels, SMALL);
  else {
    if (inPlace) throw new Error('A color program in place exceeds its region.');
    chunk = Math.min(n, CHUNK);
    const count = inputs.length + (black ? 1 : 0) + (alpha ? 1 : 0) + outputs.length + (blackOut ? 1 : 0);
    const at = kernels.reserve([bytes, ...tables.map(() => TABLE_BYTES), ...Array(count).fill(chunk * 4)]);
    w = writer(kernels, at[0]);
    tables.forEach((t, k) => { new Float32Array(kernels.buffer, at[1 + k], t.length).set(t); tableAt.set(t, at[1 + k]); });
    for (let k = 1 + tables.length; k < at.length; k++) buffers.push(new Float32Array(kernels.buffer, at[k], chunk));
  }
  const toAt = writeOps(w, to), fromAt = writeOps(w, from), args = kernels.i32, g = kernels.args / 4;
  let q = 0;
  if (quantized) {
    const curves = quantized.curves.map(c => writeCurve(w, c));
    q = w.take(168);
    args.set([...quantized.tables.map(t => tableAt.get(t)), ...curves], q / 4);
    w.f64.set([...quantized.errors, ...quantized.bounds, ...quantized.matrix, quantized.maximum], q / 8 + 5);
  }
  const staged = inPlace ? null : {inputs: inputs.map((_, c) => buffers[c])};
  if (staged) {
    let k = inputs.length;
    staged.black = black ? buffers[k++] : null; staged.alpha = alpha ? buffers[k++] : null;
    staged.outputs = outputs.map(() => buffers[k++]); staged.blackOut = blackOut ? buffers[k++] : null;
  }
  const at = p => p ? p.byteOffset : 0;
  for (let start = 0; start < n; start += chunk) {
    const count = Math.min(chunk, n - start), s = staged ?? {inputs, black, alpha, outputs, blackOut};
    if (staged) {
      inputs.forEach((p, c) => staged.inputs[c].set(p.subarray(start, start + count)));
      if (black) staged.black.set(black.subarray(start, start + count));
      if (alpha) staged.alpha.set(alpha.subarray(start, start + count));
      for (const p of [...staged.outputs, staged.blackOut]) p?.fill(0, 0, count);
    }
    args.set([count, inputs.length + (black ? 1 : 0), outputs.length, flags, at(s.alpha), at(s.black), at(s.inputs[0]), at(s.inputs[1] ?? s.inputs[0]), at(s.inputs[2] ?? s.inputs[0]),
      at(s.outputs[0]), at(s.outputs[1]), at(s.outputs[2]), at(s.blackOut), toAt, fromAt], g);
    if (quantized) kernels.quantized(kernels.args, q); else kernels.convert(kernels.args);
    if (staged) {
      outputs.forEach((p, c) => p.set(staged.outputs[c].subarray(0, count), start));
      if (blackOut) blackOut.set(staged.blackOut.subarray(0, count), start);
    }
  }
}

export function throughKernels(n, inputs, outputs, fn) {
  const kernels = decodeKernels(), chunk = Math.min(n, CHUNK), at = kernels.reserve(inputs.map(() => chunk * 4));
  const staged = at.map(a => new Float32Array(kernels.buffer, a, chunk));
  for (let start = 0; start < n; start += chunk) {
    const count = Math.min(chunk, n - start);
    inputs.forEach((p, c) => staged[c].set(p.subarray(start, start + count)));
    fn(count, staged.map(p => p.subarray(0, count)));
    outputs.forEach((p, c) => p.set(staged[c].subarray(0, count), start));
  }
}
