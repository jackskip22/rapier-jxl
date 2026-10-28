// SPDX-License-Identifier: MIT
import {DECODE_KERNELS} from './decode-kernels-bytes.mjs';
import {srgbTables, srgbExact, srgb8Table} from './decode-color-math.mjs';

const KERNEL_BLOCK = 65536 * 8, KERNEL_OUT = 3 * KERNEL_BLOCK, KERNEL_TMP = 4 * KERNEL_BLOCK, KERNEL_ROWS = 5 * KERNEL_BLOCK;
const KERNEL_BASES = KERNEL_ROWS + 4096, KERNEL_TABLES = KERNEL_BASES + 786432, KERNEL_CONSTANTS = KERNEL_TABLES + 81944;
const KERNEL_SRGB8 = KERNEL_CONSTANTS + 64, KERNEL_ARENA = KERNEL_BASES + 1048576;
let kernelEngine;

export function decodeKernels() {
  if (kernelEngine !== undefined) return kernelEngine;
  kernelEngine = null;
  try {
    const bytes = Uint8Array.from(atob(DECODE_KERNELS), c => c.charCodeAt(0)), {exports} = new WebAssembly.Instance(new WebAssembly.Module(bytes));
    const memory = exports.memory, bases = new Map();
    let next = KERNEL_BASES;
    const engine = {
      views() {
        engine.buffer = memory.buffer; engine.tables = false; engine.f64 = new Float64Array(memory.buffer); engine.i32 = new Int32Array(memory.buffer);
        engine.coefficients = [0, 1, 2].map(c => new Float64Array(memory.buffer, c * KERNEL_BLOCK, 65536));
        engine.output = new Float64Array(memory.buffer, KERNEL_OUT, 65536);
      },
      reserve(sizes) {
        let at = KERNEL_ARENA;
        const offsets = sizes.map(size => { const offset = at; at += Math.ceil(size / 16) * 16; return offset; });
        if (at > memory.buffer.byteLength) memory.grow(Math.ceil((at - memory.buffer.byteLength) / 65536));
        engine.views();
        return offsets;
      },
      basis(n, values) {
        let at = bases.get(n);
        if (at === undefined) { at = next; next += n * n * 8; engine.f64.set(values(), at / 8); bases.set(n, at); }
        return at;
      },
      idct: (coefficients, width, height, bx, by) => width === 8 && height === 8 ? exports.idct8(coefficients, bx, KERNEL_OUT, KERNEL_TMP)
        : exports.idct(coefficients, width, height, bx, by, KERNEL_OUT, KERNEL_TMP, KERNEL_ROWS),
      gab: exports.gab, epf1: exports.epf1, blockCoefficients: exports.coefficients, dequant: exports.dequant, cfl64: exports.cfl64, modular: exports.modular, block8: exports.block8,
      store: (width, plane, at, stride, xs, ys) => exports.store(KERNEL_OUT, width, plane.byteOffset + at * 4, stride * 4, xs, ys),
      xyb(n, x, y, b, {root, bias, m}, rgba8 = null) {
        new Float32Array(memory.buffer, KERNEL_CONSTANTS, 15).set([...root, ...bias, ...m]);
        if (rgba8 && !engine.srgb8) {
          const {thresholds, steps} = srgb8Table();
          new Uint8Array(memory.buffer, KERNEL_SRGB8, steps.length).set(steps); new Uint32Array(memory.buffer, KERNEL_SRGB8 + 32768, 257).set(thresholds);
          engine.srgb8 = true;
        }
        exports.xyb(n, x.byteOffset, y.byteOffset, b.byteOffset, KERNEL_CONSTANTS, rgba8 ? KERNEL_SRGB8 : 0, rgba8 ? rgba8.byteOffset : 0);
      },
      srgb(p, list) {
        if (!engine.tables) { let at = KERNEL_TABLES; for (const table of srgbTables()) { engine.f64.set(table, at / 8); at += table.byteLength; } engine.tables = true; }
        const count = exports.srgb(p.length, p.byteOffset, KERNEL_TABLES, list);
        if (count) srgbExact(p, new Int32Array(memory.buffer, list, count), count);
      },
      rgba8: (n, r, g, b, out) => exports.rgba8(n, r.byteOffset, g.byteOffset, b.byteOffset, out.byteOffset),
    };
    engine.views();
    kernelEngine = engine;
  } catch {}
  return kernelEngine;
}
