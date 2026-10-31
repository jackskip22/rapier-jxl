import {wasmModule} from './wasm-modules.mjs';
// SPDX-License-Identifier: MIT
import {DECODE_KERNELS} from './decode-kernels-bytes.mjs';
import {wasmRequired} from './capture-wasm-error.mjs';

const KERNEL_BLOCK = 65536 * 8, KERNEL_OUT = 3 * KERNEL_BLOCK, KERNEL_TMP = 4 * KERNEL_BLOCK, KERNEL_ROWS = 5 * KERNEL_BLOCK;
const KERNEL_BASES = KERNEL_ROWS + 4096, KERNEL_TABLES = KERNEL_BASES + 786432, KERNEL_CONSTANTS = KERNEL_TABLES + 81944;
const KERNEL_SRGB8 = KERNEL_CONSTANTS + 64, KERNEL_ARENA = KERNEL_BASES + 1048576;
let kernelEngine, streamEngine;

export function decodeKernels() { return kernelEngine ??= createEngine(); }
export function streamKernels() { decodeKernels(); return streamEngine ??= createEngine(); }
function createEngine() {
  let exports;
  try { ({exports} = new WebAssembly.Instance(wasmModule('decode', () => Uint8Array.from(DECODE_KERNELS, c => c.charCodeAt(0))))); }
  catch (error) { throw error?.code === 'JXL_WASM' ? error : wasmRequired(); }
  const memory = exports.memory, bases = new Map();
  let next = KERNEL_BASES;
  const engine = {
    arena: KERNEL_ARENA, args: KERNEL_ARENA - 256,
    views() {
      engine.buffer = memory.buffer; engine.f64 = new Float64Array(memory.buffer); engine.i32 = new Int32Array(memory.buffer);
      engine.coefficients = [0, 1, 2].map(c => new Float64Array(memory.buffer, c * KERNEL_BLOCK, 65536));
      engine.output = new Float64Array(memory.buffer, KERNEL_OUT, 65536);
    },
    reserve(sizes) {
      let at = KERNEL_ARENA;
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
    gabRows: exports.gabRows, epf: exports.epf, lfPrepare: exports.lfPrepare, values: exports.values, passGroup: exports.passGroup, small: exports.small, cfl: exports.cfl, llf: exports.llf, dequant: exports.dequant, cfl64: exports.cfl64, modular: exports.modular, block8: exports.block8, blend: exports.blend, upsample: exports.upsample, orient: exports.orient,
    samples: exports.samples, xybSamples: exports.xybSamples, jpegAcross: exports.jpegAcross, jpegDown: exports.jpegDown,
    rct: exports.rct, palette: exports.palette, squeezeAcross: exports.squeezeAcross, squeezeDown: exports.squeezeDown, lfScale: exports.lfScale,
    noiseRandom: exports.noiseRandom, noiseConvolve: exports.noiseConvolve, noiseApply: exports.noiseApply, splineDot: exports.splineDot,
    store: (width, plane, at, stride, xs, ys) => exports.store(KERNEL_OUT, width, plane.byteOffset + at * 4, stride * 4, xs, ys),
    xyb(n, x, y, b, {root, bias, m}, rgba8 = null) {
      new Float32Array(memory.buffer, KERNEL_CONSTANTS, 15).set([...root, ...bias, ...m]);
      exports.xyb(n, x.byteOffset, y.byteOffset, b.byteOffset, KERNEL_CONSTANTS, rgba8 ? engine.srgb8Table() : 0, rgba8 ? rgba8.byteOffset : 0);
    },
    srgbTables() { if (!engine.tablesBuilt) { exports.srgbTables(KERNEL_TABLES); engine.tablesBuilt = true; } return KERNEL_TABLES; },
    srgb8Table() { if (!engine.srgb8Built) { if (exports.srgb8Build(KERNEL_SRGB8)) throw new Error("Invalid sRGB8 table."); engine.srgb8Built = true; } return KERNEL_SRGB8; },
    srgb: p => exports.srgb(p.length, p.byteOffset, engine.srgbTables()),
    srgb8: (n, r, g, b, out) => exports.srgb8(n, r.byteOffset, g.byteOffset, b.byteOffset, engine.srgb8Table(), out.byteOffset),
    rgba: exports.rgba, convert: exports.convert, run: exports.run, curve: exports.curve, quantized: exports.quantized, curveTable: exports.curveTable,
  };
  engine.views();
  return engine;
}

