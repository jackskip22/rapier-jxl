import {wasmModule, hasWasmModule, suppliedWasm, compileWasm} from './wasm-modules.mjs';
// SPDX-License-Identifier: MIT
import {fault} from './fault.mjs';
import {wasmRequired} from './capture-wasm-error.mjs';
import {CAPTURE} from './capture-kernels-bytes.mjs';
import {wasmBytes} from './wasm-text.mjs';
import {weightedTables} from './weighted-policy.mjs';

export const WEIGHTED_BANDS = [-200, -100, -50, -25, -12, -6, -3, -1, 0, 2, 4, 7, 13, 26, 51, 101, 201];
export const WEIGHTED_CONTEXT = Uint8Array.from({length: 511}, (_, i) => WEIGHTED_BANDS.filter(cut => cut < i - 255).length);
export const LOG_MANTISSA = Uint8Array.of(0, 1, 3, 4, 5, 7, 8, 9, 10, 11, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 22, 23, 24, 25, 26, 27, 27, 28, 29, 30, 31, 31);

const P = 65536, DIV = 16, WEIGHTS = 272, BANDS = 32768, LOG = 33792, HEADS = 262144, SCRATCH = 832;
const SIMD_PROBE = 'AGFzbQEAAAABBQFgAAF/AwIBAAcJAQVwcm9iZQAACgsBCQBBAP0R/RsACw==';
const KERNEL_FAIL = 'The JPEG XL capture WebAssembly kernel could not run. Check available memory and runtime limits.';
let compiled, engine, simd;

const SIMD_OK = () => hasWasmModule('simd') || !suppliedWasm() && WebAssembly.validate(Uint8Array.from(atob(SIMD_PROBE), c => c.charCodeAt(0)));

export async function compileCaptureKernels() {
  try {
    if (typeof WebAssembly !== 'object' || new Uint8Array(new Uint32Array([1]).buffer)[0] !== 1) return false;
    simd ??= SIMD_OK();
    if (!simd || !await compileWasm('capture', () => wasmBytes(CAPTURE))) return false;
    return prepareCaptureKernels();
  } catch { return false; }
}

export function prepareCaptureKernels() {
  try {
    if (typeof WebAssembly !== 'object' || new Uint8Array(new Uint32Array([1]).buffer)[0] !== 1) return false;
    simd ??= SIMD_OK();
    if (!simd) return false;
    compiled ||= wasmModule('capture', () => wasmBytes(CAPTURE));
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
    const n = width * height, residual = base + n * 4, property = base + n * 8, state = base + n * 12;
    reserve(state + (width + 2) * 40);
    const i32 = new Int32Array(engine.memory.buffer);
    i32.set(plane.subarray(0, n), base >> 2);
    i32.fill(0, state >> 2, (state >> 2) + (width + 2) * 10);
    engine.weighted(base, width, height, offset, residual, property, 0, 0, 0, DIV, WEIGHTS, state);
    if (keep) return true;
    residuals.set(i32.subarray(residual >> 2, (residual >> 2) + n));
    if (properties) properties.set(i32.subarray(property >> 2, (property >> 2) + n));
    return true;
  } catch { return false; }
}

let base = P, held = null;
export function captureHold(words) {
  captureRelease();
  if (!(words instanceof Uint32Array) || words.length > SCAN_WORDS || !prepareCaptureKernels()) return false;
  try {
    ready();
    reserve(P + words.length * 4 + 16);
    new Uint32Array(engine.memory.buffer, P, words.length).set(words);
    held = {buffer: words.buffer, offset: words.byteOffset, end: words.byteOffset + words.byteLength};
    base = P + (words.length * 4 + 16 & ~15);
    return true;
  } catch { captureRelease(); return false; }
}
export function captureRelease() { held = null; base = P; }
function heldAt(words) {
  return held && words.buffer === held.buffer && words.byteOffset >= held.offset && words.byteOffset + words.byteLength <= held.end
    ? P + words.byteOffset - held.offset : -1;
}

function ready() {
  if (engine) return;
  const memory = new WebAssembly.Memory({initial: 1, maximum: 320}), {weighted, copies, runs, scan, tally, part, literals, pieces, lowestInk, prices, edges, rowInk, colInk} = new WebAssembly.Instance(compiled, {env: {memory}}).exports;
  weightedTables(new Int32Array(memory.buffer), DIV, WEIGHTS);
  new Uint8Array(memory.buffer).set(WEIGHTED_CONTEXT, BANDS);
  new Uint8Array(memory.buffer).set(LOG_MANTISSA, LOG);
  engine = {memory, weighted, copies, runs, scan, tally, part, literals, pieces, lowestInk, prices, edges, rowInk, colInk};
}
function reserve(bytes) {
  const have = engine.memory.buffer.byteLength;
  if (bytes > have) engine.memory.grow(Math.ceil((bytes - have) / 65536));
}

export function capturePrices(configs, {values, counts}, distance = false) {
  if (!(values instanceof Int32Array) || !(counts instanceof Uint32Array) || values.length !== counts.length ||
      values.length > 1048576 || configs.length < 1 || configs.length > 64)
    throw fault('JXL_INTERNAL', 'The capture token prices were called outside their bounds.');
  requireCaptureKernels();
  try {
    ready();
    const freqs = base, used = freqs + 131072, input = used + 4096, n = values.length, tallies = input + n * 4,
      config = tallies + n * 4, output = config + configs.length * 16;
    reserve(output + configs.length * 16);
    const buffer = engine.memory.buffer, i32 = new Int32Array(buffer);
    i32.set(values, input >> 2); i32.set(counts, tallies >> 2);
    for (let k = 0; k < configs.length; k++) {
      const c = configs[k], at = (config >> 2) + k * 4;
      i32[at] = c.split; i32[at + 1] = c.msb; i32[at + 2] = c.lsb; i32[at + 3] = c.splitToken;
    }
    engine.prices(input, tallies, n, config, configs.length, distance ? 1 : 0, freqs, used, LOG, output);
    return new Float64Array(buffer.slice(output, output + configs.length * 16));
  } catch (error) {
    if (error?.code) throw error;
    throw fault('JXL_WASM', KERNEL_FAIL);
  }
}

export function captureCopies(values, stride, origin, width, height, contexts, depth, minimum, scale, spatial) {
  try {
    if (!prepareCaptureKernels()) throw wasmRequired();
    const n = width * height;
    if (!(values instanceof Uint16Array) || !Number.isInteger(width) || width < 1 || width > 16384 || !Number.isInteger(height) || height < 1 ||
        n > 1048576 || !Number.isInteger(stride) || stride < width || !Number.isInteger(origin) || origin < 0 ||
        origin + (height - 1) * stride + width > values.length || contexts !== null && !(contexts instanceof Uint8Array && contexts.length >= n) ||
        !(spatial instanceof Uint8Array) || spatial.length > width * 8 + 64 || !Number.isInteger(depth) || depth < 0 || depth > 64 ||
        !Number.isInteger(minimum) || minimum < 1 || !Number.isInteger(scale) || scale < 1 || scale > 2)
      throw fault('JXL_INTERNAL', 'The capture copy search was called outside its bounds.');
    ready();
    const scratch = base + spatial.length + 3 & ~3, heads = scratch + SCRATCH, at = heads + (depth ? HEADS : 0);
    const chain = at + (n * 2 + 19 & ~3), value = chain + (depth ? n * 4 : 0), distance = value + n * 4, context = distance + n * 4;
    reserve(context + n);
    const buffer = engine.memory.buffer, bytes = new Uint8Array(buffer), plane = new Uint16Array(buffer, at, n);
    bytes.set(spatial, base);
    if (stride === width) plane.set(values.subarray(origin, origin + n));
    else for (let y = 0, from = origin; y < height; y++, from += stride) plane.set(values.subarray(from, from + width), y * width);
    if (contexts) bytes.set(contexts.subarray(0, n), context);
    const count = engine.copies(at, contexts ? context : 0, n, width, depth, minimum, scale, base, spatial.length, heads, chain, scratch, value, distance, context);
    return {count, value: new Int32Array(buffer.slice(value, value + count * 4)), distance: new Int32Array(buffer.slice(distance, distance + count * 4)),
      context: contexts ? new Uint8Array(buffer.slice(context, context + count)) : new Uint8Array(count)};
  } catch (error) {
    if (error?.code) throw error;
    throw fault('JXL_WASM', KERNEL_FAIL);
  }
}

export function captureWeightedPieces(plane, width, height, minimum) {
  if (!captureWeighted(null, null, plane, width, height, 0, undefined, null, null, true))
    throw fault('JXL_WASM', KERNEL_FAIL);
  try {
    const n = width * height, residual = base + n * 4, property = base + n * 8, context = base + n * 12 + (width + 2) * 40;
    reserve(context + n);
    const count = engine.runs(residual, property, n, minimum, BANDS, context), buffer = engine.memory.buffer;
    return {count, value: new Int32Array(buffer.slice(residual, residual + count * 4)), distance: new Int32Array(buffer.slice(property, property + count * 4)),
      context: new Uint8Array(buffer.slice(context, context + count))};
  } catch {
    throw fault('JXL_WASM', KERNEL_FAIL);
  }
}

export const SCAN_WORDS = 1 << 21;
export function captureLowestInk(words, width, height, background, stride = width, origin = 0) {
  if (!(words instanceof Uint32Array) || !Number.isInteger(width) || !Number.isInteger(height) || width < 1 || width > 16384 ||
      height < 1 || height > 16384 || !Number.isInteger(stride) || stride < width || !Number.isInteger(origin) || origin < 0 ||
      origin + (height - 1) * stride + width > words.length)
    throw fault('JXL_INTERNAL', 'The capture column scan was called outside its bounds.');
  requireCaptureKernels();
  try {
    ready();
    const at = heldAt(words.subarray(origin, origin + (height - 1) * stride + width));
    const lowest = base, open = lowest + width * 4, pixels = open + width * 4, rows = at < 0 ? Math.min(height, Math.floor(SCAN_WORDS / width)) : height;
    reserve(at < 0 ? pixels + rows * width * 4 : pixels);
    const buffer = engine.memory.buffer, i32 = new Int32Array(buffer), u32 = new Uint32Array(buffer);
    i32.fill(-1, lowest >> 2, (lowest >> 2) + width);
    i32.fill(-1, open >> 2, (open >> 2) + width);
    for (let end = height, count = width; end && count;) {
      const start = Math.max(0, end - rows);
      if (at < 0) for (let y = start; y < end; y++) u32.set(words.subarray(origin + y * stride, origin + y * stride + width), (pixels >> 2) + (y - start) * width);
      count = at < 0 ? engine.lowestInk(pixels, width, width, end - start, start, background, open, count, lowest)
        : engine.lowestInk(at + start * stride * 4, width, stride, end - start, start, background, open, count, lowest);
      end = start;
    }
    return new Int32Array(buffer.slice(lowest, lowest + width * 4));
  } catch (error) {
    if (error?.code) throw error;
    throw fault('JXL_WASM', KERNEL_FAIL);
  }
}

export function captureCropEdges(words, width, height, stride = width, origin = 0) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || stride < width || origin < 0) return undefined;
  const at = heldAt(words.subarray(origin, origin + (height - 1) * stride + width));
  if (at < 0) return undefined;
  try {
    const out = base;
    reserve(out + 16);
    engine.edges(at, width, height, stride, out);
    const edges = new Int32Array(engine.memory.buffer, out, 4);
    return edges[0] === width * height ? null : Array.from(edges);
  } catch { return undefined; }
}

export function captureRowsUnlike(words, width, height, stride, origin) {
  const at = heldAt(words.subarray(origin, origin + (height - 1) * stride + width));
  if (at < 0) return undefined;
  try {
    reserve(base + height * 4);
    engine.rowInk(at, width, height, stride, base);
    return new Int32Array(engine.memory.buffer.slice(base, base + height * 4));
  } catch { return undefined; }
}
export function captureColumnsUnlike(words, width, height, stride, origin, y0, y1, key) {
  const at = heldAt(words.subarray(origin, origin + (height - 1) * stride + width));
  if (at < 0 || !(y0 >= 0 && y0 <= y1 && y1 <= height)) return undefined;
  try {
    reserve(base + width * 4);
    engine.colInk(at, width, y0, y1, stride, key, base);
    return new Int32Array(engine.memory.buffer.slice(base, base + width * 4));
  } catch { return undefined; }
}

let pageIndices = null;
export function captureScan(words, stride, x0, y0, w, h, limit, rows) {
  if (!(words instanceof Uint32Array) || !Number.isInteger(stride) || !Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1 ||
      x0 < 0 || y0 < 0 || x0 + w > stride || stride > SCAN_WORDS || (y0 + h) * stride > words.length ||
      !Number.isInteger(limit) || limit < 1 || limit > 16384 || !prepareCaptureKernels()) return undefined;
  try {
    ready();
    let size = 1024;
    while (size < limit * 2) size <<= 1;
    const bandRows = Math.min(h, Math.floor(SCAN_WORDS / stride)), band = stride * bandRows, n = w * h,
      rowsAt = heldAt(words.subarray(y0 * stride, (y0 + h) * stride)), keys = base, slots = keys + size * 4,
      colours = slots + size * 2, first = colours + limit * 4, last = first + limit * 4, at = rowsAt < 0 ? last + limit * 4 : rowsAt,
      indices = rowsAt < 0 ? at + band * 4 : last + limit * 4;
    reserve(indices + w * bandRows * 2 + 3 & ~3);
    const buffer = engine.memory.buffer;
    new Uint8Array(buffer, keys, size * 6).fill(0);
    let plane, count = 0;
    for (let y = 0; y < h; y += bandRows) {
      const height = Math.min(bandRows, h - y);
      if (rowsAt < 0) new Uint32Array(buffer, at, stride * height).set(words.subarray((y0 + y) * stride, (y0 + y + height) * stride));
      count = engine.scan(rowsAt < 0 ? at : at + y * stride * 4, stride, x0, w, height, limit, rows ? 1 : 0,
        keys, slots, size - 1, Math.clz32(size) + 1, colours, indices, first, last, count, y);
      if (count < 0) return null;
      if (!plane) {
        if (rows && n <= SCAN_WORDS) {
          if (!pageIndices || pageIndices.length < n) pageIndices = new Uint16Array(Math.max(n, 1 << 20));
          plane = pageIndices.subarray(0, n);
        } else plane = new Uint16Array(n);
      }
      plane.set(new Uint16Array(buffer, indices, w * height), y * w);
    }
    return {colours: new Uint32Array(buffer.slice(colours, colours + count * 4)), indices: plane,
      first: rows ? new Int32Array(buffer.slice(first, first + count * 4)) : undefined, last: rows ? new Int32Array(buffer.slice(last, last + count * 4)) : undefined};
  } catch { return undefined; }
}

export function treeArena(count, span) {
  if (!Number.isInteger(count) || count < 1 || count > 1048576 || !Number.isInteger(span) || span < 128 || span > 65536 || !prepareCaptureKernels())
    throw fault('JXL_INTERNAL', 'The capture context tree was called outside its bounds.');
  try {
    ready();
    const all = base, counts = all + 512, order = counts + span * 16, scratch = order + count * 4, tokens = scratch + count * 4;
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
    const table = base, values = table + n * 4;
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
    const table = base, literals = table + classes * small * 4, values = literals + classes * 4, distances = values + count * 4;
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
