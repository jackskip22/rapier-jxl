// SPDX-License-Identifier: MIT
import {wasmRequired} from './capture-wasm-error.mjs';

const KERNEL_BLOCK = 65536 * 8, KERNEL_OUT = 3 * KERNEL_BLOCK, KERNEL_TMP = 4 * KERNEL_BLOCK, KERNEL_ROWS = 5 * KERNEL_BLOCK;
const KERNEL_BASES = KERNEL_ROWS + 4096, KERNEL_TABLES = KERNEL_BASES + 786432, KERNEL_CONSTANTS = KERNEL_TABLES + 81944;
const KERNEL_SRGB8 = KERNEL_CONSTANTS + 64, KERNEL_ARENA = KERNEL_BASES + 1048576;

export function createKernelEngine(module) {
  let exports;
  try { ({exports} = new WebAssembly.Instance(module())); }
  catch (error) { throw error?.code === 'JXL_WASM' ? error : wasmRequired(); }
  const memory = exports.memory, bases = new Map();
  let next = KERNEL_BASES;
  const engine = {...exports,
    arena: KERNEL_ARENA, args: KERNEL_ARENA - 256,
    views() {
      engine.buffer = memory.buffer; engine.f64 = new Float64Array(memory.buffer); engine.i32 = new Int32Array(memory.buffer);
      engine.coefficients = [0, 1, 2].map(c => new Float64Array(memory.buffer, c * KERNEL_BLOCK, 65536));
      engine.output = new Float64Array(memory.buffer, KERNEL_OUT, 65536);
    },
    reserve(sizes, from = KERNEL_ARENA) {
      let at = from;
      const offsets = sizes.map(size => { const offset = at; at += Math.ceil(size / 16) * 16; return offset; });
      const memoryError = message => Object.assign(new RangeError(message), {code: 'JXL_MEMORY'});
      if (!(at <= 0x80000000)) throw memoryError('JPEG XL kernel memory request exceeds its limit.');
      if (at > memory.buffer.byteLength) {
        try { memory.grow(Math.ceil((at - memory.buffer.byteLength) / 65536)); } catch { throw memoryError('JPEG XL kernel memory could not be allocated.'); }
        engine.views();
      }
      return offsets;
    },
    basis(n, values) {
      let at = bases.get(n);
      if (at === undefined) { at = next; next += n * n * 8; engine.f64.set(values(), at / 8); bases.set(n, at); }
      return at;
    },
    idct: (coefficients, width, height, bx, by) => width === 8 && height === 8 ? exports.idct8(coefficients, bx, KERNEL_OUT, KERNEL_TMP)
      : exports.idct(coefficients, width, height, bx, by, KERNEL_OUT, KERNEL_TMP, KERNEL_ROWS),
    store: (width, plane, at, stride, xs, ys) => exports.store(KERNEL_OUT, width, plane.byteOffset + at * 4, stride * 4, xs, ys),
    xyb(n, x, y, b, {root, bias, m}, rgba8 = null) {
      new Float32Array(memory.buffer, KERNEL_CONSTANTS, 15).set([...root, ...bias, ...m]);
      exports.xyb(n, x.byteOffset, y.byteOffset, b.byteOffset, KERNEL_CONSTANTS, rgba8 ? engine.srgb8Table() : 0, rgba8 ? rgba8.byteOffset : 0);
    },
    srgbTables() { if (!engine.tablesBuilt) { exports.srgbTables(KERNEL_TABLES); engine.tablesBuilt = true; } return KERNEL_TABLES; },
    srgb8Table() { if (!engine.srgb8Built) { if (exports.srgb8Build(KERNEL_SRGB8)) throw new Error("Invalid sRGB8 table."); engine.srgb8Built = true; } return KERNEL_SRGB8; },
    srgb: p => exports.srgb(p.length, p.byteOffset, engine.srgbTables()),
    srgb8: (n, r, g, b, out) => exports.srgb8(n, r.byteOffset, g.byteOffset, b.byteOffset, engine.srgb8Table(), out.byteOffset),
  };
  engine.views();
  return engine;
}

