import {kernelModule, compileKernels, kernelsSupported} from './kernel-runtime.mjs';
// SPDX-License-Identifier: MIT
import {fault} from './fault.mjs';
import {wasmRequired} from './capture-wasm-error.mjs';
import {weightedTables} from './weighted-policy.mjs';
import {kernelHooks} from './kernel-hooks.mjs';
import {BitWriter} from './bits.mjs';

export const WEIGHTED_BANDS = [-200, -100, -50, -25, -12, -6, -3, -1, 0, 2, 4, 7, 13, 26, 51, 101, 201];
export const WEIGHTED_CONTEXT = Uint8Array.from({length: 511}, (_, i) => WEIGHTED_BANDS.filter(cut => cut < i - 255).length);
export const LOG_MANTISSA = Uint8Array.of(0, 1, 3, 4, 5, 7, 8, 9, 10, 11, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 22, 23, 24, 25, 26, 27, 27, 28, 29, 30, 31, 31);

const MEMORY_PAGES = 640;
const P = 65536, DIV = 16, WEIGHTS = 272, BANDS = 32768, CONTEXTS = 33280, LOG = 33792, HEADS = 262144, SCRATCH = 832;
export const kernelFail = cause => Object.assign(new Error("The capture WebAssembly kernel could not run: check memory. Under a CSP, add 'wasm-unsafe-eval' to script-src.", {cause}), {code: 'JXL_WASM'});
let compiled, engine, simd, resident;

const SIMD_OK = kernelsSupported;

export async function compileCaptureKernels() {
  try { return await compileKernels() && prepareCaptureKernels(); } catch { return false; }
}

export function prepareCaptureKernels() {
  try {
    if (typeof WebAssembly !== 'object' || new Uint8Array(new Uint32Array([1]).buffer)[0] !== 1) return false;
    simd ??= SIMD_OK();
    if (!simd) return false;
    compiled ||= kernelModule();
    return true;
  } catch { return false; }
}

export function captureWeighted(w, targets, plane, width, height, offset, contextOf, residuals, properties, keep = false, y0 = 0) {
  if (w || !(plane instanceof Int16Array) || !Number.isInteger(width) || !Number.isInteger(height) ||
      width < 1 || height < 1 || width > 16384 || width * height > 1048576 || plane.length < width * height ||
      !Number.isInteger(offset) || Math.abs(offset) > 32768 || !keep && (!(residuals instanceof Uint32Array) ||
      residuals.length < width * height || properties && (!(properties instanceof Int32Array) || properties.length < width * height))) return false;
  if (!prepareCaptureKernels()) return false;
  try {
    ready();
    if (y0 && !(y0 === 8 && resident && resident.buffer === plane.buffer && resident.offset === plane.byteOffset &&
        resident.width === width && resident.height === height && resident.base === base)) y0 = 0;
    const n = width * height, cap = keep > 2 ? width * keep : n, residual = base + cap * 4, property = base + cap * 8, state = base + cap * 12,
      sPlane = state + (width + 2) * 40, sVal = sPlane + (n * 2 + 15 & ~15), sCtx = sVal + (n * 2 + 15 & ~15);
    reserve(keep > 1 ? sCtx + n + 16 : sPlane);
    const buf = engine.memory.buffer, i32 = new Int32Array(buf);
    if (!y0) {
      i32.set(plane.subarray(0, n), base >> 2);
      i32.fill(0, state >> 2, (state >> 2) + (width + 2) * 10);
    } else i32.set(plane.subarray(y0 * width, n), (base >> 2) + y0 * width);
    if (y0 < height) engine.captureWeighted(base + y0 * width * 4, width, height, offset, residual + y0 * width * 4, property + y0 * width * 4, y0, 0, 0, DIV, WEIGHTS, state);
    if (keep > 1) {
      new Int16Array(buf, sPlane, n).set(plane.subarray(0, n));
      engine.smooth(sPlane, width, 0, height, sVal, sCtx);
      if (keep > 2 && height === 8) resident = {buffer: plane.buffer, offset: plane.byteOffset, width, height: keep, base};
      return {residuals: new Uint32Array(buf, residual, n), properties: new Int32Array(buf, property, n),
        values: new Uint16Array(buf, sVal, n), contexts: new Uint8Array(buf, sCtx, n)};
    }
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
export function captureRelease() { resident = null; held = null; base = P; }
function heldAt(words) {
  return held && words.buffer === held.buffer && words.byteOffset >= held.offset && words.byteOffset + words.byteLength <= held.end
    ? P + words.byteOffset - held.offset : -1;
}

function ready() {
  if (engine) return;
  const memory = new WebAssembly.Memory({initial: 1, maximum: MEMORY_PAGES});
  weightedTables(new Int32Array(memory.buffer), DIV, WEIGHTS);
  new Uint8Array(memory.buffer).set(WEIGHTED_CONTEXT, BANDS);
  for (let c = 0; c < 16; c++) new Uint8Array(memory.buffer)[CONTEXTS + 255 + c] = c;
  new Uint8Array(memory.buffer).set(LOG_MANTISSA, LOG);
  engine = {...new WebAssembly.Instance(compiled, {env: {memory}}).exports, memory};
}
function reserve(bytes) {
  resident = null;
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
    throw error?.code ? error : kernelFail(error);
  }
}

export function captureCopies(values, stride, origin, width, height, contexts, depth, minimum, scale, spatial, lazyUnder = 1 << 30, nice = 1 << 30) {
  try {
    if (!prepareCaptureKernels()) throw wasmRequired();
    const n = width * height;
    const smooth = values instanceof Int16Array;
    if (!(values instanceof Uint16Array || smooth && stride === width && !origin && contexts === null) ||
        !Number.isInteger(width) || width < 1 || width > 16384 || !Number.isInteger(height) || height < 1 ||
        n > 1048576 || !Number.isInteger(stride) || stride < width || !Number.isInteger(origin) || origin < 0 ||
        origin + (height - 1) * stride + width > values.length || contexts !== null && !(contexts instanceof Uint8Array && contexts.length >= n) ||
        !(spatial instanceof Uint8Array) || spatial.length > width * 8 + 64 || !Number.isInteger(depth) || depth < 0 || depth > 64 ||
        !Number.isInteger(minimum) || minimum < 1 || !Number.isInteger(scale) || scale < 1 || scale > 2 ||
        !Number.isInteger(lazyUnder) || lazyUnder < 0 || lazyUnder > 1 << 30 || !Number.isInteger(nice) || nice < 1 || nice > 1 << 30)
      throw fault('JXL_INTERNAL', 'The capture copy search was called outside its bounds.');
    ready();
    const scratch = base + spatial.length + 3 & ~3, heads = scratch + SCRATCH, at = heads + (depth ? HEADS : 0);
    const chain = at + (n * 2 + 19 & ~3), value = chain + (depth ? n * 4 : 0), distance = value + n * 4, context = distance + n * 4;
    reserve(context + n + 16);
    const buffer = engine.memory.buffer, bytes = new Uint8Array(buffer), plane = new Uint16Array(buffer, at, n);
    bytes.set(spatial, base);
    if (smooth) {
      new Int16Array(buffer, value, n).set(values.subarray(0, n));
      engine.smooth(value, width, 0, height, at, context);
    } else {
      if (stride === width) plane.set(values.subarray(origin, origin + n));
      else for (let y = 0, from = origin; y < height; y++, from += stride) plane.set(values.subarray(from, from + width), y * width);
      if (contexts) bytes.set(contexts.subarray(0, n), context);
    }
    const hasCtx = smooth || Boolean(contexts);
    const count = engine.copies(at, hasCtx ? context : 0, n, width, depth, minimum, scale, base, spatial.length, heads, chain, scratch, value, distance, context, lazyUnder, nice);
    return {count, value: new Int32Array(buffer.slice(value, value + count * 4)), distance: new Int32Array(buffer.slice(distance, distance + count * 4)),
      context: hasCtx ? new Uint8Array(buffer.slice(context, context + count)) : new Uint8Array(count)};
  } catch (error) {
    throw error?.code ? error : kernelFail(error);
  }
}

export function captureWeightedPieces(plane, width, height, minimum, y0 = 0) {
  if (!captureWeighted(null, null, plane, width, height, 0, undefined, null, null, true, y0))
    throw kernelFail();
  try {
    const n = width * height, residual = base + n * 4, property = base + n * 8, context = base + n * 12 + (width + 2) * 40;
    reserve(context + n);
    const count = engine.runs(residual, property, n, minimum, BANDS, context), buffer = engine.memory.buffer;
    return {count, value: new Int32Array(buffer.slice(residual, residual + count * 4)), distance: new Int32Array(buffer.slice(property, property + count * 4)),
      context: new Uint8Array(buffer.slice(context, context + count))};
  } catch (error) {
    throw kernelFail(error);
  }
}

const MEMORY_BYTES = MEMORY_PAGES * 65536;
export function captureWeightedLanes(planes, width, height, minimum, small, gradient = false, answers = null) {
  const n = width * height, lanes = planes.length;
  if (lanes < 2 || lanes > 4 || !Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 16384 ||
      n > 1048576 || planes.some(plane => !(plane instanceof Int16Array) || plane.length < n) || !prepareCaptureKernels())
    throw fault('JXL_INTERNAL', 'The capture weighted lanes were called outside their bounds.');
  try {
    ready();
    const written = lanes === 4 ? 4 : 3, state = base, plane = state + (width + 2) * 160, residual = plane + n * 8,
      property = residual + n * 4 * written, context = property + n * 4 * written, classes = WEIGHTED_BANDS.length + 1,
      table = context + n + 19 & ~3, literals = table + classes * small * 4, others = literals + classes * 4, end = others + n * 4;
    if (end > MEMORY_BYTES) return null;
    reserve(end);
    const buffer = engine.memory.buffer, samples = new Int16Array(buffer, plane, n * 4);
    if ((typeof __RAPIER_JXL_CAPTURE_DEEP__ === 'undefined' || __RAPIER_JXL_CAPTURE_DEEP__) && answers) answers.forEach((a, c) => {
      new Uint32Array(buffer, residual + c * n * 4, n).set(a.residuals.subarray(0, n));
      new Int32Array(buffer, property + c * n * 4, n).set(a.properties.subarray(0, n));
    });
    else {
      new Uint8Array(buffer, state, (width + 2) * 160).fill(0);
      for (let c = 0; c < 4; c++) {
        const source = planes[c];
        if (source) for (let i = 0, at = c; i < n; i++, at += 4) samples[at] = source[i];
        else for (let at = c; at < n * 4; at += 4) samples[at] = 0;
      }
      if (gradient) engine.gradient4(plane, width, height, written, residual, property);
      else engine.weighted4(plane, width, height, written, residual, property, DIV, WEIGHTS, state);
    }
    return planes.map((_, c) => {
      const values = residual + c * n * 4, distances = property + c * n * 4;
      const count = engine.runs(values, distances, n, minimum, gradient ? CONTEXTS : BANDS, context);
      new Int32Array(buffer, table, classes * (small + 1)).fill(0);
      const other = engine.pieces(values, distances, context, count, small, table, literals, others);
      return {count, value: new Int32Array(buffer.slice(values, values + count * 4)), distance: new Int32Array(buffer.slice(distances, distances + count * 4)),
        context: new Uint8Array(buffer.slice(context, context + count)),
        counts: {counts: new Uint32Array(buffer.slice(table, literals)), literals: new Uint32Array(buffer.slice(literals, literals + classes * 4)),
          others: new Int32Array(buffer.slice(others, others + other * 4))}};
    });
  } catch (error) {
    throw error?.code ? error : kernelFail(error);
  }
}

export const SCAN_WORDS = 1 << 21;
export function captureLowestInk(words, width, height, background, stride = width, origin = 0) {
  if (!(words instanceof Uint32Array) || !Number.isInteger(width) || !Number.isInteger(height) || width < 1 || width > 32767 ||
      height < 1 || height > 32767 || !Number.isInteger(stride) || stride < width || !Number.isInteger(origin) || origin < 0 ||
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
    throw error?.code ? error : kernelFail(error);
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
export function captureScan(words, stride, x0, y0, w, h, limit, rows, blank = null) {
  if (!(words instanceof Uint32Array) || !Number.isInteger(stride) || !Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1 ||
      x0 < 0 || y0 < 0 || x0 + w > stride || stride > SCAN_WORDS || (y0 + h) * stride > words.length ||
      !Number.isInteger(limit) || limit < 1 || limit > 16384 || !prepareCaptureKernels()) return undefined;
  try {
    ready();
    let size = 1024;
    while (size < limit * 2) size <<= 1;
    const bandRows = Math.min(h, Math.floor(SCAN_WORDS / stride)), band = stride * bandRows, n = w * h,
      rowsAt = blank ? -1 : heldAt(words.subarray(y0 * stride, (y0 + h) * stride)), keys = base, slots = keys + size * 4,
      colours = slots + size * 2, first = colours + limit * 4, last = first + limit * 4, at = rowsAt < 0 ? last + limit * 4 : rowsAt,
      indices = rowsAt < 0 ? at + band * 4 : last + limit * 4;
    reserve(indices + w * bandRows * 2 + 3 & ~3);
    const buffer = engine.memory.buffer;
    new Uint8Array(buffer, keys, size * 6).fill(0);
    let plane, count = 0;
    for (let y = 0; y < h; y += bandRows) {
      const height = Math.min(bandRows, h - y);
      if (rowsAt < 0) {
        const band = new Uint32Array(buffer, at, stride * height), top = y0 + y;
        band.set(words.subarray(top * stride, (top + height) * stride));
        if (blank) for (const r of blank) for (let row = Math.max(r.y, top); row < Math.min(r.y + r.height, top + height); row++)
          band.fill(r.fill, (row - top) * stride + r.x, (row - top) * stride + r.x + r.width);
      }
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
    throw error?.code ? error : kernelFail(error);
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
    throw error?.code ? error : kernelFail(error);
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
    throw error?.code ? error : kernelFail(error);
  }
}

const TOKEN_OUT = 1 << 18;
export function captureTokens(writer, models, index, codes, configs, fastBits, fastLen, copy) {
  requireCaptureKernels();
  try {
    ready();
    const hn = codes.length;
    let symbols = 0;
    for (const code of codes) symbols += code.lengths.length;
    const dSymbols = copy ? copy.code.lengths.length : 0, sLen = copy ? copy.sCodes.length : 0;
    let largest = 1;
    for (const model of models) largest = Math.max(largest, model.count);
    const state = base, hmap = state + 16, syms = hmap + 1024, cfg = syms + hn * 4, lengthConfig = cfg + hn * 16,
      distanceConfig = lengthConfig + 16, fast = distanceConfig + 16, codeTable = fast + hn * 4096, dcodes = codeTable + symbols * 8,
      sCodes = dcodes + dSymbols * 8, values = sCodes + (sLen * 2 + 7 & ~7), distances = values + largest * 4,
      contexts = distances + largest * 4, out = contexts + (largest + 7 & ~7), end = out + TOKEN_OUT + 64;
    reserve(end);
    const buffer = engine.memory.buffer, i32 = new Int32Array(buffer), u32 = new Uint32Array(buffer), u8 = new Uint8Array(buffer);
    const putConfig = (at, c) => { i32[at >> 2] = c.split; i32[(at >> 2) + 1] = c.msb; i32[(at >> 2) + 2] = c.lsb; i32[(at >> 2) + 3] = c.splitToken; };
    for (let h = 0, at = 0; h < hn; h++) {
      const {lengths, codes: bits} = codes[h];
      i32[(syms >> 2) + h] = at;
      putConfig(cfg + h * 16, configs[h]);
      for (let s = 0; s < lengths.length; s++, at++) { u32[(codeTable >> 2) + at * 2] = bits[s]; u32[(codeTable >> 2) + at * 2 + 1] = lengths[s]; }
    }
    for (let i = 0, n = hn << 9; i < n; i++) { u32[(fast >> 2) + i * 2] = fastBits[i]; u32[(fast >> 2) + i * 2 + 1] = fastLen[i]; }
    if (copy) {
      putConfig(lengthConfig, copy.lengthConfig); putConfig(distanceConfig, copy.distanceConfig);
      const {lengths, codes: bits} = copy.code;
      for (let s = 0; s < lengths.length; s++) { u32[(dcodes >> 2) + s * 2] = bits[s]; u32[(dcodes >> 2) + s * 2 + 1] = lengths[s]; }
      new Int16Array(buffer, sCodes, sLen).set(copy.sCodes);
    }
    new BigInt64Array(buffer, state, 1)[0] = BigInt(writer.acc);
    i32[(state >> 2) + 2] = writer.pending;
    for (const model of models) {
      const count = model.count, classes = model.classes;
      for (let c = 0; c < classes; c++) i32[(hmap >> 2) + c] = index[model.base + c];
      i32.set(model.pieceValue.subarray(0, count), values >> 2);
      i32.set(model.pieceDistance.subarray(0, count), distances >> 2);
      u8.set(model.pieceContext.subarray(0, count), contexts);
      for (let k = 0; k < count;) {
        k = engine.captureTokens(values, distances, contexts, k, count, hmap, fast, syms, codeTable, cfg, lengthConfig, distanceConfig,
          dcodes, copy ? copy.minSymbol : 0, copy?.spatial ? 1 : 0, sLen, sCodes, out, out + TOKEN_OUT, state);
        const written = i32[(state >> 2) + 3] - out;
        if (writer.at + written + 16 >= writer.bytes.length) writer.grow(written + 16);
        writer.bytes.set(u8.subarray(out, out + written), writer.at);
        writer.at += written;
      }
    }
    writer.acc = Number(new BigInt64Array(buffer, state, 1)[0]); writer.pending = i32[(state >> 2) + 2];
  } catch (error) {
    throw error?.code ? error : kernelFail(error);
  }
}

const PATCH_RUNS = 1 << 17, PATCH_BAND = 1 << 22;
export function capturePatchMarks(words, width, height, side, limit, least) {
  if (!prepareCaptureKernels()) return null;
  try {
    ready();
    const n = width * height, at = heldAt(words), band = at < 0 ? Math.max(1, Math.min(height, PATCH_BAND / (4 * width) | 0)) : height;
    const ink = base, above = ink + (n + 15 & ~15), stack = above + (width * 4 + 15 & ~15), boxes = stack + PATCH_RUNS * 12,
      rows = boxes + limit * 16, end = at < 0 ? rows + (band + 2) * width * 4 : rows;
    if (end > MEMORY_BYTES) return null;
    reserve(end);
    const buf = engine.memory.buffer;
    new Uint8Array(buf, ink, n).fill(0);
    new Int32Array(buf, above, width).fill(-1);
    if (at >= 0) engine.patchInk(at, width, height, 0, height, ink, above);
    else for (let y = 0; y < height; y += band) {
      const from = Math.max(0, y - 1), to = Math.min(height, y + band + 1);
      new Uint32Array(buf, rows, (to - from) * width).set(words.subarray(from * width, to * width));
      engine.patchInk(rows + (y - from) * width * 4, width, Math.min(band, height - y), y, height, ink + y * width, above);
    }
    const found = engine.patchMarks(ink, width, height, stack, PATCH_RUNS, boxes, limit, side, least);
    return found < 0 ? null : new Int32Array(buf, boxes, found * 4).slice();
  } catch { return null; }
}

const PEEL_MARKS = 1 << 18, PEEL_RUNS = 1 << 20;
export function capturePeelMarks(words, width, height, bg, side) {
  if (!prepareCaptureKernels()) return null;
  try {
    ready();
    const n = width * height, at = heldAt(words), band = at < 0 ? Math.max(1, Math.min(height, PATCH_BAND / (4 * width) | 0)) : height;
    const ink = base, stack = ink + (n + 15 & ~15), runs = stack + PATCH_RUNS * 12, marks = runs + PEEL_RUNS * 12,
      rows = marks + PEEL_MARKS * 24, end = at < 0 ? rows + band * width * 4 : rows;
    if (end > MEMORY_BYTES) return null;
    reserve(end);
    if (at >= 0) engine.peelInk(at, n, bg, ink);
    else for (let y = 0; y < height; y += band) {
      const to = Math.min(height, y + band);
      new Uint32Array(engine.memory.buffer, rows, (to - y) * width).set(words.subarray(y * width, to * width));
      engine.peelInk(rows, (to - y) * width, bg, ink + y * width);
    }
    const found = engine.peelMarks(ink, width, height, stack, PATCH_RUNS, runs, PEEL_RUNS, marks, PEEL_MARKS, side);
    if (found < 0) return null;
    const buf = engine.memory.buffer, list = new Int32Array(buf, marks, found * 6).slice();
    return {marks: list, runs: new Int32Array(buf, runs, found ? list[found * 6 - 1] : 0).slice()};
  } catch { return null; }
}

export function requireCaptureKernels() {
  if (!prepareCaptureKernels()) throw wasmRequired();
}

export function captureResiduals(plane, width, height, residuals, properties) {
  if (!captureWeighted(null, null, plane, width, height, 0, undefined, residuals, properties))
    throw kernelFail();
}

export function captureDenseTiles(words, stride, x, y, width, height) {
  if (!(words instanceof Uint32Array) || !Number.isInteger(stride) || !Number.isInteger(x) || !Number.isInteger(y) ||
      !Number.isInteger(width) || !Number.isInteger(height) || x < 0 || y < 0 || width < 1 || height < 1 ||
      width > 32767 || height > 32767 || x + width > stride || (y + height - 1) * stride + x + width > words.length)
    throw fault('JXL_INTERNAL', 'The dense tile scan was called outside its bounds.');
  requireCaptureKernels(); ready();
  const tx = Math.ceil(width / 16), mask = new Uint8Array(tx * Math.ceil(height / 16)), held = heldAt(words);
  const pixels = base, output = held >= 0 ? base : base + 17 * width * 4;
  reserve(output + tx);
  const buffer = engine.memory.buffer, data = new Uint32Array(buffer);
  for (let by = 0; by * 16 < height; by++) {
    const start = Math.max(0, by * 16 - 1), end = Math.min(height, (by + 1) * 16);
    if (held < 0) for (let row = start; row < end; row++)
      data.set(words.subarray((y + row) * stride + x, (y + row) * stride + x + width), (pixels >> 2) + (row - start) * width);
    engine.denseTiles(held >= 0 ? held + ((y + start) * stride + x) * 4 : pixels,
      held >= 0 ? stride : width, width, end - start, output);
    mask.set(new Uint8Array(buffer, output, tx), by * tx);
  }
  return mask;
}

export function captureMaskRuns(px, w, h) {
  if (typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true || typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true) return undefined;
  const n = w * h, words = base + 7 & ~7, mark = words + n * 4, pixels = mark + (n + 7 & ~7), runs = pixels + n * 4, out = runs + (n >> 1) * 12 + 12;
  if (out + 8 > MEMORY_BYTES || !prepareCaptureKernels()) return undefined;
  try {
    ready();
    reserve(out + 8);
    const buffer = engine.memory.buffer;
    new Int32Array(buffer, words, n).set(px);
    new Uint8Array(buffer, mark, n).fill(0);
    const count = engine.maskRuns(words, w, h, mark, pixels, runs, out);
    const list = new Int32Array(buffer.slice(runs, runs + count * 12)), last = count ? list[count * 3 - 3] + list[count * 3 - 2] : 0;
    return {pixels: new Int32Array(buffer.slice(pixels, pixels + last * 4)), runs: list, transparent: new Int32Array(buffer, out, 1)[0]};
  } catch { return undefined; }
}

export function captureSqueezeStep(data, w, h, horizontal) {
  if (typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true || typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true) return undefined;
  const n = horizontal ? w : h, low = (n + 1) >> 1, high = n - low, ow = horizontal ? low : w, oh = horizontal ? h : low, rw = horizontal ? high : w, rh = horizontal ? h : high;
  const p = base + 7 & ~7, out = p + (w * h * 2 + 7 & ~7), res = out + (ow * oh * 2 + 7 & ~7), end = res + rw * rh * 2;
  if (end > MEMORY_BYTES || !prepareCaptureKernels()) return undefined;
  try {
    ready();
    reserve(end);
    const buffer = engine.memory.buffer;
    new Int16Array(buffer, p, w * h).set(data.subarray(0, w * h));
    engine.squeezeStep(p, w, h, horizontal ? 1 : 0, out, res);
    return [new Int16Array(buffer.slice(out, out + ow * oh * 2)), new Int16Array(buffer.slice(res, res + rw * rh * 2))];
  } catch { return undefined; }
}

export function captureFillHoles(rgba, w, h, exact, count) {
  if (typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true || typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true) return false;
  const n = w * h, pixels = base + 7 & ~7, mask = pixels + n * 4, nearest = mask + (n + 7 & ~7), column = nearest + count * 16;
  if (column + w * 4 > MEMORY_BYTES || !prepareCaptureKernels()) return false;
  try {
    ready();
    reserve(column + w * 4);
    const buffer = engine.memory.buffer;
    new Uint8Array(buffer, pixels, n * 4).set(rgba.subarray(0, n * 4));
    new Uint8Array(buffer, mask, n).set(exact.subarray(0, n));
    engine.fillHoles(pixels, w, h, mask, nearest, column);
    rgba.set(new Uint8Array(buffer, pixels, n * 4));
    return true;
  } catch { return false; }
}


export const photoKernels = () => kernelHooks.capturePhoto ??
  (typeof __RAPIER_JXL_CAPTURE_PHOTO__ === 'undefined' || __RAPIER_JXL_CAPTURE_PHOTO__ === true ? PHOTO_KERNELS : null);
const R = 327680, TABLE = 1642496, OUTPUT = 1114128, ALPHABET = 257, RAW_BINS = 4096 + 33, PLAIN = {split: 0, msb: 0, lsb: 0};
let photo = null;
const photoOK = () => typeof WebAssembly === 'object' && new Uint8Array(new Uint32Array([1]).buffer)[0] === 1 && SIMD_OK();
function photoReady() {
  try {
    if (!photo) {
      if (!photoOK()) return 'off';
      const memory = new WebAssembly.Memory({initial: 48, maximum: 640});
      const simd = new WebAssembly.Instance(kernelModule(), {env: {memory}}).exports;
      photo = {memory, simd, u8: new Uint8Array(memory.buffer), i32: new Int32Array(memory.buffer)};
    }
  } catch { return 'off'; }
  kernelHooks.channel = channel; kernelHooks.dct = dct; kernelHooks.ycbcrTile = ycbcrTile; kernelHooks.rgbTiles = rgbTile; kernelHooks.photoTile = photoTile;
  return 'simd';
}
const PHOTO_KERNELS = {prepare: async () => photoOK() && compileKernels(), ready: photoReady,
  tokenGroup: captureTokenGroup, plane: capturePlane, opaque: captureOpaque, tokens: () => photo?.simd.tokCount ? TOKEN_KERNELS : null};
let tileTables = null, tileBand = null;

const acceptablePlane = (p, w, h, offset) => p instanceof Int16Array && Number.isInteger(w) && Number.isInteger(h) && w > 0 && h > 0 && w <= 16384 && w * h <= 65536 && p.length >= w * h && Number.isInteger(offset) && Math.abs(offset) <= 32768;
const acceptableWriter = w => !w || (w instanceof BitWriter && w.write === BitWriter.prototype.write && w.grow === BitWriter.prototype.grow);
const acceptableConfig = c => Number.isInteger(c.split) && Number.isInteger(c.msb) && Number.isInteger(c.lsb) && c.split >= 0 && c.split <= 15 && c.msb >= 0 && c.lsb >= 0 && c.msb + c.lsb <= c.split && (1 << c.split) + ((19 - c.split) << (c.msb + c.lsb)) <= 224;

function tokens(w, targets, count, contexts, config = PLAIN, rawLength = 0) {
  tileBand = null;
  const {simd, i32, u8} = photo, stride = rawLength || ALPHABET;
  if (!acceptableWriter(w) || !targets.length || targets.length > 34) return false;
  if (w) {
    i32.fill(0, TABLE >> 2, (TABLE >> 2) + targets.length * ALPHABET * 2);
    for (let c = 0; c < targets.length; c++) {
      const code = targets[c];
      if (!code?.lengths || !code?.codes || code.lengths.length > ALPHABET) return false;
      for (let s = 0; s < code.lengths.length; s++) {
        i32[(TABLE >> 2) + (c * ALPHABET + s) * 2] = code.lengths[s];
        i32[(TABLE >> 2) + (c * ALPHABET + s) * 2 + 1] = code.codes[s];
      }
    }
  } else {
    for (let c = 0; c < targets.length; c++) {
      if (!(targets[c] instanceof Uint32Array) || targets[c].length !== stride) return false;
      i32.set(targets[c], (TABLE >> 2) + c * stride);
    }
  }
  const written = simd.tokens(R, contexts, count, TABLE, OUTPUT, w ? 1 : 0, w ? w.acc : 0, w ? w.pending : 0, config.split, config.msb, config.lsb, rawLength);
  if (w) {
    if (w.at + written + 8 >= w.bytes.length) w.grow(written + 8);
    w.bytes.set(u8.subarray(OUTPUT, OUTPUT + written), w.at);
    w.at += written; w.acc = i32[(OUTPUT - 8) >> 2]; w.pending = i32[(OUTPUT - 4) >> 2];
  } else for (let c = 0; c < targets.length; c++) targets[c].set(i32.subarray((TABLE >> 2) + c * stride, (TABLE >> 2) + (c + 1) * stride));
  return true;
}
function quantiseHere(plane, n, offset, m, out, at) {
  if (typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true || typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true) return false;
  if (!prepareCaptureKernels()) return false;
  try {
    ready();
    const values = base + 7 & ~7, packed = values + (n * 2 + 7 & ~7);
    reserve(packed + n * 4);
    const buffer = engine.memory.buffer, held = new Int16Array(buffer, values, n);
    held.set(plane.subarray(0, n));
    engine.quantise(values, n, offset, m, packed);
    plane.set(held);
    out.set(new Int32Array(buffer, packed, n), at);
    return true;
  } catch { return false; }
}
function channel(w, target, plane, width, height, leaf, raw) {
  tileBand = null;
  const config = leaf.config || PLAIN, m = leaf.multiplier;
  const quantised = m !== 1 && leaf.predictor === 0 && Number.isInteger(m) && m > 1;
  if (!acceptablePlane(plane, width, height, leaf.offset) || m !== 1 && !quantised || !Number.isInteger(leaf.predictor) || leaf.predictor < 0 || leaf.predictor > 5 || !acceptableWriter(w) || !acceptableConfig(config)) return false;
  if (raw && (w || !(target instanceof Uint32Array) || target.length < 34 || target.length > RAW_BINS)) return false;
  const n = width * height;
  if (w && w.at + n * 8 + 32 > 0x7fffffff) return false;
  if (quantised) {
    const offset = leaf.offset, out = photo.i32, at = R >> 2;
    if (!quantiseHere(plane, n, offset, m, out, at))
      for (let i = 0; i < n; i++) { const r = Math.round((plane[i] - offset) / m); plane[i] = offset + r * m; out[at + i] = r << 1 ^ r >> 31; }
    return tokens(w, [target], n, 0, config, raw ? target.length : 0);
  }
  photo.i32.set(plane.subarray(0, n), P >> 2);
  photo.simd.residual(P, width, height, leaf.predictor, leaf.offset, R);
  return tokens(w, [target], n, 0, config, raw ? target.length : 0);
}

function dct(blocks, count, basis) {
  tileBand = null;
  if (!(blocks instanceof Float64Array) || !Number.isInteger(count) || count < 1 || count > 64 ||
      blocks.length < count * 192 || !(basis instanceof Float64Array) || basis.length !== 64) return false;
  const f64 = new Float64Array(photo.memory.buffer);
  f64.set(blocks.subarray(0, count * 192), P >> 3);
  photo.simd.dct(P, count, R, loadBasis(f64, basis), P + 64 * 192 * 8);
  blocks.set(f64.subarray(P >> 3, (P >> 3) + count * 192));
  return true;
}
function loadBasis(f64, basis) {
  const pair = R + 512;
  f64.set(basis, R >> 3);
  for (let u = 0; u < 8; u += 2) for (let x = 0; x < 8; x++) {
    f64[(pair >> 3) + u * 8 + x * 2] = basis[u * 8 + x];
    f64[(pair >> 3) + u * 8 + x * 2 + 1] = basis[(u + 1) * 8 + x];
  }
  return pair;
}

function ycbcrTile(data, width, rowAt, x0, count, tables, coeffs, offset, basis) {
  tileBand = null;
  const YT_SCRATCH = P + 98304, YT_SRC = YT_SCRATCH + 512, YT_OUT = YT_SRC + 16384, YT_TABLES = YT_OUT + 24576;
  const buffer = photo.memory.buffer, u8 = new Uint8Array(buffer), f64 = new Float64Array(buffer);
  const from = x0 * 32, inside = Math.min(count * 32, width * 4 - from), rowBytes = count * 32, planes = coeffs.length;
  for (let y = 0; y < 8; y++) {
    const at = rowAt[y] + from, row = YT_SRC + y * rowBytes;
    u8.set(data.subarray(at, at + inside), row);
    for (let x = inside; x < rowBytes; x += 4) u8.copyWithin(row + x, row + inside - 4, row + inside);
  }
  f64.set(tables, YT_TABLES >> 3);
  photo.simd.ycbcrTile(YT_SRC, rowBytes, count, P, R, loadBasis(f64, basis), YT_SCRATCH, YT_TABLES, YT_TABLES + 1536, YT_TABLES + 3072, planes, YT_OUT, 16);
  const levels = new Int16Array(buffer, YT_OUT, planes * count * 64);
  for (let c = 0; c < planes; c++) coeffs[c].set(levels.subarray(c * count * 64, (c + 1) * count * 64), offset);
  return true;
}

function rgbTile(data, width, height, bx0, by0, bw, bh, tableOf, cflOf, planes, stride, basis, quantScale) {
  tileBand = null;
  const SCRATCH = P + 98304, SRC = SCRATCH + 512, OUT = SRC + 16384, SUMS = OUT + 24576, TABS = SUMS + 32, TABLES = TABS + 256;
  if (!photo.simd.rgbTile || !(data instanceof Uint8Array || data instanceof Uint8ClampedArray) || !(bw >= 1 && bw <= 8 && bh >= 1 && bh <= 8)) return false;
  const buffer = photo.memory.buffer, u8 = new Uint8Array(buffer), f64 = new Float64Array(buffer), i32 = new Int32Array(buffer);
  const count = bw * bh, slots = new Map();
  for (let n = 0; n < count; n++) {
    const t = tableOf(by0 + (n / bw | 0), bx0 + n % bw);
    let at = slots.get(t);
    if (at === undefined) {
      at = TABLES + slots.size * 3072;
      if (at + 3072 > R || t.length !== 384) return false;
      f64.set(t, at >> 3); slots.set(t, at);
    }
    i32[(TABS >> 2) + n] = at;
  }
  const rowBytes = bw * 32, from = bx0 * 32, inside = Math.min(rowBytes, width * 4 - from);
  for (let y = 0; y < bh * 8; y++) {
    const at = Math.min(height - 1, by0 * 8 + y) * width * 4 + from, row = SRC + y * rowBytes;
    u8.set(data.subarray(at, at + inside), row);
    for (let x = inside; x < rowBytes; x += 4) u8.copyWithin(row + x, row + inside - 4, row + inside);
  }
  photo.simd.rgbTile(SRC, rowBytes, bw, bh, P, R, loadBasis(f64, basis), SCRATCH, TABS, OUT, quantScale, SUMS);
  const [ax, ab] = cflOf(f64[SUMS >> 3], f64[(SUMS >> 3) + 1], f64[(SUMS >> 3) + 2]);
  photo.simd.rgbQuant(P, count, TABS, ax, ab, OUT, quantScale);
  const levels = new Int16Array(buffer, OUT, 3 * count * 64);
  for (let c = 0; c < 3; c++) for (let y = 0; y < bh; y++)
    planes[c].set(levels.subarray((c * count + y * bw) * 64, (c * count + y * bw + bw) * 64), ((by0 + y) * stride + bx0) * 64);
  return true;
}

export const photoEngine = () => photoReady() === 'simd' ? {simd: photo.simd, memory: photo.memory, P, R, TK, limit: 640 * 65536, grow(end) {
  if (end > photo.memory.buffer.byteLength) photo.memory.grow(Math.ceil((end - photo.memory.buffer.byteLength) / 65536));
  photo.u8 = new Uint8Array(photo.memory.buffer); photo.i32 = new Int32Array(photo.memory.buffer);
}} : null;
export const tokenArenaEnd = contexts => tokenLayout(contexts).end;

const TK = 2097152, TK_TOKENS = 196608, TK_HISTOGRAMS = 128;
let tokenArena = null, tokenTables = null, tokenMemo = false;
const tokenViewsOwn = (...views) => views.every(v => v.buffer === photo.memory.buffer);
function tokenLayout(contexts) {
  const hist = TK, over = hist + contexts * 256, map = over + TK_TOKENS * 8, cfgs = map + 8192, freqs = cfgs + 4096, tabs = freqs + TK_HISTOGRAMS * 1024,
    lengths = tabs + TK_HISTOGRAMS * 9232, bits = lengths + TK_HISTOGRAMS * 64, codes = bits + TK_HISTOGRAMS * 256, words = codes + TK_HISTOGRAMS * 2048, raw = words + TK_TOKENS * 4, out = raw + TK_TOKENS * 8;
  const memo = out + TK_TOKENS * 6 + 64, end = memo + 65536 * 8;
  return {hist, over, map, cfgs, freqs, tabs, lengths, bits, codes, words, raw, out, memo, end};
}
const TOKEN_KERNELS = {
  begin(contexts) {
    const {hist, over, map, cfgs, freqs, tabs, lengths, bits, codes, words, raw, out, memo, end} = tokenLayout(contexts);
    if (end > photo.memory.buffer.byteLength) {
      try { photo.memory.grow(Math.ceil((end - photo.memory.buffer.byteLength) / 65536)); } catch { return false; }
      photo.u8 = new Uint8Array(photo.memory.buffer); photo.i32 = new Int32Array(photo.memory.buffer);
    }
    if (!tokenMemo) { new Float64Array(photo.memory.buffer, memo, 65536).fill(0); tokenMemo = true; }
    tokenArena = {contexts, hist, over, map, cfgs, freqs, tabs, lengths, bits, codes, words, raw, out, memo};
    new Uint32Array(photo.memory.buffer, hist, contexts * 64).fill(0);
    return true;
  },
  count({ctxs, values, n}, totals, large) {
    const a = tokenArena;
    if (!a || n > TK_TOKENS || !tokenViewsOwn(ctxs, values)) return false;
    const k = photo.simd.tokCount(values.byteOffset, ctxs.byteOffset, n, a.contexts, a.hist, a.over);
    if (k < 0) return false;
    const pairs = new Uint32Array(photo.memory.buffer, a.over, 2 * k);
    for (let j = 0; j < 2 * k; j += 2) {
      const ctx = pairs[j], value = pairs[j + 1], map = large[ctx] || (large[ctx] = new Map());
      totals[ctx]++; map.set(value, (map.get(value) || 0) + 1);
    }
    return true;
  },
  end(small, totals) {
    const a = tokenArena, hist = new Uint32Array(photo.memory.buffer, a.hist, a.contexts * 64);
    for (let ctx = 0, i = 0; ctx < a.contexts; ctx++) {
      let sum = 0;
      for (let v = 0; v < 64; v++, i++) { const c = hist[i]; if (c) { small[i] += c; sum += c; } }
      totals[ctx] += sum;
    }
  },
  clusters(count, fill, split, most) {
    const a = tokenArena;
    if (!a || count * 512 > TK_TOKENS * 8 || count > 16384 || !(most >= 1 && most <= TK_HISTOGRAMS)) return null;
    const buffer = photo.memory.buffer, owns = new Uint32Array(buffer, a.over, count * 128).fill(0);
    const ends = new Int32Array(buffer, a.words, count), totals = new Uint32Array(buffer, a.raw, count);
    fill(owns, ends, totals);
    const made = photo.simd.tokClusters(a.over, a.words, a.raw, count, a.tabs, a.memo, a.codes, split, most);
    tokenTables = null;
    return {count: made, of: new Int32Array(buffer, a.codes, count).slice()};
  },
  tables(coding, contextMap, configs, prefix = null) {
    const a = tokenArena;
    if (!a || configs.length > TK_HISTOGRAMS || contextMap.length > 8192) return false;
    if (tokenTables === coding) return true;
    const buffer = photo.memory.buffer, u8 = new Uint8Array(buffer), i32 = new Int32Array(buffer);
    u8.set(contextMap, a.map);
    configs.forEach((c, h) => i32.set([c.splitToken, c.split, c.msb, c.lsb], (a.cfgs >> 2) + 4 * h));
    if (prefix) {
      new Int8Array(buffer, a.lengths, prefix.lengths.length).set(prefix.lengths);
      new Uint32Array(buffer, a.bits, prefix.bits.length).set(prefix.bits);
      const codes = new Int32Array(buffer, a.codes, configs.length * 512).fill(-1);
      prefix.histograms.forEach(({code, freqs}, h) => {
        for (let s = 0; s < code.lengths.length && s < 256; s++) if (freqs[s]) { codes[(h * 256 + s) * 2] = code.lengths[s]; codes[(h * 256 + s) * 2 + 1] = code.codes[s]; }
      });
    }
    if (coding.shapes) coding.shapes.forEach((shape, h) => {
      const at = a.tabs + h * 9232;
      new Uint16Array(buffer, at, 256).fill(0).set(shape.counts.subarray ? shape.counts.subarray(0, 256) : shape.counts.slice(0, 256));
      new Uint16Array(buffer, at + 512, shape.starts.length).set(shape.starts);
      new Uint16Array(buffer, at + 1040, 4096).set(shape.reverse);
    });
    tokenTables = coding;
    return true;
  },
  freqs({ctxs, values, n}, freqs) {
    const a = tokenArena;
    if (!a || n > TK_TOKENS || !tokenViewsOwn(ctxs, values)) return null;
    const counts = new Uint32Array(photo.memory.buffer, a.freqs, freqs.length * 256).fill(0);
    const largest = photo.simd.tokFreqs(values.byteOffset, ctxs.byteOffset, n, a.map, a.cfgs, a.freqs);
    if (largest === -2) return null;
    if (largest >= 0) freqs.forEach((f, h) => { const from = counts.subarray(h * 256, h * 256 + 256); for (let s = 0; s < 256; s++) f[s] += from[s]; });
    return largest;
  },
  write(w, {ctxs, values, n}, ans) {
    const a = tokenArena;
    if (!a || n > TK_TOKENS || !tokenViewsOwn(ctxs, values)) return false;
    const bits = ans ? photo.simd.tokAns(values.byteOffset, ctxs.byteOffset, n, a.map, a.cfgs, a.tabs, a.words, a.raw, a.out)
      : photo.simd.tokPrefix(values.byteOffset, ctxs.byteOffset, n, a.map, a.cfgs, a.lengths, a.bits, a.codes, a.out);
    if (bits < 0) return false;
    const at = bits >> 3, bytes = new Uint8Array(photo.memory.buffer, a.out, at + 1);
    w.append({bytes, at, pending: bits & 7, acc: bits & 7 ? bytes[at] & ((1 << (bits & 7)) - 1) : 0});
    return true;
  },
};

const TILE_ROOTS = 20816, TILE_LINEAR = 53728, TILE_SCALE = 55776, TILE_STEPS = 56288, TILE_LIMITS = 57824, TILE_BAND = 262144;
function photoTile(data, width, height, bx0, by0, bw, bh, tables, cfl, components, stride, nonZero) {
  const TILE_F64 = P + 16384, TILE_SUMS = P + 150160, TILE_OUT = P + 153256, TILE_COUNTS = P + 177832;
  if (!(data instanceof Uint8Array || data instanceof Uint8ClampedArray) || !Number.isInteger(bw) || !Number.isInteger(bh) ||
      bw < 1 || bw > 8 || bh < 1 || bh > 8 || tables.roots.length !== 4113 || tables.linear.length !== 256) return false;
  const padded = stride * 32, end = TILE_BAND + 64 * padded;
  tokenTables = null; tokenMemo = false;
  if (end > photo.memory.buffer.byteLength) {
    try { photo.memory.grow(Math.ceil((end - photo.memory.buffer.byteLength) / 65536)); } catch { return false; }
    photo.u8 = new Uint8Array(photo.memory.buffer); photo.i32 = new Int32Array(photo.memory.buffer);
  }
  if (tileBand?.tables !== tables || tileBand.by0 !== by0) {
    const u8 = new Uint8Array(photo.memory.buffer), rowWidth = width * 4, padWidth = (stride * 8 - width) * 4;
    for (let y = 0; y < bh * 8; y++) {
      const at = Math.min(height - 1, by0 * 8 + y) * rowWidth, row = TILE_BAND + y * padded;
      u8.set(data.subarray(at, at + rowWidth), row);
      if (padWidth > 0) {
        const lastPixel = data[at + rowWidth - 4] | (data[at + rowWidth - 3] << 8) | (data[at + rowWidth - 2] << 16) | (data[at + rowWidth - 1] << 24);
        photo.i32.fill(lastPixel, (row + rowWidth) >> 2, (row + rowWidth + padWidth) >> 2);
      }
    }
    tileBand = {tables, by0};
  }
  const u8 = new Uint8Array(photo.memory.buffer), f64 = new Float64Array(photo.memory.buffer), count = bw * bh;
  if (tileTables !== tables) {
    f64.set(tables.roots, TILE_ROOTS >> 3); f64.set(tables.linear, TILE_LINEAR >> 3); f64.set(tables.scale, TILE_SCALE >> 3);
    for (let c = 0; c < 3; c++) { f64.set(tables.steps[c], (TILE_STEPS >> 3) + c * 64); f64.set(tables.limits[c], (TILE_LIMITS >> 3) + c * 64); }
    tileTables = tables;
  }
  photo.simd.xybTile(TILE_BAND + bx0 * 32, padded, bw, bh, TILE_F64, TILE_ROOTS, TILE_LINEAR, TILE_SCALE, tables.bias, tables.rootBias, TILE_SUMS);
  const [fx, fb] = cfl(f64[(TILE_SUMS >> 3) + 1], f64[TILE_SUMS >> 3], f64[(TILE_SUMS >> 3) + 2]);
  photo.simd.quantTile(TILE_F64, count, TILE_STEPS, TILE_LIMITS, fx / 84, fb / 84, TILE_OUT, TILE_COUNTS);
  const levels = new Int16Array(photo.memory.buffer, TILE_OUT, 3 * count * 64);
  for (let c = 0; c < 3; c++) {
    const out = components[c].coeffs, counts = nonZero[c];
    for (let y = 0; y < bh; y++) {
      const from = c * count + y * bw, block = (by0 + y) * stride + bx0;
      out.set(levels.subarray(from * 64, (from + bw) * 64), block * 64);
      counts.set(u8.subarray(TILE_COUNTS + from, TILE_COUNTS + from + bw), block);
    }
  }
  return true;
}

function captureTokenGroup(comps, width, height, group, density, order, ac = null) {
  if (!photo) throw fault('JXL_WASM', 'Photographic capture needs its SIMD kernels.');
  const groupsX = Math.ceil(width / 256), bx = group % groupsX * 32, by = Math.floor(group / groupsX) * 32;
  const bw = Math.min(32, Math.ceil(width / 8) - bx), bh = Math.min(32, Math.ceil(height / 8) - by);
  if (bw < 1 || bh < 1 || comps.length !== 3 || comps.some(c => !(c.coeffs instanceof Int16Array) || c.stride < bx + bw || c.coeffs.length < ((by + bh - 1) * c.stride + bx + bw) * 64))
    throw fault('JXL_INPUT', 'Photo capture needs three signed16 DCT8 planes.');
  tileBand = null;
  const args = P, coeff = P + 128, counts = coeff + 393216, buckets = counts + 3072, contexts = buckets + 1024;
  const orders = contexts + 64, zd = orders + 192, nz = zd + 8192, values = nz + 12288, ids = values + 786432;
  const buffer = photo.memory.buffer, u8 = new Uint8Array(buffer), i16 = new Int16Array(buffer), u16 = new Uint16Array(buffer), i32 = new Int32Array(buffer);
  for (let c = 0; c < 3; c++) {
    const {coeffs, stride} = comps[c], at = coeff + c * 131072;
    for (let y = 0; y < bh; y++) i16.set(coeffs.subarray(((by + y) * stride + bx) * 64, ((by + y) * stride + bx + bw) * 64), (at >> 1) + y * bw * 64);
    photo.simd.captureSelect(at, counts + c * bw * bh, bw * bh, 128, 3);
    u8.set(order, orders + c * 64);
  }
  u8.fill(0, buckets, buckets + 1024); u16.set(density, zd >> 1);
  if (ac && ac.K > 1) {
    const {coeffs, stride} = comps[1];
    for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) u8[buckets + y * bw + x] = ac.bucket(coeffs[((by + y) * stride + bx + x) * 64]);
    i32.set(ac.table, contexts >> 2);
  } else i32.set([1, 0, 2], contexts >> 2);
  i32.set([coeff, 131072, bw, bh, counts, buckets, contexts, ac ? ac.K : 1, ac ? ac.numCtxs : 3, orders, zd, nz, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, values, ids, 0], args >> 2);
  photo.simd.acGroup(args);
  const n = i32[(args >> 2) + 28];
  return {n, values: new Uint32Array(buffer, values, n), ctxs: new Uint16Array(buffer, ids, n)};
}

function captureOpaque(data, width, x, y, w, h) {
  if (!photo) throw fault('JXL_WASM', 'Photographic capture needs its SIMD kernels.');
  tileBand = null;
  for (let row = y; row < y + h; row++) {
    const at = (row * width + x) * 4;
    photo.u8.set(data.subarray(at, at + w * 4), P);
    if (!photo.simd.opaque(P, w * 4)) return false;
  }
  return true;
}

function capturePlane(data, sourceWidth, x, y, width, height, step = 1, offset = 0) {
  if (!photo) throw fault('JXL_WASM', 'Photographic capture needs its SIMD kernels.');
  const type = data instanceof Int16Array ? 1 : data instanceof Int8Array ? 2 : data instanceof Uint8Array || data instanceof Uint8ClampedArray ? 0 : -1;
  if (type < 0 || width < 1 || height < 1 || width > 256 || height > 256 || !Number.isInteger(step) || step < 1 || step > 64 || x < 0 || y < 0 || x + width > sourceWidth || ((y + height - 1) * sourceWidth + x + width - 1) * step + offset >= data.length)
    throw fault('JXL_INPUT', 'Photographic capture plane is outside its owned sample rows.');
  tileBand = null;
  const raw = new Uint8Array(data.buffer, data.byteOffset, data.byteLength), unit = data.BYTES_PER_ELEMENT, output = new Int16Array(width * height);
  const u8 = new Uint8Array(photo.memory.buffer), out = P + 65536, i16 = new Int16Array(photo.memory.buffer);
  for (let row = 0; row < height; row++) {
    const at = ((y + row) * sourceWidth + x) * step * unit, end = at + ((width - 1) * step + offset + 1) * unit;
    u8.set(raw.subarray(at, end), P);
    photo.simd.captureSelect(P + offset * unit, out, width, step * unit, type);
    output.set(i16.subarray(out >> 1, (out >> 1) + width), row * width);
  }
  return output;
}
