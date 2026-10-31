import {wasmModule, hasWasmModule, suppliedWasm, compileWasm} from './wasm-modules.mjs';
// SPDX-License-Identifier: MIT
import {fault} from './fault.mjs';
import {wasmRequired} from './capture-wasm-error.mjs';
import {CAPTURE} from './capture-kernels-bytes.mjs';
import {weightedTables} from './weighted-policy.mjs';

export const WEIGHTED_BANDS = [-200, -100, -50, -25, -12, -6, -3, -1, 0, 2, 4, 7, 13, 26, 51, 101, 201];
export const WEIGHTED_CONTEXT = Uint8Array.from({length: 511}, (_, i) => WEIGHTED_BANDS.filter(cut => cut < i - 255).length);

const P = 65536, DIV = 16, WEIGHTS = 272, BANDS = 32768, HEADS = 262144, SCRATCH = 832;
const SIMD_PROBE = 'AGFzbQEAAAABBQFgAAF/AwIBAAcJAQVwcm9iZQAACgsBCQBBAP0R/RsACw==';
const KERNEL_FAIL = 'The JPEG XL capture WebAssembly kernel could not run. Check available memory and runtime limits.';
let compiled, engine, simd;

const SIMD_OK = () => hasWasmModule('simd') || !suppliedWasm() && WebAssembly.validate(Uint8Array.from(atob(SIMD_PROBE), c => c.charCodeAt(0)));

export async function compileCaptureKernels() {
  try {
    if (typeof WebAssembly !== 'object' || new Uint8Array(new Uint32Array([1]).buffer)[0] !== 1) return false;
    simd ??= SIMD_OK();
    if (!simd || !await compileWasm('capture', () => Uint8Array.from(CAPTURE, c => c.charCodeAt(0)))) return false;
    return prepareCaptureKernels();
  } catch { return false; }
}

export function prepareCaptureKernels() {
  try {
    if (typeof WebAssembly !== 'object' || new Uint8Array(new Uint32Array([1]).buffer)[0] !== 1) return false;
    simd ??= SIMD_OK();
    if (!simd) return false;
    compiled ||= wasmModule('capture', () => Uint8Array.from(CAPTURE, c => c.charCodeAt(0)));
    return true;
  } catch { return false; }
}

export function captureWeighted(w, targets, plane, width, height, offset, contextOf, residuals, properties, keep = false) {
  if (w || !(plane instanceof Int16Array) || !Number.isInteger(width) || !Number.isInteger(height) ||
      width < 1 || height < 1 || width > 16384 || width * height > 1048576 || plane.length < width * height ||
      !Number.isInteger(offset) || Math.abs(offset) > 32768 || !keep && (!(residuals instanceof Uint32Array) ||
      residuals.length < width * height || properties && (!(properties instanceof Int32Array) || properties.length < width * height))) return false;
  if (!prepareCaptureKernels()) return false;
  try {
    ready();
    const n = width * height, residual = P + n * 4, property = P + n * 8, state = P + n * 12;
    reserve(state + (width + 2) * 40);
    const i32 = new Int32Array(engine.memory.buffer);
    i32.set(plane.subarray(0, n), P >> 2);
    i32.fill(0, state >> 2, (state >> 2) + (width + 2) * 10);
    engine.weighted(P, width, height, offset, residual, property, 0, 0, 0, DIV, WEIGHTS, state);
    if (keep) return true;
    residuals.set(i32.subarray(residual >> 2, (residual >> 2) + n));
    if (properties) properties.set(i32.subarray(property >> 2, (property >> 2) + n));
    return true;
  } catch { return false; }
}

function ready() {
  if (engine) return;
  const memory = new WebAssembly.Memory({initial: 1, maximum: 320}), {weighted, copies, runs, scan, tally, part, literals, pieces} = new WebAssembly.Instance(compiled, {env: {memory}}).exports;
  weightedTables(new Int32Array(memory.buffer), DIV, WEIGHTS);
  new Uint8Array(memory.buffer).set(WEIGHTED_CONTEXT, BANDS);
  engine = {memory, weighted, copies, runs, scan, tally, part, literals, pieces};
}
function reserve(bytes) {
  const have = engine.memory.buffer.byteLength;
  if (bytes > have) engine.memory.grow(Math.ceil((bytes - have) / 65536));
}

export function captureCopies(values, contexts, width, depth, minimum, scale, spatial) {
  try {
    if (!prepareCaptureKernels()) throw wasmRequired();
    if (!(values instanceof Int32Array) || values.length < 1 || values.length > 1048576 || !(contexts instanceof Uint8Array) ||
        contexts.length < values.length || !Number.isInteger(width) || width < 1 || width > 16384 || !(spatial instanceof Uint8Array) ||
        spatial.length > width * 8 + 64 || !Number.isInteger(depth) || depth < 0 || depth > 64 || !Number.isInteger(minimum) || minimum < 1 ||
        !Number.isInteger(scale) || scale < 1 || scale > 2) throw fault('JXL_INTERNAL', 'The capture copy search was called outside its bounds.');
    ready();
    const n = values.length, scratch = P + spatial.length + 3 & ~3, heads = scratch + SCRATCH, at = heads + (depth ? HEADS : 0);
    const chain = at + n * 4, value = chain + (depth ? n * 4 : 0), distance = value + n * 4, context = distance + n * 4;
    reserve(context + n);
    const buffer = engine.memory.buffer, bytes = new Uint8Array(buffer);
    bytes.set(spatial, P);
    new Int32Array(buffer, at, n).set(values);
    bytes.set(contexts.subarray(0, n), context);
    const count = engine.copies(at, context, n, width, depth, minimum, scale, P, spatial.length, heads, chain, scratch, value, distance, context);
    return {count, value: new Int32Array(buffer.slice(value, value + count * 4)), distance: new Int32Array(buffer.slice(distance, distance + count * 4)),
      context: new Uint8Array(buffer.slice(context, context + count))};
  } catch (error) {
    if (error?.code) throw error;
    throw fault('JXL_WASM', KERNEL_FAIL);
  }
}

export function captureWeightedPieces(plane, width, height, minimum) {
  if (!captureWeighted(null, null, plane, width, height, 0, undefined, null, null, true))
    throw fault('JXL_WASM', KERNEL_FAIL);
  try {
    const n = width * height, residual = P + n * 4, property = P + n * 8, context = P + n * 12 + (width + 2) * 40;
    reserve(context + n);
    const count = engine.runs(residual, property, n, minimum, BANDS, context), buffer = engine.memory.buffer;
    return {count, value: new Int32Array(buffer.slice(residual, residual + count * 4)), distance: new Int32Array(buffer.slice(property, property + count * 4)),
      context: new Uint8Array(buffer.slice(context, context + count))};
  } catch {
    throw fault('JXL_WASM', KERNEL_FAIL);
  }
}

export const SCAN_WORDS = 1 << 21;
export function captureScan(words, stride, x0, y0, w, h, limit, rows) {
  if (!(words instanceof Uint32Array) || !Number.isInteger(stride) || !Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1 ||
      x0 < 0 || y0 < 0 || x0 + w > stride || stride * h > SCAN_WORDS || (y0 + h) * stride > words.length ||
      !Number.isInteger(limit) || limit < 1 || limit > 16384 || !prepareCaptureKernels()) return undefined;
  try {
    ready();
    let size = 1024;
    while (size < limit * 2) size <<= 1;
    const band = stride * h, n = w * h, keys = P, slots = keys + size * 4, colours = slots + size * 2, first = colours + limit * 4,
      last = first + limit * 4, at = last + limit * 4, indices = at + band * 4;
    reserve(indices + n * 2 + 3 & ~3);
    const buffer = engine.memory.buffer;
    new Uint8Array(buffer, keys, size * 6).fill(0);
    new Uint32Array(buffer, at, band).set(words.subarray(y0 * stride, y0 * stride + band));
    const count = engine.scan(at, stride, x0, w, h, limit, rows ? 1 : 0, keys, slots, size - 1, Math.clz32(size) + 1, colours, indices, first, last);
    if (count < 0) return null;
    return {colours: new Uint32Array(buffer.slice(colours, colours + count * 4)), indices: new Uint16Array(buffer.slice(indices, indices + n * 2)),
      first: rows ? new Int32Array(buffer.slice(first, first + count * 4)) : undefined, last: rows ? new Int32Array(buffer.slice(last, last + count * 4)) : undefined};
  } catch { return undefined; }
}

export function treeArena(count, span) {
  if (!Number.isInteger(count) || count < 1 || count > 1048576 || !Number.isInteger(span) || span < 128 || span > 65536 || !prepareCaptureKernels())
    throw fault('JXL_INTERNAL', 'The capture context tree was called outside its bounds.');
  try {
    ready();
    const all = P, counts = all + 512, order = counts + span * 16, scratch = order + count * 4, tokens = scratch + count * 4;
    const by = tokens + count, bx = by + count, bw = bx + count, bn = bw + count, end = bn + count;
    reserve(end);
    const buffer = engine.memory.buffer, {tally, part} = engine, bins = [by, bx, bw, bn];
    return {
      all: new Uint32Array(buffer, all, 128), counts: new Uint32Array(buffer, counts, span * 4), order: new Int32Array(buffer, order, count),
      tokens: new Uint8Array(buffer, tokens, count), by: new Uint8Array(buffer, by, count), bx: new Uint8Array(buffer, bx, count),
      bw: new Uint8Array(buffer, bw, count), bn: new Uint8Array(buffer, bn, count),
      tally: (from, to, withBins) => tally(order, from, to, tokens, by, bx, bw, bn, all, counts, span, withBins ? 1 : 0),
      part: (from, to, property, cut) => part(order, from, to, bins[property], cut, scratch),
    };
  } catch (error) {
    if (error?.code) throw error;
    throw fault('JXL_WASM', KERNEL_FAIL);
  }
}

export function captureLiterals(models, n, remap) {
  if (!Number.isInteger(n) || n < 1 || n > 65536 || remap && !(remap instanceof Int32Array && remap.length >= n) || !prepareCaptureKernels())
    throw fault('JXL_INTERNAL', 'The capture palette pieces were called outside their bounds.');
  try {
    ready();
    const table = P, values = table + n * 4;
    let uses;
    for (const model of models) {
      const count = model.count;
      if (!(model.pieceValue instanceof Int32Array) || !(model.pieceDistance instanceof Int32Array) || !Number.isInteger(count) ||
          count < 1 || count > 1048576 || model.pieceValue.length < count || model.pieceDistance.length < count)
        throw fault('JXL_INTERNAL', 'The capture palette pieces were called outside their bounds.');
      const distances = values + count * 4;
      reserve(distances + count * 4);
      const buffer = engine.memory.buffer, i32 = new Int32Array(buffer);
      if (remap) i32.set(remap.subarray(0, n), table >> 2);
      else if (!uses) i32.fill(0, table >> 2, (table >> 2) + n);
      else i32.set(uses, table >> 2);
      i32.set(model.pieceValue.subarray(0, count), values >> 2);
      i32.set(model.pieceDistance.subarray(0, count), distances >> 2);
      engine.literals(values, distances, count, table, remap ? 1 : 0);
      if (remap) model.pieceValue.set(i32.subarray(values >> 2, (values >> 2) + count));
      else uses = new Uint32Array(buffer.slice(table, table + n * 4));
    }
    return remap ? undefined : uses ?? new Uint32Array(n);
  } catch (error) {
    if (error?.code) throw error;
    throw fault('JXL_WASM', KERNEL_FAIL);
  }
}

export function capturePieceCounts(model, small) {
  const {count, classes, pieceValue, pieceDistance, pieceContext} = model;
  if (!Number.isInteger(count) || count < 1 || count > 1048576 || !Number.isInteger(classes) || classes < 1 || classes > 4096 ||
      !(pieceValue instanceof Int32Array) || !(pieceDistance instanceof Int32Array) || !(pieceContext instanceof Uint8Array) ||
      pieceValue.length < count || pieceDistance.length < count || pieceContext.length < count || !Number.isInteger(small) ||
      small < 1 || small > 4096 || classes * small > 1 << 21 || !prepareCaptureKernels())
    throw fault('JXL_INTERNAL', 'The capture histograms were called outside their bounds.');
  try {
    ready();
    const table = P, literals = table + classes * small * 4, values = literals + classes * 4, distances = values + count * 4;
    const others = distances + count * 4, contexts = others + count * 4;
    reserve(contexts + count);
    const buffer = engine.memory.buffer, i32 = new Int32Array(buffer);
    i32.fill(0, table >> 2, values >> 2);
    i32.set(pieceValue.subarray(0, count), values >> 2);
    i32.set(pieceDistance.subarray(0, count), distances >> 2);
    new Uint8Array(buffer).set(pieceContext.subarray(0, count), contexts);
    const n = engine.pieces(values, distances, contexts, count, small, table, literals, others);
    return {counts: new Uint32Array(buffer.slice(table, literals)), literals: new Uint32Array(buffer, literals, classes),
      others: new Int32Array(buffer, others, n)};
  } catch (error) {
    if (error?.code) throw error;
    throw fault('JXL_WASM', KERNEL_FAIL);
  }
}

export function requireCaptureKernels() {
  if (!prepareCaptureKernels()) throw wasmRequired();
}

export function captureResiduals(plane, width, height, residuals, properties) {
  if (!captureWeighted(null, null, plane, width, height, 0, undefined, residuals, properties))
    throw fault('JXL_WASM', KERNEL_FAIL);
}
